import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import type {
  Budget,
  ProjectSnapshot,
  ProviderInput,
  ToolExecutor,
} from '../../packages/contracts/src/index';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const executor: ToolExecutor = {
  definitions: () => [],
  execute: async () => ({ ok: false, output: 'unused' }),
  capabilities: async () => [],
};
const limits: Budget = { maxSteps: 10, maxMinutes: 1, maxRework: 3 };
async function seeded(mutate?: (s: ProjectSnapshot) => void) {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-budget-')));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  const initial = createRuntime({ dataRoot, executor, getCredentials: async () => null });
  const workspace = await initial.createWorkspace({ name: 'Budget fixture' });
  const receipt = await initial.submit({
    requestId: 'budget-fixture',
    workspaceId: workspace.id,
    goal: 'Continue real work',
    criteria: ['Verified result'],
    planningMode: 'auto',
    budget: limits,
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
  });
  await initial.close();
  const id = receipt.commissionId!;
  const store = new RuntimeStore(dataRoot);
  const s = store.get(id);
  s.commission.status = 'paused';
  s.commission.stepsUsed = 0;
  s.commission.activeMilliseconds = 0;
  s.tasks = [
    {
      id: 'author',
      commissionId: id,
      agentId: 'mori',
      title: 'Author',
      description: 'Work',
      kind: 'implement',
      status: 'waiting_input',
      dependencies: [],
      criterionIds: ['c1'],
      inputVersions: [],
      outputArtifactIds: [],
      step: 'Waiting',
      attempts: 0,
      createdAt: s.commission.createdAt,
      updatedAt: s.commission.createdAt,
    },
  ];
  s.requests = [
    {
      id: 'question',
      commissionId: id,
      taskId: 'author',
      kind: 'input',
      title: 'Need detail',
      detail: 'Keep waiting',
      status: 'open',
      createdAt: s.commission.createdAt,
    },
  ];
  mutate?.(s);
  store.transaction(() => store.save(s));
  store.close();
  const open = (
    getCredentials: () => Promise<(ProviderInput & { apiKey: string }) | null> = async () => null,
  ) => {
    const service = createRuntime({ dataRoot, executor, getCredentials });
    cleanup.push(() => service.close());
    return service;
  };
  return { id, dataRoot, open };
}

it('updates total limits while paused, rejects stale edits and preserves requirements and requests', async () => {
  const { id, open } = await seeded((s) => {
    s.commission.stepsUsed = 4;
  });
  const service = open();
  const before = await service.snapshot(id);
  expect(await service.updateBudget(id, { ...limits, maxSteps: 20 }, 0)).toMatchObject({
    ok: true,
  });
  const after = await service.snapshot(id);
  expect(after.commission).toMatchObject({
    status: 'paused',
    stepsUsed: 4,
    budgetRevision: 1,
    revision: before.commission.revision,
    budget: { ...limits, maxSteps: 20 },
  });
  expect(after.requests).toEqual(before.requests);
  expect(after.tasks).toEqual(before.tasks);
  expect((await service.updateBudget(id, limits, 0)).code).toBe('stale_revision');
  await service.close();
  expect((await open().snapshot(id)).commission.budget.maxSteps).toBe(20);
});

it('rejects invalid, active, terminal and below-usage budget updates', async () => {
  const { id, open } = await seeded((s) => {
    s.commission.stepsUsed = 4;
  });
  const service = open();
  for (const budget of [
    { ...limits, maxSteps: 0 },
    { ...limits, maxSteps: 10001 },
    { ...limits, maxMinutes: Infinity },
    { ...limits, maxMinutes: 0 },
    { ...limits, maxRework: NaN },
    { ...limits, maxRework: 1.5 },
    { ...limits, maxRework: 21 },
  ])
    expect((await service.updateBudget(id, budget, 0)).code).toBe('invalid_input');
  expect((await service.updateBudget(id, { ...limits, maxSteps: 3 }, 0)).code).toBe(
    'budget_below_usage',
  );
  await service.control(id, 'resume');
  expect((await service.updateBudget(id, limits, 0)).code).toBe('pause_required');
  await service.control(id, 'cancel');
  expect((await service.updateBudget(id, limits, 0)).code).toBe('terminal');
});

