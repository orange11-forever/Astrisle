/** A scripted loopback HTTP provider tests protocol and runtime state. It is not real-model validation. */
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import type { ProjectSnapshot, ToolExecutor } from '../../packages/contracts/src/index';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const call = (name: string, args: unknown) => ({
  id: `${name}-${Math.random()}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
async function fixture(
  mode: 'normal' | 'rework' | 'weak' | 'mutate' | 'forge' | 'process' | 'extra' = 'normal',
  overrides: {
    executor?: ToolExecutor;
    maxSteps?: number;
    maxRework?: number;
    beforeReviewSubmit?: () => Promise<void>;
    seed?: Record<string, string>;
  } = {},
) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body),
      messages = request.messages;
    const first = JSON.parse(messages.find((m: any) => m.role === 'user').content);
    let calls: any[];
    if (!first.task)
      calls = [
        call('propose_plan', {
          tasks: [
            {
              key: 'author',
              title: 'Create real file',
              description: 'Write result.txt and publish it',
              kind: 'implement',
              agentId: 'mori',
              dependencies: [],
              criterionIds: ['c1'],
            },
            {
              key: 'review',
              title: 'Read and verify',
              description: 'Read exact published input and check content',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['author'],
              dependencyKinds: { author: 'artifact_available' },
              criterionIds: ['c1'],
            },
          ],
        }),
      ];
    else if (first.task.kind !== 'review') {
      if (['mutate', 'extra'].includes(mode) && messages.some((m: any) => m.role === 'tool')) {
        calls = [
          call('ask_input', {
            title: 'Published copy differs',
            detail: 'Need to republish changed bytes',
            kind: 'input',
          }),
        ];
      } else {
        const content =
          mode === 'rework' && !first.task.title.startsWith('Rework:')
            ? 'incorrect'
            : 'verified result';
        calls = [
          call('workspace_write', { path: 'result.txt', content }),
          call('submit_artifact', { path: 'result.txt', name: 'Result', mediaType: 'text/plain' }),
          call('complete_task', { summary: 'Real file published' }),
        ];
        if (mode === 'mutate')
          calls.splice(
            2,
            0,
            call('workspace_write', { path: 'result.txt', content: 'unpublished later mutation' }),
          );
        if (mode === 'extra')
          calls.splice(
            2,
            0,
            call('workspace_write', { path: 'extra.ts', content: 'unpublished extra change' }),
          );
      }
    } else {
      const returned = messages
        .filter((m: any) => m.role === 'tool')
        .map((m: any) => JSON.parse(m.content));
      const tool = returned.find((r: any) => r.evidenceId);
      if (!tool)
        calls =
          mode === 'forge'
            ? [
                call('workspace_write', { path: 'result.txt', content: 'forged review bytes' }),
                call('workspace_read', { path: 'result.txt' }),
              ]
            : [
                mode === 'weak'
                  ? call('workspace_list', {})
                  : mode === 'process'
                    ? call('process_run', {
                        command: process.execPath,
                        args: ['-e', 'process.exit(0)'],
                      })
                    : call('workspace_read', { path: 'result.txt' }),
              ];
      else {
        await overrides.beforeReviewSubmit?.();
        calls = [
          call('submit_review', {
            verdict: tool.output === 'incorrect' ? 'changes_requested' : 'pass',
            summary:
              tool.output === 'incorrect'
                ? 'Content is incorrect; change to verified result'
                : 'Read actual pinned file',
            evidenceIds: [tool.evidenceId],
            versionIds: first.inputs.map((a: any) => a.versionId),
          }),
        ];
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-execution-')));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  const port = (server.address() as { port: number }).port;
  const runtime = createRuntime({
    dataRoot,
    executor: overrides.executor ?? createExecutor({ projectRoot: process.cwd() }),
    getCredentials: async () => ({
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'scripted-fixture-not-real-model',
      apiKey: 'test-only-secret',
    }),
  });
  cleanup.push(() => runtime.close());
  const workspace = await runtime.createWorkspace({ name: 'Execution fixture' });
  for (const [path, content] of Object.entries(overrides.seed ?? {}))
    await writeFile(join(workspace.workPath, path), content);
  const response = await runtime.submit({
    requestId: 'run',
    workspaceId: workspace.id,
    goal: 'Create a real file',
    criteria: ['result.txt contains verified result'],
    planningMode: 'auto',
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: mode === 'process',
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: {
      maxSteps: overrides.maxSteps ?? 30,
      maxMinutes: 1,
      maxRework: overrides.maxRework ?? 3,
    },
  });
  return { runtime, workspace, id: response.commissionId!, dataRoot };
}
async function until(
  runtime: RuntimeService,
  id: string,
  predicate: (s: ProjectSnapshot) => boolean,
) {
  const end = Date.now() + 6000;
  let snapshot = await runtime.snapshot(id);
  while (!predicate(snapshot) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    snapshot = await runtime.snapshot(id);
  }
  expect(
    predicate(snapshot),
    JSON.stringify({
      commission: snapshot.commission,
      tasks: snapshot.tasks,
      events: snapshot.events.slice(-8),
    }),
  ).toBe(true);
  return snapshot;
}
it('delivers verified results when the final review consumes the exact last model step', async () => {
  const { runtime, id } = await fixture('normal', { maxSteps: 4 });
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(snapshot.commission.stepsUsed).toBe(4);
  expect(snapshot.tasks.every((t) => t.status === 'passed')).toBe(true);
});

it('delivers verified results when active time expires while the reserved final review responds', async () => {
  const start = Date.now();
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => start + offset);
  const { runtime, id } = await fixture('normal', {
    beforeReviewSubmit: async () => {
      offset = 60001;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    },
  });
  await vi.waitFor(
    async () => expect((await runtime.snapshot(id)).commission.status).toBe('awaiting_acceptance'),
    { timeout: 5000 },
  );
  expect((await runtime.snapshot(id)).tasks.every((t) => t.status === 'passed')).toBe(true);
});

it('continues a review blocked by the rework cap after the user raises that cap', async () => {
  const { runtime, id } = await fixture('rework', { maxRework: 0 });
  const paused = await until(
    runtime,
    id,
    (s) =>
      s.commission.status === 'paused' &&
      s.tasks.some((t) => t.kind === 'review' && t.status === 'failed'),
  );
  await vi.waitFor(async () =>
    expect(
      await runtime.updateBudget(id, { ...paused.commission.budget, maxRework: 2 }, 0),
    ).toMatchObject({ ok: true }),
  );
  expect((await runtime.control(id, 'resume')).ok).toBe(true);
  const finished = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(finished.events.some((e) => e.type === 'rework_created')).toBe(true);
  expect(finished.evidence.some((e) => e.kind === 'review' && e.status === 'failed')).toBe(true);
});

it('executes real file tools, unblocks artifact review before author pass, verifies immutable bytes, and accepts delivery', async () => {
  const { runtime, id, workspace } = await fixture();
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(await readFile(join(workspace.workPath, 'result.txt'), 'utf8')).toBe('verified result');
  const artifact = snapshot.artifacts.find((a) => a.validity === 'current')!;
  expect((await runtime.artifact(artifact.id)).content).toBe('verified result');
  expect(
    snapshot.evidence.some(
      (e) =>
        e.kind === 'review' &&
        e.status === 'passed' &&
        e.artifactVersionIds.includes(artifact.versionId),
    ),
  ).toBe(true);
  expect(snapshot.tasks.every((t) => t.status === 'passed')).toBe(true);
  const published = snapshot.events.find((e) => e.type === 'artifact_available')!;
  expect(published.taskId).toBe(artifact.taskId);
  expect(published.agentId).toBe('mori');
  expect(published.artifactVersionId).toBe(artifact.versionId);
  expect((await runtime.accept(id, [artifact.id])).ok).toBe(true);
  expect((await runtime.snapshot(id)).commission.status).toBe('accepted');
  expect((await runtime.revise(id, 'Add a new constraint', snapshot.commission.revision)).ok).toBe(
    true,
  );
  const revised = await runtime.snapshot(id);
  expect(revised.artifacts.every((a) => a.validity === 'stale')).toBe(true);
  expect((await runtime.accept(id, [artifact.id])).code).toBe('invalid_artifact');
});
it('creates linked rework, keeps failed review history, and verifies the replacement version', async () => {
  const { runtime, id } = await fixture('rework');
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(snapshot.events.some((e) => e.type === 'rework_created')).toBe(true);
  expect(snapshot.evidence.some((e) => e.kind === 'review' && e.status === 'failed')).toBe(true);
  expect(snapshot.artifacts.filter((a) => a.validity === 'stale')).toHaveLength(1);
  expect(
    (await runtime.artifact(snapshot.artifacts.find((a) => a.validity === 'current')!.id)).content,
  ).toBe('verified result');
});
it('keeps a review unable to verify when evidence only lists a directory', async () => {
  const { runtime, id } = await fixture('weak');
  const snapshot = await until(runtime, id, (s) =>
    s.tasks.some((t) => t.step === 'Unable to verify'),
  );
  expect(snapshot.commission.status).toBe('paused');
  expect(
    (
      await runtime.accept(
        id,
        snapshot.artifacts.map((a) => a.id),
      )
    ).code,
  ).toBe('unverified');
});
it('pauses before exceeding the model step budget', async () => {
  const { runtime, id } = await fixture('normal', { maxSteps: 1 });
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'paused');
  expect(snapshot.commission.stepsUsed).toBe(1);
  expect(snapshot.tasks.every((t) => t.attempts === 0)).toBe(true);
});
it('reports cancelling until an in-flight tool confirms it has returned stopped', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    start = new Promise<void>((resolve) => (started = resolve));
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      if (name === 'workspace_write') {
        started();
        await gate;
        return {
          ok: false,
          code: 'ABORTED',
          output: 'Stopped before writing',
          metadata: { stopStatus: 'stopped' },
        };
      }
      return base.execute(name, args, context);
    },
  };
  const { runtime, id } = await fixture('normal', { executor });
  await start;
  expect((await runtime.control(id, 'cancel')).ok).toBe(true);
  expect((await runtime.snapshot(id)).commission.status).toBe('cancelling');
  release();
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'cancelled');
  expect(snapshot.tasks.some((t) => t.status === 'passed')).toBe(false);
});
it('rejects integrating bytes changed after immutable publication', async () => {
  const { runtime, id, workspace } = await fixture('mutate');
  const snapshot = await until(runtime, id, (s) =>
    s.requests.some((r) => r.title === 'Published copy differs'),
  );
  expect(snapshot.commission.status).toBe('active');
  await expect(readFile(join(workspace.workPath, 'result.txt'), 'utf8')).rejects.toThrow();
  expect((await runtime.artifact(snapshot.artifacts[0].id)).content).toBe('verified result');
});
it.each([false, true])(
  'keeps an unknown tool outcome unresolved and blocks dispatch (cancel=%s)',
  async (cancel) => {
    const base = createExecutor({ projectRoot: process.cwd() });
    let release!: () => void,
      started!: () => void,
      calls = 0;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      start = new Promise<void>((resolve) => (started = resolve));
    const executor: ToolExecutor = {
      ...base,
      execute: async () => {
        calls++;
        started();
        await gate;
        return {
          ok: false,
          code: 'OUTCOME_UNKNOWN',
          output: 'Stop could not be confirmed',
          metadata: { stopStatus: 'outcome_unknown', reason: cancel ? 'cancelled' : 'timeout' },
        };
      },
    };
    const { runtime, id } = await fixture('normal', { executor });
    await start;
    if (cancel) await runtime.control(id, 'cancel');
    release();
    const snapshot = await until(runtime, id, (s) =>
      s.tasks.some((t) => t.error === 'outcome_unknown'),
    );
    expect(snapshot.commission.status).toBe('paused');
    expect(calls).toBe(1);
    expect(snapshot.artifacts).toHaveLength(0);
    expect(snapshot.events.some((e) => e.type === 'commission_cancelled')).toBe(false);
    expect((await runtime.control(id, 'resume')).code).toBe('outcome_unknown');
    expect((await runtime.control(id, 'cancel')).code).toBe('outcome_unknown');
  },
);
it('rejects reviewer file writes before they reach the executor', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  let forgedWrites = 0;
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      if (name === 'workspace_write' && args.content === 'forged review bytes') forgedWrites++;
      return base.execute(name, args, context);
    },
  };
  const { runtime, id } = await fixture('forge', { executor });
  const snapshot = await until(
    runtime,
    id,
    (s) => s.commission.status === 'awaiting_acceptance' || s.commission.status === 'paused',
  );
  expect(forgedWrites).toBe(0);
  expect(
    snapshot.evidence
      .filter((e) => e.kind === 'tool')
      .some((e) => e.detail.includes('forged review bytes')),
  ).toBe(false);
});
it('does not bind evidence to pinned versions when consumed bytes change during the tool', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      const output = await base.execute(name, args, context);
      if (name === 'workspace_read')
        await writeFile(join(context.workPath, 'result.txt'), 'tampered after read');
      return output;
    },
  };
  const { runtime, id } = await fixture('normal', { executor });
  const snapshot = await until(runtime, id, (s) =>
    s.tasks.some((t) => t.step === 'Unable to verify'),
  );
  expect(snapshot.evidence.some((e) => e.kind === 'review' && e.status === 'passed')).toBe(false);
});
it('rechecks review bytes at the decision after previously valid read evidence', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  let pinnedPath = '';
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      if (name === 'workspace_read') pinnedPath = join(context.workPath, 'result.txt');
      return base.execute(name, args, context);
    },
  };
  const { runtime, id } = await fixture('normal', {
    executor,
    beforeReviewSubmit: async () => {
      await writeFile(pinnedPath, 'tampered before decision');
    },
  });
  const snapshot = await until(runtime, id, (s) =>
    s.tasks.some((t) => t.step === 'Unable to verify'),
  );
  expect(snapshot.evidence.some((e) => e.kind === 'review' && e.status === 'passed')).toBe(false);
});
it('does not treat unrelated process exit zero as verification for every artifact', async () => {
  const { runtime, id } = await fixture('process');
  const snapshot = await until(runtime, id, (s) =>
    s.tasks.some((t) => t.step === 'Unable to verify'),
  );
  expect(snapshot.evidence.some((e) => e.kind === 'review' && e.status === 'passed')).toBe(false);
});
it('rechecks revision and artifact validity after acceptance blob IO', async () => {
  const { runtime, id } = await fixture();
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const accepting = runtime.accept(id, [snapshot.artifacts[0].id]);
  await runtime.revise(
    id,
    'New requirement invalidates the old artifact',
    snapshot.commission.revision,
  );
  expect((await accepting).code).toBe('stale_revision');
  expect((await runtime.snapshot(id)).commission.acceptedArtifactIds).toEqual([]);
});
it('blocks integrating an extra changed file that was never published', async () => {
  const { runtime, id, workspace } = await fixture('extra');
  await until(runtime, id, (s) => s.requests.some((r) => r.title === 'Published copy differs'));
  await expect(readFile(join(workspace.workPath, 'extra.ts'), 'utf8')).rejects.toThrow();
  await expect(readFile(join(workspace.workPath, 'result.txt'), 'utf8')).rejects.toThrow();
});
it('blocks integrating an unsupported unreviewed deletion', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      const output = await base.execute(name, args, context);
      if (name === 'workspace_write' && args.path === 'result.txt')
        await unlink(join(context.workPath, 'source.ts'));
      return output;
    },
  };
  const { runtime, id, workspace } = await fixture('extra', {
    executor,
    seed: { 'source.ts': 'preserve original' },
  });
  await until(runtime, id, (s) => s.requests.some((r) => r.title === 'Published copy differs'));
  expect(await readFile(join(workspace.workPath, 'source.ts'), 'utf8')).toBe('preserve original');
});
