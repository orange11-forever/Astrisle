/** Loopback models test durable continuity, not real-provider capability. */
import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { publishArtifact } from '../../packages/artifacts/src/index';
import { createTaskWorkspace } from '../../packages/workspace/src/index';
import { buildTaskContinuation } from '../../packages/runtime/src/task-context';
import type {
  ProjectSnapshot,
  RuntimeOptions,
  Task,
  ToolExecutor,
} from '../../packages/contracts/src/index';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const emptyExecutor: ToolExecutor = {
  definitions: () => [],
  execute: async () => ({ ok: false, output: 'No tools' }),
  capabilities: async () => [],
};
async function setup(executor = emptyExecutor) {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-continuity-')));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  const options: RuntimeOptions = { dataRoot, executor, getCredentials: async () => null };
  const runtime = createRuntime(options);
  cleanup.push(() => runtime.close());
  const workspace = await runtime.createWorkspace({ name: 'Continuity' });
  const receipt = await runtime.submit({
    requestId: 'continuity',
    workspaceId: workspace.id,
    goal: 'Continue real work',
    criteria: ['A reviewed note'],
    planningMode: 'auto',
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: { maxSteps: 30, maxMinutes: 1, maxRework: 2 },
  });
  await runtime.close();
  return { options, workspace, id: receipt.commissionId!, dataRoot };
}
function reopen(options: RuntimeOptions) {
  const runtime = createRuntime(options);
  cleanup.push(() => runtime.close());
  return runtime;
}
function interruptedTask(id: string): Task {
  return {
    id: 'author',
    commissionId: id,
    agentId: 'mori',
    title: 'Continue note',
    description: 'Finish note.txt',
    kind: 'implement',
    status: 'running',
    dependencies: [],
    criterionIds: ['c1'],
    inputVersions: [],
    outputArtifactIds: [],
    step: 'Working',
    attempts: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
async function until(
  runtime: RuntimeService,
  id: string,
  predicate: (s: ProjectSnapshot) => boolean,
) {
  const end = Date.now() + 5000;
  let snapshot = await runtime.snapshot(id);
  while (!predicate(snapshot) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = await runtime.snapshot(id);
  }
  expect(predicate(snapshot), JSON.stringify(snapshot)).toBe(true);
  return snapshot;
}

it('recovers an interrupted model request without inventing an unknown tool effect', async () => {
  const { options, id, dataRoot } = await setup();
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.commission.status = 'active';
  snapshot.tasks = [interruptedTask(id)];
  store.transaction(() => store.save(snapshot));
  store.startCall('model-interrupted', id, 'author', { kind: 'model' });
  store.close();
  const recovered = await reopen(options).snapshot(id);
  expect(recovered.commission.status).toBe('paused');
  expect(recovered.tasks[0].status).toBe('queued');
  expect(recovered.tasks[0].error).not.toBe('outcome_unknown');
  expect(recovered.requests.filter((r) => r.status === 'open')).toEqual([]);
});

it('does not restore old pinned bytes over a changed reviewer workspace on continuation', async () => {
  const { options, workspace, dataRoot, id } = await setup();
  await writeFile(join(workspace.workPath, 'note.txt'), 'published bytes');
  const artifact = await publishArtifact(dataRoot, workspace.workPath, 'note.txt', {
    commissionId: id,
    taskId: 'author',
    name: 'Note',
    mediaType: 'text/plain',
    inputVersions: [],
  });
  const reviewerPath = await createTaskWorkspace(workspace, 'review');
  await writeFile(join(reviewerPath, 'note.txt'), 'changed after inspection');
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.artifacts = [artifact];
  snapshot.tasks = [
    { ...interruptedTask(id), status: 'awaiting_review', outputArtifactIds: [artifact.id] },
    {
      ...interruptedTask(id),
      id: 'review',
      kind: 'review',
      agentId: 'luma',
      status: 'queued',
      dependencies: ['author'],
      dependencyKinds: { author: 'artifact_available' },
      inputVersions: [artifact.versionId],
    },
  ];
  store.transaction(() => store.save(snapshot));
  store.setTaskPath('review', reviewerPath);
  store.close();
  const runtime = reopen(options);
  await runtime.control(id, 'resume');
  await until(runtime, id, (s) => s.tasks.find((t) => t.id === 'review')?.status === 'failed');
  expect(await readFile(join(reviewerPath, 'note.txt'), 'utf8')).toBe('changed after inspection');
});

it('bounds large historical results while retaining completion identity and reading only task-local files', async () => {
  const { dataRoot, workspace } = await setup();
  await writeFile(join(dataRoot, 'outside.txt'), 'must not be inspected');
  const context = await buildTaskContinuation(
    workspace.workPath,
    Array.from({ length: 24 }, (_, i) => ({
      id: String(i),
      projectId: 'project',
      taskId: 'author',
      state: 'finished',
      request: { kind: 'tool', name: 'workspace_read', args: { path: '../outside.txt' } },
      result: { ok: true, evidenceId: `e${i}`, output: 'x'.repeat(10000) },
    })),
    [],
  );
  expect(context.recentActions[0].result).toMatchObject({ ok: true, evidenceId: 'e0' });
  expect(JSON.stringify(context).length).toBeLessThan(120000);
  expect(context.files).toEqual([{ path: '../outside.txt', status: 'unavailable' }]);
  expect(context.historyMayBeTruncated).toBe(true);
});

it('migrates legacy calls without losing receipts or turning unresolved effects into success', async () => {
  const { dataRoot, options, id } = await setup();
  const db = new DatabaseSync(join(dataRoot, 'astrisle.sqlite'));
  db.exec(`DROP INDEX IF EXISTS calls_by_task; DROP TABLE calls;
    CREATE TABLE calls(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL);
    DELETE FROM migrations WHERE version=2;`);
  db.prepare('INSERT INTO calls VALUES(?,?,?,?,?)').run(
    'old-write',
    id,
    'author',
    'running',
    JSON.stringify({
      kind: 'tool',
      name: 'workspace_write',
      args: { path: 'note.txt', content: 'old' },
    }),
  );
  db.prepare('INSERT INTO calls VALUES(?,?,?,?,?)').run(
    'old-finished',
    id,
    'author',
    'finished',
    JSON.stringify({ ok: true, output: 'saved output' }),
  );
  const oldSnapshot = JSON.parse(
    db.prepare('SELECT data FROM projects WHERE id=?').get(id)!.data as string,
  ) as ProjectSnapshot;
  oldSnapshot.evidence.push({
    id: 'old-evidence',
    kind: 'tool',
    summary: 'Saved write',
    detail: JSON.stringify({
      runId: 'old-finished',
      name: 'workspace_write',
      args: { path: 'earlier.txt', content: 'earlier' },
      result: { ok: true, output: 'saved output' },
    }),
    status: 'passed',
    taskId: 'author',
    artifactVersionIds: [],
    createdAt: new Date().toISOString(),
  });
  db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(oldSnapshot), id);
  db.close();
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.tasks = [interruptedTask(id)];
  store.transaction(() => store.save(snapshot));
  expect(store.receipt('continuity')?.result.commissionId).toBe(id);
  store.close();
  const runtime = reopen(options);
  expect((await runtime.control(id, 'resume')).code).toBe('outcome_unknown');
  await runtime.close();
  const migrated = new RuntimeStore(dataRoot);
  const calls = migrated.recentTaskCalls(id, 'author');
  const otherTaskCalls = migrated.recentTaskCalls('another-project', 'author');
  migrated.close();
  expect(calls[0]).toMatchObject({
    state: 'outcome_unknown',
    request: { kind: 'tool', name: 'workspace_write', args: { path: 'note.txt', content: 'old' } },
  });
  expect(calls[1]).toMatchObject({
    state: 'finished',
    request: { name: 'workspace_write', args: { path: 'earlier.txt' } },
    result: { ok: true, output: 'saved output' },
  });
  expect(otherTaskCalls).toEqual([]);
});

it('stops when a writing executor throws after creating a real side effect', async () => {
  let path = '';
  const { options, id, dataRoot } = await setup({
    ...emptyExecutor,
    definitions: () => [
      {
        name: 'append_then_throw',
        description: 'Write then lose result',
        effect: 'write',
        parameters: { type: 'object', properties: {} },
      },
    ],
    execute: async (_name, _args, context) => {
      path = join(context.workPath, 'note.txt');
      await appendFile(path, 'one write\n');
      throw new Error('Transport lost after write');
    },
  });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain */
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [call('append_then_throw', {})],
            },
          },
        ],
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
  options.getCredentials = async () => ({
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    model: 'fixture',
    apiKey: 'test-only',
  });
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.tasks = [{ ...interruptedTask(id), status: 'queued' }];
  snapshot.commission.budget.maxSteps = 3;
  store.transaction(() => store.save(snapshot));
  store.close();
  const runtime = reopen(options);
  await runtime.control(id, 'resume');
  const paused = await until(runtime, id, (s) => s.commission.status === 'paused');
  expect(paused.tasks[0].error).toBe('outcome_unknown');
  expect(await readFile(path, 'utf8')).toBe('one write\n');
  expect((await runtime.control(id, 'cancel')).code).toBe('outcome_unknown');
});

