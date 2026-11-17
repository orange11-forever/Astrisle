import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { publishArtifact } from '../../packages/artifacts/src/index';
import * as native from '../../packages/workspace/src/native-apply';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-runtime-apply-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    dataRoot = join(root, 'data');
  await mkdir(source);
  await writeFile(join(source, 'file.txt'), 'before');
  const options = {
    dataRoot,
    executor: createExecutor({ projectRoot: process.cwd() }),
    getCredentials: async () => null,
    applyHelperPath: resolve('dist/helpers/safe-apply.exe'),
  };
  const first = createRuntime(options);
  const workspace = await first.createWorkspace({ name: 'Writeback', sourcePath: source });
  const receipt = await first.submit({
    requestId: 'seed',
    workspaceId: workspace.id,
    goal: 'Update file',
    criteria: ['Updated'],
    planningMode: 'auto',
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: { maxSteps: 10, maxMinutes: 1, maxRework: 1 },
  });
  await first.close();
  const store = new RuntimeStore(dataRoot);
  const snapshot = store.get(receipt.commissionId!);
  await writeFile(join(workspace.workPath, 'file.txt'), 'after');
  const artifact = await publishArtifact(dataRoot, workspace.workPath, 'file.txt', {
    commissionId: snapshot.commission.id,
    taskId: 'author',
    name: 'file',
    mediaType: 'text/plain',
    inputVersions: [],
  });
  snapshot.artifacts = [artifact];
  snapshot.evidence = [
    {
      id: 'review',
      kind: 'review',
      summary: 'Verified',
      detail: '{}',
      status: 'passed',
      artifactVersionIds: [artifact.versionId],
      createdAt: new Date().toISOString(),
    },
  ];
  snapshot.commission.status = 'accepted';
  snapshot.commission.acceptedArtifactIds = [artifact.id];
  store.save(snapshot);
  store.close();
  let runtime: RuntimeService = createRuntime(options);
  cleanup.push(() => runtime.close());
  return {
    root,
    source,
    dataRoot,
    workspace,
    id: snapshot.commission.id,
    options,
    get runtime() {
      return runtime;
    },
    async reopen() {
      await runtime.close();
      runtime = createRuntime(options);
      return runtime;
    },
  };
}
describe.skipIf(process.platform !== 'win32')('runtime writeback leases', () => {
  it('applies accepted versions and exposes persisted history after restarting', async () => {
    const f = await fixture();
    const preview = await f.runtime.prepareApply(f.id);
    expect(preview.supported, preview.reason).toBe(true);
    const applied = await f.runtime.apply(preview.operationId);
    expect(applied.ok, applied.message).toBe(true);
    expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('after');
    await f.reopen();
    expect((await f.runtime.snapshot(f.id)).applyOperations?.[0].status).toBe('applied');
    const rollback = await f.runtime.prepareRollback(preview.operationId);
    expect(rollback.supported, rollback.reason).toBe(true);
    expect((await f.runtime.apply(rollback.operationId)).ok).toBe(true);
    expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('before');
  });
  it('blocks new writable work and revisions while an apply owns the workspace', async () => {
    const f = await fixture();
    const preview = await f.runtime.prepareApply(f.id);
    const original = native.invokeWriteback;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    vi.spyOn(native, 'invokeWriteback').mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const applying = f.runtime.apply(preview.operationId);
    await started;
    try {
      const submitted = await f.runtime.submit({
        requestId: 'during',
        workspaceId: f.workspace.id,
        goal: 'Other',
        criteria: ['Other'],
        planningMode: 'auto',
        scope: {
          readRoots: [],
          writeRoots: [],
          allowProcess: false,
          allowNetwork: false,
          allowedHosts: [],
        },
        budget: { maxSteps: 10, maxMinutes: 1, maxRework: 1 },
      });
      expect(submitted.code).toBe('writeback_busy');
      expect((await f.runtime.revise(f.id, 'Changed', 1)).code).toBe('writeback_busy');
    } finally {
      release();
    }
    expect((await applying).ok).toBe(true);
  });
  it('retains an unknown outcome across restart and unblocks only after explicit inspection', async () => {
    const f = await fixture();
    const preview = await f.runtime.prepareApply(f.id);
    vi.spyOn(native, 'invokeWriteback').mockResolvedValueOnce({
      ok: false,
      status: 'unknown',
      message: 'Receipt lost',
      files: [],
      conflicts: [],
      canRollback: false,
    });
    expect((await f.runtime.apply(preview.operationId)).ok).toBe(false);
    await f.reopen();
    expect((await f.runtime.snapshot(f.id)).applyOperations?.[0].status).toBe('unknown');
    const command = {
      requestId: 'after-restart',
      workspaceId: f.workspace.id,
      goal: 'Other',
      criteria: ['Other'],
      planningMode: 'auto' as const,
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 10, maxMinutes: 1, maxRework: 1 },
    };
    expect((await f.runtime.submit(command)).code).toBe('writeback_pending');
    expect((await f.runtime.inspectApply(preview.operationId)).status).toBe('conflict');
    expect((await f.runtime.submit(command)).ok).toBe(true);
    expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('before');
  });
});
