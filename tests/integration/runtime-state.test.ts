import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import type { SubmitInput, ToolExecutor } from '../../packages/contracts/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';

const executor: ToolExecutor = {
  definitions: () => [],
  execute: async () => ({ ok: false, output: 'none' }),
  capabilities: async () => [],
};
const dirs: string[] = [],
  services: RuntimeService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'astrisle-state-'));
  dirs.push(dataRoot);
  const service = createRuntime({ dataRoot, executor, getCredentials: async () => null });
  services.push(service);
  const workspace = await service.createWorkspace({ name: 'Real workspace' });
  return { service, workspace, dataRoot };
}
function input(workspaceId: string): SubmitInput {
  return {
    requestId: 'receipt-one',
    workspaceId,
    goal: 'Create a useful project',
    criteria: ['Files actually exist'],
    planningMode: 'review_first',
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: { maxSteps: 20, maxMinutes: 5, maxRework: 3 },
  };
}
describe('durable runtime command invariants', () => {
  it('returns the original receipt and rejects changed payloads with the same request ID', async () => {
    const { service, workspace } = await setup();
    const command = input(workspace.id);
    const first = await service.submit(command);
    expect(first.ok).toBe(true);
    expect(await service.submit(command)).toEqual(first);
    expect((await service.submit({ ...command, goal: 'Other' })).code).toBe('request_conflict');
  });
  it('rejects a second writable commission and stale revisions', async () => {
    const { service, workspace } = await setup();
    const first = await service.submit(input(workspace.id));
    expect((await service.submit({ ...input(workspace.id), requestId: 'two' })).code).toBe(
      'workspace_busy',
    );
    expect((await service.revise(first.commissionId!, 'New constraint', 900)).code).toBe(
      'stale_revision',
    );
  });
  it('commits snapshots with increasing event sequence and survives restart in a real SQLite file', async () => {
    const { service, workspace, dataRoot } = await setup();
    const receipt = await service.submit(input(workspace.id));
    await service.control(receipt.commissionId!, 'pause');
    const before = await service.snapshot(receipt.commissionId!);
    expect(before.events.map((e) => e.sequence)).toEqual(before.events.map((_, i) => i + 1));
    expect(before.lastSequence).toBe(before.events.length);
    await service.close();
    services.splice(services.indexOf(service), 1);
    const reopened = createRuntime({ dataRoot, executor, getCredentials: async () => null });
    services.push(reopened);
    expect(await reopened.snapshot(receipt.commissionId!)).toEqual(before);
    expect((await readFile(join(dataRoot, 'astrisle.sqlite'))).subarray(0, 15).toString()).toBe(
      'SQLite format 3',
    );
    expect(await reopened.submit(input(workspace.id))).toEqual(receipt);
  });
  it('pauses interrupted calls on restart without automatically replaying side effects', async () => {
    const { service, workspace, dataRoot } = await setup();
    const receipt = await service.submit(input(workspace.id));
    await service.close();
    services.splice(services.indexOf(service), 1);
    const store = new RuntimeStore(dataRoot),
      snapshot = store.get(receipt.commissionId!);
    snapshot.commission.status = 'active';
    snapshot.tasks.push({
      id: 'interrupted',
      commissionId: receipt.commissionId!,
      agentId: 'mori',
      title: 'Interrupted task',
      description: 'An external write may have happened',
      kind: 'implement',
      status: 'running',
      dependencies: [],
      criterionIds: ['c1'],
      inputVersions: [],
      outputArtifactIds: [],
      step: 'process_run',
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.transaction(() => store.save(snapshot));
    store.startCall('interrupted-call', receipt.commissionId!, 'interrupted', {
      kind: 'tool',
      name: 'process_run',
    });
    store.close();
    let calls = 0;
    const resumed = createRuntime({
      dataRoot,
      executor: {
        ...executor,
        execute: async () => {
          calls++;
          return { ok: true, output: 'never' };
        },
      },
      getCredentials: async () => null,
    });
    services.push(resumed);
    const recovered = await resumed.snapshot(receipt.commissionId!);
    expect(recovered.commission.status).toBe('paused');
    expect(recovered.tasks[0].error).toBe('outcome_unknown');
    expect(calls).toBe(0);
    expect((await resumed.control(receipt.commissionId!, 'resume')).code).toBe('outcome_unknown');
  });
});