it.each(['before_effect', 'after_effect', 'after_receipt'] as const)(
  'recovers after a real worker process is killed at %s without replaying its write',
  async (phase) => {
    const { options, id, dataRoot } = await setup();
    const store = new RuntimeStore(dataRoot);
    const snapshot = store.get(id);
    snapshot.tasks = [{ ...interruptedTask(id), status: 'queued' }];
    store.transaction(() => store.save(snapshot));
    store.close();
    const worker = join(dataRoot, 'crash-worker.cjs');
    await build({
      entryPoints: ['tests/fixtures/runtime-crash-worker.ts'],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
    });
    let requests = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* drain */
      }
      if (++requests > 1) return; // The next model response remains in flight at the crash.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: '', tool_calls: [call('append_note', {})] } },
          ],
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
    const child = fork(
      worker,
      [dataRoot, id, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, phase],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
    });
    let errors = '';
    child.stderr?.on('data', (chunk) => {
      errors += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Crash worker did not reach checkpoint: ${errors}`)),
        5000,
      );
      child.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Worker exited early (${code}): ${errors}`));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
    const recovered = reopen(options);
    const current = await recovered.snapshot(id);
    expect(current.commission.status).toBe('paused');
    expect(current.tasks[0].status).toBe(phase === 'after_receipt' ? 'queued' : 'waiting_approval');
    const journal = new RuntimeStore(dataRoot);
    const action = journal.recentTaskCalls(id, 'author')[0];
    expect(action.state).toBe(phase === 'after_receipt' ? 'finished' : 'outcome_unknown');
    const file = join(journal.taskPath('author')!, 'note.txt');
    journal.close();
    if (phase === 'before_effect')
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(file, 'utf8')).toBe('one physical write\n');
    expect(current.evidence).toHaveLength(phase === 'after_receipt' ? 1 : 0);
    if (phase !== 'after_receipt')
      expect((await recovered.control(id, 'resume')).code).toBe('outcome_unknown');
  },
);

