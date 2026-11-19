import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ProviderInput, ProjectSnapshot } from '../../packages/contracts/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { assertPlainPath, guardPath } from '../../packages/executor/src/path-guard';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import { validateEndpoint } from '../../packages/runtime/src/provider';
import { checkContext, checkDeliverables, fileHashes, sha256 } from './checks';
import { saveReport } from './report';
import {
  scenarioSchema,
  type AcceptanceScenario,
  type AcceptanceReport,
  type AcceptanceStatus,
  type StageReport,
} from './schema';

export interface AcceptanceOptions {
  scenario: AcceptanceScenario;
  outputRoot: string;
  projectRoot: string;
  provider: (ProviderInput & { apiKey: string }) | null;
  mode?: 'live' | 'scripted';
  allowProcess?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxSteps?: number;
  pythonPath?: string;
  nodePath?: string;
  runnerSha256?: string;
}
class StopRun extends Error {
  constructor(
    public status: AcceptanceStatus,
    message: string,
  ) {
    super(message);
  }
}
function stopped(snapshot: ProjectSnapshot): StopRun | undefined {
  if (snapshot.requests.some((r) => r.status === 'open'))
    return new StopRun(
      'blocked',
      'User input or approval is required; no request was answered automatically',
    );
  if (snapshot.commission.status === 'failed')
    return new StopRun('failed', snapshot.commission.summary);
  if (snapshot.commission.status === 'paused')
    return new StopRun('blocked', snapshot.commission.summary);
  if (snapshot.commission.status === 'cancelled')
    return new StopRun('cancelled', 'Commission cancelled');
  return undefined;
}
export async function runAcceptanceScenario(options: AcceptanceOptions): Promise<AcceptanceReport> {
  const scenario = scenarioSchema.parse(options.scenario);
  const timeoutMs = options.timeoutMs ?? 300000;
  const maxSteps = options.maxSteps ?? 40;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 1800000 ||
    !Number.isInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > 200
  )
    throw new Error('Invalid acceptance budget');
  const outputRoot = resolve(options.outputRoot);
  await assertPlainPath(outputRoot, true);
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(join(outputRoot, `${scenario.id}-`));
  const { provider } = options;
  const report: AcceptanceReport = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    title: scenario.title,
    mode: options.mode ?? 'live',
    directory,
    startedAt: new Date().toISOString(),
    runnerSha256: options.runnerSha256,
    status: 'not_run',
    reason: 'Preflight',
    provider: provider
      ? { kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model }
      : null,
    inputHashes: {},
    stages: [],
    interventions: 0,
    limits: { maxSteps, maxMinutes: 5, maxRework: 2, timeoutMs },
    limitations: [
      'This is a bounded acceptance sample, not full v0.1 certification.',
      'Office application opening, layout and formula-engine recalculation are not verified.',
      ...(options.mode === 'scripted'
        ? ['Scripted HTTP fixture; no real model capability claim.']
        : []),
    ],
  };
  let runtime: RuntimeService | undefined;
  let stage: StageReport | undefined;
  let commissionId: string | undefined;
  const executor = createExecutor({
    projectRoot: options.projectRoot,
    pythonPath: options.pythonPath,
  });
  const source = join(directory, 'source');
  try {
    if (!provider?.model.trim()) throw new StopRun('not_run', 'Provider is not configured');
    const endpoint = validateEndpoint(provider.baseUrl);
    if (!provider.apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
      throw new StopRun('not_run', 'Provider key is missing');
    const capabilities = await executor.capabilities();
    const needsNode = scenario.stages.some((s) => s.checks.some((c) => c.kind === 'node'));
    if (
      (needsNode || options.allowProcess) &&
      !capabilities.some((c) => c.id === 'process' && c.available)
    )
      throw new StopRun('not_run', 'Process supervisor is unavailable');
    if (
      needsNode &&
      !(await stat(options.nodePath ?? process.execPath).then(
        (value) => value.isFile(),
        () => false,
      ))
    )
      throw new StopRun('not_run', 'Node executable is unavailable');
    if (
      scenario.stages.some((s) => s.checks.some((c) => c.kind === 'node')) &&
      !options.allowProcess
    )
      throw new StopRun(
        'not_run',
        'Code scenarios require --allow-process for trusted host execution',
      );
    if (
      scenario.stages.some((s) =>
        s.checks.some((c) => c.kind === 'delivery' || c.kind === 'office'),
      )
    ) {
      const capability = capabilities.find((c) => c.id === 'source_publishing');
      if (!capability?.available) throw new StopRun('not_run', 'Source publishing is unavailable');
    }
    if (options.signal?.aborted) throw new StopRun('cancelled', 'Cancelled before starting');
    await mkdir(source);
    const context = checkContext(source, options.signal ?? new AbortController().signal);
    context.scope.writeRoots = [source];
    for (const [path, text] of Object.entries(scenario.seed)) {
      const destination = await guardPath(path, context, true);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, text, { flag: 'wx' });
    }
    report.inputHashes = await fileHashes(source);
    runtime = createRuntime({
      dataRoot: join(directory, 'runtime'),
      executor,
      getCredentials: async () => provider,
    });
    const workspace = await runtime.createWorkspace({
      name: scenario.title,
      ...(Object.keys(report.inputHashes).length ? { sourcePath: source } : {}),
    });
    for (const [index, specification] of scenario.stages.entries()) {
      stage = { goal: specification.goal, status: 'not_run', checks: [] };
      report.stages.push(stage);
      const deadline = Date.now() + timeoutMs;
      const response = await runtime.submit({
        requestId: randomUUID(),
        workspaceId: workspace.id,
        goal: specification.goal,
        criteria: specification.criteria,
        planningMode: 'auto',
        budget: { maxSteps, maxMinutes: 5, maxRework: 2 },
        scope: {
          readRoots: [],
          writeRoots: [],
          allowProcess: options.allowProcess ?? false,
          allowNetwork: false,
          allowedHosts: [],
        },
      });
      if (!response.ok || !response.commissionId) throw new StopRun('failed', response.message);
      commissionId = response.commissionId;
      for (;;) {
        if (options.signal?.aborted) throw new StopRun('cancelled', 'Cancelled by caller');
        if (Date.now() >= deadline)
          throw new StopRun('blocked', 'Wall-clock timeout; runtime paused');
        stage.snapshot = await runtime.snapshot(commissionId);
        const stop = stopped(stage.snapshot);
        if (stop) throw stop;
        if (stage.snapshot.commission.status === 'awaiting_acceptance') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const exportRoot = join(directory, `export-${index + 1}`);
      const exported = await runtime.exportWorkspace(commissionId, exportRoot);
      if (!exported.ok) throw new StopRun('failed', exported.message);
      const before = await fileHashes(exportRoot);
      const artifacts = stage.snapshot.artifacts.filter((a) => a.validity === 'current');
      if (!artifacts.length) throw new StopRun('failed', 'No current artifacts');
      for (const artifact of artifacts) {
        const bytes = await readFile(await runtime.resolveArtifactPath(artifact.id));
        if (sha256(bytes) !== artifact.sha256 || before[artifact.relativePath] !== artifact.sha256)
          throw new StopRun('failed', 'Export does not match current immutable artifact');
      }
      const signal = AbortSignal.any([
        options.signal ?? new AbortController().signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ]);
      stage.checks = await checkDeliverables({
        checks: specification.checks,
        root: exportRoot,
        projectRoot: options.projectRoot,
        executor,
        allowProcess: options.allowProcess ?? false,
        signal,
        nodePath: options.nodePath,
      });
      if (options.signal?.aborted)
        throw new StopRun('cancelled', 'Cancelled during independent checks');
      stage.exportHashes = await fileHashes(exportRoot);
      stage.checks.push({
        name: 'export-integrity',
        status: isDeepStrictEqual(before, stage.exportHashes) ? 'passed' : 'failed',
        detail: 'Export files must not change while independent checks run',
      });
      stage.checks.push({
        name: 'source-integrity',
        status: isDeepStrictEqual(report.inputHashes, await fileHashes(source))
          ? 'passed'
          : 'failed',
        detail: 'Original synthetic input must remain unchanged',
      });
      if (stage.checks.some((c) => c.status === 'failed'))
        throw new StopRun('failed', 'Independent deliverable verification failed');
      const accepted = await runtime.accept(
        commissionId,
        artifacts.map((a) => a.id),
      );
      if (!accepted.ok) throw new StopRun('failed', accepted.message);
      stage.snapshot = await runtime.snapshot(commissionId);
      if (stage.snapshot.commission.status !== 'accepted')
        throw new StopRun('failed', 'Runtime did not confirm full acceptance');
      stage.status = 'passed';
    }
    report.status = 'passed';
    report.reason = 'All scenario stages independently checked, accepted and exported';
  } catch (error) {
    report.status = error instanceof StopRun ? error.status : 'failed';
    report.reason = error instanceof Error ? error.message : 'Acceptance failed';
    if (stage) stage.status = report.status;
  } finally {
    if (runtime) {
      try {
        if (commissionId && stage) {
          if (stage.status !== 'passed') await runtime.control(commissionId, 'pause');
          stage.snapshot = await runtime.snapshot(commissionId);
        }
      } catch {
        report.status = 'failed';
        report.reason = 'Could not capture final runtime state';
      }
      try {
        await runtime.close();
      } catch {
        report.status = 'failed';
        report.reason = 'Runtime shutdown failed';
      }
    }
    report.interventions = report.stages.reduce(
      (sum, item) => sum + (item.snapshot?.requests.filter((r) => r.status === 'open').length ?? 0),
      0,
    );
    report.finishedAt = new Date().toISOString();
  }
  return saveReport(report, provider?.apiKey ?? '');
}
