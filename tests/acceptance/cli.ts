import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createExecutor } from '../../packages/executor/src/index';
import { parseAcceptanceArgs, providerFromEnvironment, readSecretInput } from './config';
import { runAcceptanceScenario } from './runner';
import { sanitize } from './report';
import { scenarioSchema } from './schema';
import { scenarios } from './scenarios';
import { sha256 } from './checks';

export async function main(args = process.argv.slice(2)): Promise<number> {
  let secret = process.env.ASTRISLE_PROVIDER_API_KEY ?? '';
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const options = parseAcceptanceArgs(args);
    if (options.list) {
      console.log(
        JSON.stringify(
          scenarios.map(({ id, title, stages }) => ({ id, title, stages: stages.length })),
          null,
          2,
        ),
      );
      return 0;
    }
    const requested = options.scenario === 'office' ? 'source-publishing' : options.scenario;
    let selected = requested === 'all' ? scenarios : scenarios.filter((s) => s.id === requested);
    if (options.scenarioFile) {
      if ((await stat(options.scenarioFile)).size > 1024 * 1024)
        throw new Error('Scenario JSON exceeds 1 MiB');
      selected = [scenarioSchema.parse(JSON.parse(await readFile(options.scenarioFile, 'utf8')))];
    }
    if (!selected.length) throw new Error('Unknown scenario; use --list');
    if (options.keyStdin) secret = await readSecretInput();
    const provider = providerFromEnvironment({
      ...process.env,
      ASTRISLE_PROVIDER_API_KEY: secret || undefined,
    });
    // Never inherit the credential into worker/process environments.
    delete process.env.ASTRISLE_PROVIDER_API_KEY;
    if (options.check) {
      const capabilities = await createExecutor({ projectRoot: process.cwd() }).capabilities();
      const requiresPublishing = selected.some((s) =>
        s.stages.some((t) => t.checks.some((c) => c.kind === 'delivery' || c.kind === 'office')),
      );
      const requiresProcess = selected.some((s) =>
        s.stages.some((t) => t.checks.some((c) => c.kind === 'node')),
      );
      const configured =
        !!provider &&
        (!!provider.apiKey ||
          ['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider.baseUrl).hostname));
      const ready =
        configured &&
        (!requiresPublishing ||
          capabilities.some((c) => c.id === 'source_publishing' && c.available)) &&
        (!(requiresProcess || options.allowProcess) ||
          capabilities.some((c) => c.id === 'process' && c.available)) &&
        (!requiresProcess || options.allowProcess);
      console.log(
        JSON.stringify({
          status: ready ? 'ready' : 'not_run',
          providerConfigured: configured,
          requiresPublishing,
          requiresProcess,
          processAuthorized: options.allowProcess,
          processAvailable: capabilities.some((c) => c.id === 'process' && c.available),
          scenarios: selected.map((s) => s.id),
          note: 'Preflight only; no model calls or task acceptance performed',
        }),
      );
      return ready ? 0 : 2;
    }
    let exitCode = 0;
    const runnerSha256 = sha256(await readFile(process.argv[1]));
    for (let repeat = 1; repeat <= options.repeat; repeat++) {
      for (const scenario of selected) {
        if (controller.signal.aborted) return 130;
        console.log(JSON.stringify({ event: 'starting', scenario: scenario.id, repeat }));
        const report = await runAcceptanceScenario({
          scenario,
          provider,
          mode: 'live',
          outputRoot: resolve(options.output),
          projectRoot: process.cwd(),
          allowProcess: options.allowProcess,
          maxSteps: options.maxSteps,
          timeoutMs: options.timeoutMs,
          signal: controller.signal,
          runnerSha256,
        });
        console.log(
          JSON.stringify({
            event: 'finished',
            scenario: report.scenarioId,
            repeat,
            status: report.status,
            reason: report.reason,
            report: resolve(report.directory, 'report.json'),
          }),
        );
        if (report.status !== 'passed')
          exitCode =
            report.status === 'cancelled'
              ? 130
              : report.status === 'not_run' && exitCode !== 1
                ? 2
                : 1;
      }
    }
    return exitCode;
  } catch (error) {
    console.error(sanitize(error instanceof Error ? error.message : 'Acceptance failed', secret));
    return 2;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
void main().then((code) => {
  process.exitCode = code;
});