it.each(['running', 'returned_unknown', 'legacy_code', 'legacy_metadata'] as const)(
  'keeps a %s tool outcome gated across restarts even when pause was already committed',
  async (state) => {
    const { options, id, dataRoot } = await setup();
    const store = new RuntimeStore(dataRoot);
    const snapshot = store.get(id);
    snapshot.commission.status = 'paused';
    snapshot.tasks = [interruptedTask(id)];
    store.transaction(() => store.save(snapshot));
    store.startCall('uncertain-write', id, 'author', {
      kind: 'tool',
      name: 'process_run',
      args: { command: 'external-writer' },
    });
    if (state !== 'running')
      store.endCall('uncertain-write', {
        ok: false,
        ...(state === 'legacy_metadata'
          ? { metadata: { stopStatus: 'outcome_unknown' } }
          : { code: 'OUTCOME_UNKNOWN' }),
        output: 'Child stop unconfirmed',
      });
    store.close();
    if (state.startsWith('legacy_')) {
      const db = new DatabaseSync(join(dataRoot, 'astrisle.sqlite'));
      db.prepare("UPDATE calls SET state='finished' WHERE id='uncertain-write'").run();
      db.close();
    }
    const first = reopen(options);
    const recovered = await first.snapshot(id);
    const request = recovered.requests.find((r) => r.status === 'open')!;
    expect(request).toBeDefined();
    expect(request?.detail).toContain('uncertain-write');
    expect(recovered.tasks[0].error).toBe('outcome_unknown');
    expect((await first.control(id, 'resume')).code).toBe('outcome_unknown');
    expect((await first.control(id, 'cancel')).code).toBe('outcome_unknown');
    await first.close();
    const second = reopen(options);
    expect((await second.snapshot(id)).requests.filter((r) => r.status === 'open')).toHaveLength(1);
    expect((await second.answer(request.id, '', true)).ok).toBe(false);
    expect(
      (await second.answer(request.id, 'Verified child exit and inspected written files', true)).ok,
    ).toBe(true);
    await second.close();
    const third = reopen(options);
    expect((await third.snapshot(id)).requests.filter((r) => r.status === 'open')).toEqual([]);
    expect((await third.control(id, 'cancel')).ok).toBe(true);
  },
);

