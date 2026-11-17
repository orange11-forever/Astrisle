import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorkspaceStorage } from '../../packages/workspace/src/index';
import { publishArtifact } from '../../packages/artifacts/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { SafeApplyService } from '../../packages/workspace/src/apply';
import type { ProjectSnapshot } from '../../packages/contracts/src/index';
import * as native from '../../packages/workspace/src/native-apply';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(twoExisting = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-safe-service-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    dataRoot = join(root, 'data');
  await mkdir(join(source, '.git'), { recursive: true });
  await writeFile(join(source, '.git', 'HEAD'), 'original git state');
  await writeFile(join(source, 'dirty.txt'), 'uncommitted original');
  if (twoExisting) await writeFile(join(source, 'new.txt'), 'second original');
  const workspace = await createWorkspaceStorage(
    { name: 'Imported', sourcePath: source },
    dataRoot,
  );
  await writeFile(join(workspace.workPath, 'dirty.txt'), 'accepted update');
  await writeFile(join(workspace.workPath, 'new.txt'), 'accepted new file');
  const artifacts = await Promise.all(
    ['dirty.txt', 'new.txt'].map((path) =>
      publishArtifact(dataRoot, workspace.workPath, path, {
        commissionId: 'c',
        taskId: 'author',
        name: path,
        mediaType: 'text/plain',
        inputVersions: [],
      }),
    ),
  );
  const snapshot: ProjectSnapshot = {
    workspace,
    agents: [],
    tasks: [],
    artifacts,
    evidence: artifacts.map((a) => ({
      id: a.id,
      kind: 'review',
      summary: 'Verified',
      detail: '{}',
      status: 'passed',
      artifactVersionIds: [a.versionId],
      createdAt: new Date().toISOString(),
    })),
    events: [],
    requests: [],
    lastSequence: 0,
    commission: {
      id: 'c',
      workspaceId: workspace.id,
      title: 'Update files',
      goal: 'Update files',
      status: 'accepted',
      criteria: [{ id: 'c1', description: 'Updated files' }],
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 20, maxMinutes: 5, maxRework: 2 },
      revision: 1,
      planningMode: 'auto',
      stepsUsed: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      acceptedArtifactIds: artifacts.map((a) => a.id),
      summary: 'Accepted',
    },
  };
  const store = new RuntimeStore(dataRoot);
  store.addWorkspace(workspace);
  store.save(snapshot);
  cleanup.push(async () => store.close());
  const service = new SafeApplyService({
    dataRoot,
    store,
    helperPath: resolve('dist/helpers/safe-apply.exe'),
  });
  return { root, source, dataRoot, workspace, snapshot, store, service };
}
describe.skipIf(process.platform !== 'win32')('accepted original writeback', () => {
  it.each(['execute', 'inspect'] as const)(
    'keeps contradictory %s receipts unresolved without advancing the baseline',
    async (action) => {
      const f = await fixture();
      const baselinePath = join(f.workspace.workPath, '..', 'baseline.json');
      const before = await readFile(baselinePath, 'utf8');
      const preview = await f.service.prepare(f.snapshot);
      vi.spyOn(native, 'invokeWriteback').mockResolvedValue({
        ok: false,
        status: 'applied',
        message: 'contradictory receipt',
        canRollback: false,
        conflicts: ['dirty.txt'],
        files: [],
      });
      if (action === 'execute')
        expect((await f.service.execute(preview.operationId, f.snapshot)).ok).toBe(false);
      else expect((await f.service.inspect(preview.operationId)).status).toBe('unknown');
      expect(f.service.hasPending(f.workspace.id)).toBe(true);
      expect(await readFile(baselinePath, 'utf8')).toBe(before);
      expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('uncommitted original');
    },
  );
  it('rejects otherwise successful receipts with incomplete or unrelated file evidence', async () => {
    const f = await fixture();
    const preview = await f.service.prepare(f.snapshot);
    vi.spyOn(native, 'invokeWriteback').mockResolvedValue({
      ok: true,
      status: 'applied',
      message: 'incomplete',
      canRollback: false,
      conflicts: [],
      inspectionToken: undefined,
      files: [
        {
          path: 'unrelated.txt',
          action: 'create',
          state: 'after',
          beforeHash: null,
          afterHash: 'a'.repeat(64),
          currentHash: 'a'.repeat(64),
          message: undefined,
        },
      ],
    });
    expect((await f.service.execute(preview.operationId, f.snapshot)).ok).toBe(false);
    expect(f.service.hasPending(f.workspace.id)).toBe(true);
  });
  it('never expands rollback beyond the file states approved in its preview', async () => {
    const f = await fixture(true);
    const preview = await f.service.prepare(f.snapshot);
    expect((await f.service.execute(preview.operationId, f.snapshot)).ok).toBe(true);
    await writeFile(join(f.source, 'new.txt'), 'second original');
    const rollback = await f.service.prepareRollback(preview.operationId, f.snapshot);
    expect(rollback.supported, rollback.reason).toBe(true);
    expect(rollback.changes.map((change) => change.path)).toEqual(['dirty.txt']);
    await writeFile(join(f.source, 'new.txt'), 'accepted new file');
    expect((await f.service.execute(rollback.operationId, f.snapshot)).ok).toBe(false);
    expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('accepted update');
    expect(await readFile(join(f.source, 'new.txt'), 'utf8')).toBe('accepted new file');
  });
  it('previews accepted hashes without writing, applies once and persists history across service recreation', async () => {
    const f = await fixture();
    const preview = await f.service.prepare(f.snapshot);
    expect(preview.supported, preview.reason).toBe(true);
    expect(preview.changes.map((c) => c.path)).toEqual(['dirty.txt', 'new.txt']);
    expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('uncommitted original');
    expect((await f.service.execute(preview.operationId, f.snapshot)).ok).toBe(true);
    expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('accepted update');
    expect(await readFile(join(f.source, 'new.txt'), 'utf8')).toBe('accepted new file');
    expect(await readFile(join(f.source, '.git', 'HEAD'), 'utf8')).toBe('original git state');
    const reopened = new SafeApplyService({
      dataRoot: f.dataRoot,
      store: f.store,
      helperPath: resolve('dist/helpers/safe-apply.exe'),
    });
    expect(reopened.list(f.workspace.id)[0].status).toBe('applied');
    await writeFile(join(f.source, 'dirty.txt'), 'later user edit');
    expect((await reopened.execute(preview.operationId, f.snapshot)).ok).toBe(true);
    expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('later user edit');
  });
  it('rejects unaccepted, unpublished and deletion changes', async () => {
    const f = await fixture();
    f.snapshot.commission.status = 'awaiting_acceptance';
    expect((await f.service.prepare(f.snapshot)).supported).toBe(false);
    f.snapshot.commission.status = 'accepted';
    await writeFile(join(f.workspace.workPath, 'extra.txt'), 'not published');
    expect((await f.service.prepare(f.snapshot)).supported).toBe(false);
    await unlink(join(f.workspace.workPath, 'extra.txt'));
    await unlink(join(f.workspace.workPath, 'dirty.txt'));
    expect((await f.service.prepare(f.snapshot)).supported).toBe(false);
  });
  it('refuses changed candidates and stale revisions after preview', async () => {
    const f = await fixture();
    const preview = await f.service.prepare(f.snapshot);
    const changed = structuredClone(f.snapshot);
    changed.commission.revision++;
    expect((await f.service.execute(preview.operationId, changed)).ok).toBe(false);
    const next = await f.service.prepare(f.snapshot);
    await writeFile(join(f.workspace.workPath, 'dirty.txt'), 'unpublished edit');
    expect((await f.service.execute(next.operationId, f.snapshot)).ok).toBe(false);
    expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('uncommitted original');
  });
  it('preserves external source edits between preview and apply', async () => {
    const f = await fixture();
    const preview = await f.service.prepare(f.snapshot);
    await writeFile(join(f.source, 'dirty.txt'), 'user changed source');
    expect((await f.service.execute(preview.operationId, f.snapshot)).ok).toBe(false);
    expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('user changed source');
    await expect(readFile(join(f.source, 'new.txt'))).rejects.toThrow();
  });
  it('restores own applied files only after a fresh rollback preview and preserves later edits', async () => {
    const f = await fixture();
    const preview = await f.service.prepare(f.snapshot);
    expect((await f.service.execute(preview.operationId, f.snapshot)).ok).toBe(true);
    const rollback = await f.service.prepareRollback(preview.operationId, f.snapshot);
    expect(rollback.supported, rollback.reason).toBe(true);
    expect((await f.service.execute(rollback.operationId, f.snapshot)).ok).toBe(true);
    expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('uncommitted original');
    await expect(readFile(join(f.source, 'new.txt'))).rejects.toThrow();
    const next = await f.service.prepare(f.snapshot);
    expect(next.supported, next.reason).toBe(true);
    expect((await f.service.execute(next.operationId, f.snapshot)).ok).toBe(true);
    await writeFile(join(f.source, 'dirty.txt'), 'later edit');
    expect((await f.service.prepareRollback(next.operationId, f.snapshot)).supported).toBe(false);
    expect(await readFile(join(f.source, 'dirty.txt'), 'utf8')).toBe('later edit');
  });
});
