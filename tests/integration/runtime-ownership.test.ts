import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import type { RuntimeOptions } from '../../packages/contracts/src/index';
import * as workspaceStorage from '../../packages/workspace/src/index';

const cleanup: Array<() => Promise<unknown>> = [];
let workerCode: string;
beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/fixtures/runtime-owner-worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  });
  workerCode = result.outputFiles[0].text;
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-owner-')));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
function options(dataRoot: string): RuntimeOptions {
  return {
    dataRoot,
    getCredentials: async () => null,
    executor: {
      definitions: () => [],
      execute: async () => ({ ok: false, output: 'No tools' }),
      capabilities: async () => [],
    },
  };
}
function open(dataRoot: string, input = options(dataRoot)) {
  const runtime = createRuntime(input);
  cleanup.push(() => runtime.close());
  return runtime;
}
function blocked(dataRoot: string) {
  // Register an unexpected winner for cleanup so a RED test cannot leak its handle.
  expect(() => open(dataRoot)).toThrow(expect.objectContaining({ code: 'runtime_in_use' }));
}
function message(child: ChildProcess): Promise<{ status: string; code?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Owner worker did not respond')), 5000);
    const onExit = (code: number | null) => finish(new Error(`Owner exited early: ${code}`));
    const onError = (error: Error) => finish(error);
    const onMessage = (value: { status: string; code?: string }) => finish(undefined, value);
    function finish(error?: Error, value?: { status: string; code?: string }) {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      child.off('message', onMessage);
      if (error) reject(error);
      else resolve(value!);
    }
    child.once('exit', onExit);
    child.once('error', onError);
    child.once('message', onMessage);
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
async function launch(dataRoot: string) {
  const { writeFile } = await import('node:fs/promises');
  const file = join(dataRoot, `owner-worker-${randomUUID()}.cjs`);
  await writeFile(file, workerCode);
  const child = fork(file, [dataRoot], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  cleanup.push(() => stop(child));
  return { child, ready: message(child) };
}
async function seed(runtime: RuntimeService) {
  const workspace = await runtime.createWorkspace({ name: 'Ownership fixture' });
  const receipt = await runtime.submit({
    requestId: 'owner-fixture',
    workspaceId: workspace.id,
    goal: 'Preserve the owner state',
    criteria: ['No duplicate writer'],
    planningMode: 'review_first',
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: { maxSteps: 10, maxMinutes: 5, maxRework: 1 },
  });
  await runtime.control(receipt.commissionId!, 'pause');
  return receipt.commissionId!;
}

describe('exclusive runtime ownership', () => {
  it('rejects a second runtime before it can recover or change the owner snapshot', async () => {
    const dataRoot = await root();
    const first = open(dataRoot);
    const id = await seed(first);
    const before = await first.snapshot(id);
    blocked(dataRoot);
    expect(await first.snapshot(id)).toEqual(before);
    const other = open(await root());
    expect((await other.bootstrap()).workspaces).toEqual([]);
    await first.close();
    expect(await open(dataRoot).snapshot(id)).toEqual(before);
  });

  it('allows only one winner when real processes start concurrently', async () => {
    const dataRoot = await root();
    const [a, b] = await Promise.all([launch(dataRoot), launch(dataRoot)]);
    const results = await Promise.all([a.ready, b.ready]);
    expect(results.filter((r) => r.status === 'ready')).toHaveLength(1);
    expect(results.find((r) => r.status === 'error')?.code).toBe('runtime_in_use');
    const owner = results[0].status === 'ready' ? a.child : b.child;
    blocked(dataRoot);
    const exited = once(owner, 'exit');
    owner.send('close');
    await exited;
    await open(dataRoot).createWorkspace({ name: 'After graceful process exit' });
  });

  it('keeps an unresponsive process owner and reacquires only after confirmed death', async () => {
    const dataRoot = await root();
    const { child, ready } = await launch(dataRoot);
    expect((await ready).status).toBe('ready');
    const blocking = message(child);
    child.send('block');
    expect((await blocking).status).toBe('blocking');
    blocked(dataRoot);
    await stop(child);
    expect((await open(dataRoot).createWorkspace({ name: 'Recovered after crash' })).name).toBe(
      'Recovered after crash',
    );
  });

  it('releases ownership if business data fails to load during startup', async () => {
    const dataRoot = await root();
    const first = open(dataRoot);
    const id = await seed(first);
    await first.close();
    const db = new DatabaseSync(join(dataRoot, 'astrisle.sqlite'));
    try {
      const row = db.prepare('SELECT data FROM projects WHERE id=?').get(id)!;
      db.prepare('UPDATE projects SET data=? WHERE id=?').run('invalid json', id);
      expect(() => open(dataRoot)).toThrow();
      db.prepare('UPDATE projects SET data=? WHERE id=?').run(row.data, id);
      expect((await open(dataRoot).snapshot(id)).commission.id).toBe(id);
    } finally {
      db.close();
    }
  });

  it('drains a workspace creation before releasing ownership and refuses later commands', async () => {
    const dataRoot = await root();
    const runtime = open(dataRoot);
    const created = runtime.createWorkspace({ name: 'Created while closing' });
    void created.catch(() => {});
    const closing = runtime.close();
    blocked(dataRoot);
    const workspace = await created;
    await Promise.all([closing, runtime.close()]);
    const files = await readdir(join(dataRoot, 'workspaces'));
    await expect(runtime.createWorkspace({ name: 'Must not be created' })).rejects.toMatchObject({
      code: 'runtime_closing',
    });
    expect(await readdir(join(dataRoot, 'workspaces'))).toEqual(files);
    expect((await open(dataRoot).bootstrap()).workspaces.map((w) => w.id)).toEqual([workspace.id]);
  });

  it('holds ownership through concurrent close calls until pending commands settle', async () => {
    const dataRoot = await root();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const input = options(dataRoot);
    input.executor.capabilities = async () => {
      await gate;
      return [];
    };
    const runtime = open(dataRoot, input);
    const pending = runtime.bootstrap();
    const a = runtime.close();
    const b = runtime.close();
    try {
      blocked(dataRoot);
    } finally {
      release();
      await Promise.allSettled([pending, a, b]);
    }
    await expect(Promise.all([pending, a, b])).resolves.toHaveLength(3);
    open(dataRoot);
  });

  it('retains ownership until an already dispatched model job has settled', async () => {
    const dataRoot = await root();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const input = options(dataRoot);
    input.getCredentials = async () => {
      entered();
      await gate;
      return null;
    };
    const runtime = open(dataRoot, input);
    await seed(runtime);
    await started;
    const closing = runtime.close();
    try {
      blocked(dataRoot);
    } finally {
      release();
      await closing;
    }
    open(dataRoot);
  });

  it('registers a command before a synchronous callback can initiate close', async () => {
    const dataRoot = await root();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let closing!: Promise<void>;
    let closed = false;
    const input = options(dataRoot);
    let runtime!: RuntimeService;
    input.getCredentials = async () => {
      closing = runtime.close();
      void closing.then(() => (closed = true));
      await gate;
      return null;
    };
    runtime = open(dataRoot, input);
    const pending = runtime.bootstrap();
    void pending.catch(() => {});
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      blocked(dataRoot);
    } finally {
      release();
      await Promise.allSettled([pending, closing]);
    }
    await expect(pending).resolves.toMatchObject({ workspaces: [] });
    open(dataRoot);
  });

  it('aborts dispatched work before waiting for a slow bootstrap command', async () => {
    const dataRoot = await root();
    const initial = open(dataRoot);
    const id = await seed(initial);
    await initial.close();
    let releasePlan!: () => void;
    let releaseBootstrap!: () => void;
    let planEntered!: () => void;
    let bootstrapEntered!: () => void;
    const planGate = new Promise<void>((resolve) => (releasePlan = resolve));
    const bootstrapGate = new Promise<void>((resolve) => (releaseBootstrap = resolve));
    const planStarted = new Promise<void>((resolve) => (planEntered = resolve));
    const bootstrapStarted = new Promise<void>((resolve) => (bootstrapEntered = resolve));
    let credentialCalls = 0;
    let requests = 0;
    const input = options(dataRoot);
    input.getCredentials = async () => {
      if (++credentialCalls === 1) {
        planEntered();
        await planGate;
      }
      return {
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'shutdown-fixture',
        apiKey: 'test-only',
      };
    };
    input.executor.capabilities = async () => {
      bootstrapEntered();
      await bootstrapGate;
      return [];
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      requests++;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'No plan' } }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const runtime = open(dataRoot, input);
    await runtime.control(id, 'resume');
    await planStarted;
    const pending = runtime.bootstrap();
    await bootstrapStarted;
    const closing = runtime.close();
    try {
      releasePlan();
      // Let the already dispatched planning continuation reach its model-call boundary.
      await new Promise((resolve) => setImmediate(resolve));
      expect(requests).toBe(0);
      blocked(dataRoot);
    } finally {
      releaseBootstrap();
      await Promise.allSettled([pending, closing]);
      fetch.mockRestore();
    }
    expect(requests).toBe(0);
  });

  it('drains desktop exports before release and rejects all later delivery operations', async () => {
    const dataRoot = await root();
    const runtime = open(dataRoot);
    const id = await seed(runtime);
    const { workspace } = await runtime.snapshot(id);
    await writeFile(join(workspace.workPath, 'note.txt'), 'Complete exported content');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const copy = workspaceStorage.exportWorkspace;
    const exportSpy = vi
      .spyOn(workspaceStorage, 'exportWorkspace')
      .mockImplementation(async (...args) => {
        entered();
        await gate;
        return copy(...args);
      });
    let pending: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    const destination = join(dataRoot, 'export');
    try {
      pending = runtime.exportWorkspace(id, destination);
      await started;
      closing = runtime.close();
      blocked(dataRoot);
      await expect(
        runtime.exportWorkspace(id, join(dataRoot, 'late-export')),
      ).rejects.toMatchObject({
        code: 'runtime_closing',
      });
      await expect(runtime.prepareApply(id)).rejects.toMatchObject({ code: 'runtime_closing' });
      await expect(runtime.apply('operation')).rejects.toMatchObject({ code: 'runtime_closing' });
    } finally {
      release();
      await Promise.allSettled([pending, closing]);
      exportSpy.mockRestore();
    }
    expect(await pending).toMatchObject({ ok: true });
    expect(await readFile(join(destination, 'note.txt'), 'utf8')).toBe('Complete exported content');
    expect(await readdir(dataRoot)).not.toContain('late-export');
    open(dataRoot);
  });

  it('shares the close result with a synchronously reentrant abort listener', async () => {
    const dataRoot = await root();
    const initial = open(dataRoot);
    const id = await seed(initial);
    await initial.close();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let repeated: Promise<void> | undefined;
    let runtime!: RuntimeService;
    const input = options(dataRoot);
    input.getCredentials = async () => ({
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'abort-fixture',
      apiKey: 'test-only',
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!;
          signal.addEventListener('abort', () => {
            repeated = runtime.close();
            void repeated.catch(() => {});
            reject(signal.reason);
          });
          entered();
        }),
    );
    try {
      runtime = open(dataRoot, input);
      await runtime.control(id, 'resume');
      await started;
      const closing = runtime.close();
      void closing.catch(() => {});
      expect(repeated).toBe(closing);
      await closing;
      open(dataRoot);
    } finally {
      await runtime.close().catch(() => {});
      fetch.mockRestore();
    }
  });
});