const call = (name: string, args: unknown) => ({
  id: `${name}-${Math.random()}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

it('continues a real delivery from durable actions and fresh files without repeating an append', async () => {
  const executor = createExecutor({ projectRoot: process.cwd() });
  let taskPath = '';
  const { options, id, dataRoot, workspace } = await setup({
    ...executor,
    definitions: () => [
      ...executor.definitions(),
      {
        name: 'append_note',
        description: 'Append exactly one note',
        effect: 'write',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    execute: async (name, args, context) => {
      if (name !== 'append_note') return executor.execute(name, args, context);
      taskPath = context.workPath;
      await appendFile(join(taskPath, 'note.txt'), 'one completed action\n');
      return { ok: true, output: 'Append completed exactly once', files: ['note.txt'] };
    },
  });
  const authorContexts: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages;
    const context = JSON.parse(messages.find((m: any) => m.role === 'user').content);
    let calls;
    if (context.task.kind === 'implement') {
      authorContexts.push(context);
      const completed = context.continuation?.recentActions.some(
        (a: any) => a.name === 'append_note' && a.result?.ok,
      );
      calls = completed
        ? [
            call('submit_artifact', { path: 'note.txt', name: 'Note', mediaType: 'text/plain' }),
            call('complete_task', { summary: 'Continued using saved action receipt' }),
          ]
        : [
            call('append_note', {}),
            call('ask_input', {
              title: 'Continue later',
              detail: 'Confirm the note',
              kind: 'input',
            }),
          ];
    } else {
      const evidence = messages
        .filter((m: any) => m.role === 'tool')
        .map((m: any) => JSON.parse(m.content))
        .find((r: any) => r.evidenceId);
      calls = evidence
        ? [
            call('submit_review', {
              verdict: 'pass',
              summary: 'Read saved file',
              evidenceIds: [evidence.evidenceId],
              versionIds: context.inputs.map((a: any) => a.versionId),
            }),
          ]
        : [call('workspace_read', { path: 'note.txt' })];
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: calls } }],
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
  options.getCredentials = async () => ({
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    model: 'fixture',
    apiKey: 'test-only',
  });
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.tasks = [
    { ...interruptedTask(id), status: 'queued' },
    {
      ...interruptedTask(id),
      id: 'review',
      agentId: 'luma',
      kind: 'review',
      status: 'queued',
      dependencies: ['author'],
      dependencyKinds: { author: 'artifact_available' },
    },
  ];
  store.transaction(() => store.save(snapshot));
  store.close();
  const first = reopen(options);
  await first.control(id, 'resume');
  const waiting = await until(first, id, (s) =>
    s.requests.some((r) => r.title === 'Continue later'),
  );
  await first.close();
  await appendFile(join(taskPath, 'note.txt'), 'user revision while paused\n');
  const second = reopen(options);
  await second.answer(waiting.requests[0].id, 'Keep my revision and finish');
  await second.control(id, 'resume');
  await until(second, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(await readFile(join(workspace.workPath, 'note.txt'), 'utf8')).toBe(
    'one completed action\nuser revision while paused\n',
  );
  const resumed = authorContexts[1];
  expect(resumed.continuation.recentActions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'append_note',
        state: 'finished',
        result: expect.objectContaining({ ok: true }),
      }),
      expect.objectContaining({ name: 'ask_input', state: 'finished' }),
    ]),
  );
  expect(resumed.continuation.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'note.txt', status: 'present', size: 48 }),
    ]),
  );
  expect(resumed.userAnswers[0].answer).toBe('Keep my revision and finish');
  const db = new DatabaseSync(join(dataRoot, 'astrisle.sqlite'));
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM calls WHERE task_id='author' AND json_extract(request_data, '$.name')='append_note'",
      )
      .get()?.n,
  ).toBe(1);
  db.close();
});

async function modelFixture(
  options: RuntimeOptions,
  respond: (context: any, request: number) => ReturnType<typeof call>[],
) {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(body);
    const messages = JSON.parse(body).messages;
    const context = JSON.parse(messages.find((m: any) => m.role === 'user').content);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: respond(context, requests.length),
            },
          },
        ],
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
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  options.getCredentials = async () => ({
    kind: 'openai-compatible',
    baseUrl,
    model: 'fixture',
    apiKey: 'test-only',
  });
  return { requests, baseUrl };
}

it.each([
  ['input', 'reconciliation'],
  ['input', 'ordinary'],
  ['approval', 'reconciliation'],
  ['approval', 'ordinary'],
] as const)('keeps a crashed %s request gated when %s is answered first', async (kind, first) => {
  const { options, id, dataRoot } = await setup();
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.tasks = [{ ...interruptedTask(id), status: 'queued' }];
  store.transaction(() => store.save(snapshot));
  store.close();
  const contexts: any[] = [];
  const { requests, baseUrl } = await modelFixture(options, (context, request) => {
    contexts.push(context);
    return [
      call('ask_input', {
        title: request === 1 ? 'Original decision' : 'Next decision',
        detail: 'A real user decision is required',
        kind,
      }),
    ];
  });
  const worker = join(dataRoot, 'input-crash-worker.cjs');
  await build({
    entryPoints: ['tests/fixtures/runtime-crash-worker.ts'],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  });
  const child = fork(worker, [dataRoot, id, baseUrl, 'after_input'], { stdio: 'ignore' });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
  });
  const [exitCode] = await once(child, 'exit');
  expect(exitCode).toBe(86);
  const runtime = reopen(options);
  const recovered = await runtime.snapshot(id);
  const ordinary = recovered.requests.find((r) => r.title === 'Original decision')!;
  const reconciliation = recovered.requests.find((r) => r.title === 'Inspect interrupted task')!;
  expect(recovered.requests.filter((r) => r.status === 'open')).toHaveLength(2);
  const before = new RuntimeStore(dataRoot);
  expect(before.recentTaskCalls(id, 'author')[0]).toMatchObject({
    state: 'outcome_unknown',
    request: { name: 'ask_input' },
  });
  before.close();
  const firstRequest = first === 'ordinary' ? ordinary : reconciliation;
  const secondRequest = first === 'ordinary' ? reconciliation : ordinary;
  await runtime.answer(firstRequest.id, 'First observed decision', true);
  await runtime.control(id, 'resume');
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(requests).toHaveLength(1);
  expect((await runtime.snapshot(id)).tasks[0].status).toBe(
    first === 'reconciliation' && kind === 'input' ? 'waiting_input' : 'waiting_approval',
  );
  await runtime.answer(secondRequest.id, 'Second observed decision', true);
  await runtime.control(id, 'resume');
  await until(runtime, id, (s) => s.requests.some((r) => r.title === 'Next decision'));
  expect(requests).toHaveLength(2);
  expect(contexts[1].userAnswers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: ordinary.id, status: 'answered' }),
      expect.objectContaining({ id: reconciliation.id, status: 'answered' }),
    ]),
  );
  expect(contexts[1].pendingRequests).toEqual([]);
});

it('does not dispatch a queued task with an unanswered persisted request', async () => {
  const { options, id, dataRoot } = await setup();
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.tasks = [{ ...interruptedTask(id), status: 'queued' }];
  snapshot.requests.push({
    id: 'pending',
    commissionId: id,
    taskId: 'author',
    kind: 'input',
    title: 'Still waiting',
    detail: 'Reply before work continues',
    status: 'open',
    createdAt: new Date().toISOString(),
  });
  store.transaction(() => store.save(snapshot));
  store.close();
  const { requests } = await modelFixture(options, () => [
    call('ask_input', {
      title: 'Should not run',
      detail: 'Premature dispatch',
      kind: 'input',
    }),
  ]);
  const runtime = reopen(options);
  await runtime.control(id, 'resume');
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(requests).toHaveLength(0);
  expect((await runtime.snapshot(id)).tasks[0].status).toBe('waiting_input');
});

it('closes a model-only pending receipt when pause already committed and the task is queued', async () => {
  const { options, id, dataRoot } = await setup();
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.commission.status = 'paused';
  snapshot.tasks = [{ ...interruptedTask(id), status: 'queued' }];
  store.transaction(() => store.save(snapshot));
  store.startCall('paused-model', id, 'author', { kind: 'model' });
  store.close();
  const runtime = reopen(options);
  expect((await runtime.snapshot(id)).requests.filter((r) => r.status === 'open')).toEqual([]);
  const recovered = new RuntimeStore(dataRoot);
  const unknown = recovered.unknownCalls();
  recovered.close();
  expect(unknown).toEqual([]);
  const db = new DatabaseSync(join(dataRoot, 'astrisle.sqlite'));
  const receipt = db.prepare("SELECT state,data FROM calls WHERE id='paused-model'").get()!;
  db.close();
  expect(receipt.state).toBe('finished');
  expect(JSON.parse(receipt.data as string).code).toBe('interrupted');
});

it('bounds the resumed HTTP payload while retaining usable verification evidence identities', async () => {
  const { options, workspace, dataRoot, id } = await setup();
  await writeFile(join(workspace.workPath, 'note.txt'), 'verified current bytes');
  const artifact = await publishArtifact(dataRoot, workspace.workPath, 'note.txt', {
    commissionId: id,
    taskId: 'author',
    name: 'Note',
    mediaType: 'text/plain',
    inputVersions: [],
  });
  const workPath = await createTaskWorkspace(workspace, 'review');
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.artifacts = [artifact];
  snapshot.tasks = [
    { ...interruptedTask(id), status: 'passed', outputArtifactIds: [artifact.id] },
    {
      ...interruptedTask(id),
      id: 'review',
      agentId: 'luma',
      kind: 'review',
      status: 'queued',
      dependencies: ['author'],
      inputVersions: [artifact.versionId],
    },
  ];
  const payload = 'large historical payload '.repeat(800);
  for (let i = 0; i < 80; i++) {
    const args = { path: 'note.txt', previousContent: payload };
    const result = {
      ok: true,
      output: payload,
      evidenceId: `e${i}`,
      inputVersionIds: [artifact.versionId],
    };
    snapshot.evidence.push({
      id: `e${i}`,
      kind: 'tool',
      taskId: 'review',
      status: 'passed',
      summary: 'Read exact note version',
      artifactVersionIds: [artifact.versionId],
      createdAt: new Date().toISOString(),
      detail: JSON.stringify({
        runId: `read-${i}`,
        name: 'workspace_read',
        args,
        result,
        verifiedInputs: [{ versionId: artifact.versionId, sha256: artifact.sha256 }],
      }),
    });
  }
  store.transaction(() => store.save(snapshot));
  store.setTaskPath('review', workPath);
  for (let i = 0; i < 80; i++) {
    const detail = JSON.parse(snapshot.evidence[i].detail);
    store.startCall(detail.runId, id, 'review', {
      kind: 'tool',
      name: detail.name,
      args: detail.args,
    });
    store.endCall(detail.runId, detail.result);
  }
  store.close();
  let context: any;
  const { requests } = await modelFixture(options, (value) => {
    context = value;
    return [
      call('submit_review', {
        verdict: 'pass',
        summary: 'Verified from a durable exact-version receipt',
        evidenceIds: [value.priorEvidence.at(-1).id],
        versionIds: [artifact.versionId],
      }),
    ];
  });
  const runtime = reopen(options);
  await runtime.control(id, 'resume');
  const delivered = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(Buffer.byteLength(requests[0])).toBeLessThan(200000);
  expect(context.priorEvidence).toHaveLength(24);
  expect(context.priorEvidence.at(-1)).toMatchObject({
    id: 'e79',
    status: 'passed',
    artifactVersionIds: [artifact.versionId],
  });
  expect(JSON.parse(context.priorEvidence.at(-1).detail).verifiedInputs).toEqual([
    { versionId: artifact.versionId, sha256: artifact.sha256 },
  ]);
  expect(context.priorEvidenceMayBeTruncated).toBe(true);
  expect(context.continuation.recentActions.at(-1).result.inputVersionIds).toEqual([
    artifact.versionId,
  ]);
  expect(delivered.evidence.find((e) => e.kind === 'review')?.status).toBe('passed');
  expect(delivered.evidence[0].detail).toContain(payload);
});

it('gates a partial managed integration failure before another model request and across restart', async () => {
  const { options, workspace, dataRoot, id } = await setup();
  const workPath = await createTaskWorkspace(workspace, 'author');
  const artifacts = [];
  for (const path of ['a.txt', 'b.txt']) {
    await writeFile(join(workPath, path), `published ${path}`);
    artifacts.push(
      await publishArtifact(dataRoot, workPath, path, {
        commissionId: id,
        taskId: 'author',
        name: path,
        mediaType: 'text/plain',
        inputVersions: [],
      }),
    );
  }
  // Empty directories are not manifest files. The first write succeeds, then this real target fails.
  await mkdir(join(workspace.workPath, 'b.txt'));
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(id);
  snapshot.tasks = [
    { ...interruptedTask(id), status: 'queued', outputArtifactIds: artifacts.map((a) => a.id) },
  ];
  snapshot.artifacts = artifacts;
  store.transaction(() => store.save(snapshot));
  store.setTaskPath('author', workPath);
  store.close();
  const { requests } = await modelFixture(options, (_context, request) => [
    request === 1
      ? call('complete_task', { summary: 'Integrate both published files' })
      : call('ask_input', {
          title: 'Incorrect continuation',
          detail: 'Ran after partial effects',
          kind: 'input',
        }),
  ]);
  const runtime = reopen(options);
  await runtime.control(id, 'resume');
  const paused = await until(
    runtime,
    id,
    (s) => s.commission.status === 'paused' || requests.length > 1,
  );
  expect(await readFile(join(workspace.workPath, 'a.txt'), 'utf8')).toBe('published a.txt');
  expect((await stat(join(workspace.workPath, 'b.txt'))).isDirectory()).toBe(true);
  expect(requests).toHaveLength(1);
  expect(paused.commission.status).toBe('paused');
  expect(paused.tasks[0]).toMatchObject({ status: 'waiting_approval', error: 'outcome_unknown' });
  expect((await runtime.control(id, 'resume')).code).toBe('outcome_unknown');
  const journal = new RuntimeStore(dataRoot);
  expect(journal.recentTaskCalls(id, 'author')[0]).toMatchObject({
    state: 'outcome_unknown',
    request: { name: 'complete_task' },
    result: { code: 'OUTCOME_UNKNOWN' },
  });
  journal.close();
  await runtime.close();
  const restarted = reopen(options);
  expect((await restarted.control(id, 'resume')).code).toBe('outcome_unknown');
  expect((await restarted.snapshot(id)).requests.filter((r) => r.status === 'open')).toHaveLength(
    1,
  );
  expect(requests).toHaveLength(1);
});