it('keeps cumulative active time across pause, resume and SQLite restart without charging offline time', async () => {
  let time = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  const { id, open } = await seeded();
  const first = open();
  await first.control(id, 'resume');
  time += 25000;
  await first.control(id, 'pause');
  expect((await first.snapshot(id)).commission.activeMilliseconds).toBe(25000);
  await first.close();
  time += 3600000;
  const second = open();
  expect((await second.snapshot(id)).commission.activeMilliseconds).toBe(25000);
  await second.control(id, 'resume');
  time += 35000;
  await second.control(id, 'pause');
  expect((await second.snapshot(id)).commission.activeMilliseconds).toBe(60000);
  expect((await second.control(id, 'resume')).code).toBe('budget_exhausted');
  expect((await second.updateBudget(id, { ...limits, maxMinutes: 2 }, 0)).ok).toBe(true);
  expect((await second.control(id, 'resume')).ok).toBe(true);
  expect((await second.snapshot(id)).tasks[0].status).toBe('waiting_input');
});

it('checkpoints active time and pauses an idle commission when the time limit expires', async () => {
  let time = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  const { id, open, dataRoot } = await seeded();
  const service = open();
  await service.control(id, 'resume');
  time += 60001;
  await vi.waitFor(
    async () => expect((await service.snapshot(id)).commission.status).toBe('paused'),
    { timeout: 2500 },
  );
  const store = new RuntimeStore(dataRoot);
  expect(store.get(id).commission.activeMilliseconds).toBe(60001);
  expect(store.get(id).events.at(-1)?.type).toBe('budget_paused');
  store.close();
});

it('budget edits do not resolve unknown actions or bypass a proposed-plan approval', async () => {
  const { id, open } = await seeded((s) => {
    s.requests.push({
      ...s.requests[0],
      id: 'plan',
      taskId: undefined,
      kind: 'approval',
      title: 'Review proposed plan',
    });
  });
  const service = open();
  await service.updateBudget(id, { ...limits, maxSteps: 50 }, 0);
  expect((await service.control(id, 'resume')).code).toBe('approval_required');
  const other = await seeded((s) => {
    s.requests[0].kind = 'approval';
    s.requests[0].title = 'Inspect interrupted task';
  });
  const unknown = other.open();
  await unknown.updateBudget(other.id, { ...limits, maxSteps: 50 }, 0);
  expect((await unknown.control(other.id, 'resume')).code).toBe('outcome_unknown');
});

async function provider(response: (body: any) => unknown) {
  let calls = 0;
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response(JSON.parse(body))));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return {
    count: () => calls,
    credentials: {
      kind: 'openai-compatible' as const,
      model: 'fixture',
      apiKey: '',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
  };
}

it('reserves the last step before awaiting two concurrent agent requests', async () => {
  const api = await provider(() => ({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'ask',
              type: 'function',
              function: {
                name: 'ask_input',
                arguments: JSON.stringify({ title: 'Input', detail: 'Wait', kind: 'input' }),
              },
            },
          ],
        },
      },
    ],
  }));
  const { id, open } = await seeded((s) => {
    s.requests = [];
    s.commission.budget.maxSteps = 1;
    s.tasks[0].status = 'queued';
    s.tasks.push({ ...s.tasks[0], id: 'second', agentId: 'luma' });
  });
  const service = open(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return api.credentials;
  });
  await service.control(id, 'resume');
  await vi.waitFor(async () => {
    const s = await service.snapshot(id);
    expect(s.commission.status).toBe('paused');
    expect(s.tasks.some((t) => t.status === 'running')).toBe(false);
  });
  expect(api.count()).toBe(1);
  expect((await service.snapshot(id)).commission.stepsUsed).toBe(1);
  expect((await service.control(id, 'resume')).code).toBe('budget_exhausted');
});

it('charges failed planning attempts and refuses a fresh plan after the limit is exhausted', async () => {
  const api = await provider(() => ({ choices: [{ message: { content: 'Invalid plan' } }] }));
  const { id, open } = await seeded((s) => {
    s.tasks = [];
    s.requests = [];
    s.commission.budget.maxSteps = 1;
  });
  const service = open(async () => api.credentials);
  await service.control(id, 'resume');
  await vi.waitFor(async () =>
    expect((await service.snapshot(id)).commission.status).toBe('paused'),
  );
  expect((await service.snapshot(id)).commission.stepsUsed).toBe(1);
  expect((await service.control(id, 'resume')).code).toBe('budget_exhausted');
  expect(api.count()).toBe(1);
});