it('persists runtime generations and rejects stale, duplicate and reconciled results', async () => {
  const dataRoot = await root();
  const runtime = open(dataRoot);
  const id = await seed(runtime);
  await runtime.close();
  const store = new RuntimeStore(dataRoot);
  try {
    const previous = store.beginRuntime();
    store.startCall('old-call', id, 'author', { kind: 'tool', name: 'write' });
    const current = store.beginRuntime();
    expect(current).toBe(previous + 1);
    expect(store.recentTaskCalls(id, 'author')[0].runtimeEpoch).toBe(previous);
    expect(() => store.endCall('old-call', { ok: true }, previous)).toThrow(
      expect.objectContaining({ code: 'stale_runtime_call' }),
    );
    expect(store.unknownCalls()[0].state).toBe('running');
    store.interruptCall('old-call', 'outcome_unknown');
    store.reconcileCalls(id, 'author', 'Confirmed process exit and inspected written files');
    expect(() => store.endCall('old-call', { ok: true }, previous)).toThrow();
    expect(store.recentTaskCalls(id, 'author')[0].state).toBe('reconciled');
    store.startCall('current-call', id, 'author', { kind: 'tool', name: 'write' });
    expect(() => store.endCall('current-call', { ok: false }, previous)).toThrow();
    store.endCall('current-call', { ok: true, output: 'durable result' }, current);
    expect(() => store.endCall('current-call', { ok: false }, current)).toThrow();
    expect(store.recentTaskCalls(id, 'author').at(-1)?.result).toEqual({
      ok: true,
      output: 'durable result',
    });
  } finally {
    store.close();
  }
  const restarted = new RuntimeStore(dataRoot);
  try {
    const priorEpoch = restarted.recentTaskCalls(id, 'author').at(-1)!.runtimeEpoch;
    expect(restarted.beginRuntime()).toBe(priorEpoch + 1);
    restarted.startCall('late-result', id, 'author', { kind: 'tool', name: 'write' });
    const next = new RuntimeStore(dataRoot);
    try {
      next.beginRuntime();
      expect(() => restarted.endCall('late-result', { ok: true })).toThrow(
        expect.objectContaining({ code: 'stale_runtime_call' }),
      );
      expect(next.unknownCalls().find((call) => call.id === 'late-result')?.state).toBe('running');
    } finally {
      next.close();
    }
  } finally {
    restarted.close();
  }
});
