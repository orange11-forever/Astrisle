import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishArtifact } from '../../packages/artifacts/src/index';
import type { Artifact, ProjectSnapshot } from '../../packages/contracts/src/index';
import { createWorkspaceStorage } from '../../packages/workspace/src/index';
import { GitDeliveryService } from '../../packages/workspace/src/git-delivery';
import { DeliveryGit } from '../../packages/workspace/src/git-delivery-git';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(directory: string, ...args: string[]) {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function fixture(options: { dirtyImport?: boolean; attributes?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-git-delivery-')));
  roots.push(root);
  const source = join(root, 'imported source');
  const dataRoot = join(root, 'data');
  const remote = join(root, 'trusted fixture.git');
  await mkdir(source);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(source, 'init', '--initial-branch=main');
  git(source, 'config', 'user.name', 'Fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  git(source, 'config', 'core.autocrlf', 'true');
  git(source, 'remote', 'add', 'origin', remote);
  await writeFile(join(source, 'existing.txt'), 'original\r\n');
  await writeFile(join(source, 'unchanged.txt'), 'unchanged\r\n');
  if (options.attributes) await writeFile(join(source, '.gitattributes'), options.attributes);
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Initial base');
  const base = git(source, 'rev-parse', 'HEAD').trim();
  git(source, 'push', 'origin', 'main');
  if (options.dirtyImport) await writeFile(join(source, 'existing.txt'), 'dirty base\r\n');
  const workspace = await createWorkspaceStorage(
    { name: 'Git fixture', sourcePath: source },
    dataRoot,
  );
  const timestamp = new Date().toISOString();
  const snapshot: ProjectSnapshot = {
    workspace,
    agents: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    events: [],
    requests: [],
    lastSequence: 0,
    commission: {
      id: 'commission-fixture',
      workspaceId: workspace.id,
      title: 'Git delivery fixture',
      goal: 'Deliver independently reviewed changes',
      status: 'accepted',
      criteria: [],
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
      createdAt: timestamp,
      updatedAt: timestamp,
      acceptedArtifactIds: [],
      summary: 'Accepted',
    },
  };
  async function accept(file: string, contents: string): Promise<Artifact> {
    await writeFile(join(workspace.workPath, file), contents);
    const artifact = await publishArtifact(dataRoot, workspace.workPath, file, {
      commissionId: snapshot.commission.id,
      taskId: 'author',
      name: file,
      mediaType: 'text/plain',
      inputVersions: [],
    });
    snapshot.artifacts.push(artifact);
    snapshot.commission.acceptedArtifactIds.push(artifact.id);
    snapshot.evidence.push({
      id: artifact.id,
      kind: 'review',
      status: 'passed',
      summary: 'Independent review',
      detail: '{}',
      artifactVersionIds: [artifact.versionId],
      createdAt: timestamp,
    });
    return artifact;
  }
  const openService = () => new GitDeliveryService(dataRoot, { localRemoteRoot: root });
  return { source, dataRoot, remote, base, snapshot, accept, openService, service: openService() };
}

describe('accepted Git feature-branch delivery', { timeout: 60_000 }, () => {
  it('publishes only immutable accepted bytes on the pinned remote base without touching the import', async () => {
    const f = await fixture();
    const existing = await f.accept('existing.txt', 'accepted update\r\n');
    const added = await f.accept('new file.txt', 'accepted addition\n');
    const unchanged = await f.accept('unchanged.txt', 'unchanged\r\n');
    await writeFile(join(f.snapshot.workspace.workPath, 'new file.txt'), 'unreviewed managed edit');
    await writeFile(join(f.source, 'local-commit.txt'), 'unpublished local commit');
    git(f.source, 'add', 'local-commit.txt');
    git(f.source, 'commit', '-m', 'Only local');
    await writeFile(join(f.source, 'existing.txt'), 'unreviewed original edit');
    await writeFile(join(f.source, 'staged.txt'), 'staged original edit');
    git(f.source, 'add', 'staged.txt');
    const before = git(f.source, 'status', '--porcelain=v1', '--branch');
    const beforeIndex = await readFile(join(f.source, '.git', 'index'));

    const preview = await f.service.prepare(f.snapshot);
    expect(preview).toMatchObject({
      baseBranch: 'main',
      baseCommit: f.base,
      revision: f.snapshot.commission.revision,
      acceptedVersionIds: [existing.versionId, added.versionId, unchanged.versionId].sort(),
    });
    expect(preview.targetBranch).toMatch(/^astrisle\//);
    expect(preview.diff).toContain('-original\n+accepted update\r\n');
    expect(preview.diff).toContain('+accepted addition\n');
    expect(preview.diff).not.toContain('unchanged.txt');
    expect(preview.diffTruncated).toBe(false);
    expect(preview.changes).toEqual([
      {
        path: 'existing.txt',
        action: 'modify',
        size: 17,
        artifactId: existing.id,
        versionId: existing.versionId,
      },
      {
        path: 'new file.txt',
        action: 'add',
        size: 18,
        artifactId: added.id,
        versionId: added.versionId,
      },
    ]);
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
    expect((await f.openService().latest(f.snapshot))?.status).toBe('prepared');

    const receipt = await f.openService().publish(f.snapshot, preview.operationId);
    expect(receipt).toMatchObject({ status: 'published', preview, compareUrl: null });
    expect(git(f.remote, 'rev-parse', preview.targetBranch).trim()).toBe(receipt.commit);
    expect(git(f.remote, 'rev-parse', `${preview.targetBranch}^`).trim()).toBe(f.base);
    expect(
      git(f.remote, 'diff-tree', '--no-commit-id', '--name-status', '-r', preview.targetBranch),
    ).toBe('M\texisting.txt\nA\tnew file.txt\n');
    expect(git(f.remote, 'show', `${preview.targetBranch}:existing.txt`)).toBe(
      'accepted update\r\n',
    );
    expect(git(f.remote, 'show', `${preview.targetBranch}:new file.txt`)).toBe(
      'accepted addition\n',
    );
    expect(git(f.remote, 'rev-parse', 'main').trim()).toBe(f.base);
    expect(git(f.source, 'status', '--porcelain=v1', '--branch')).toBe(before);
    expect(await readFile(join(f.source, '.git', 'index'))).toEqual(beforeIndex);
    expect(await readFile(join(f.source, 'existing.txt'), 'utf8')).toBe('unreviewed original edit');
    expect(await f.openService().inspect(f.snapshot, preview.operationId)).toEqual(receipt);
    expect(await f.openService().publish(f.snapshot, preview.operationId)).toEqual(receipt);
    expect(await f.openService().prepare(f.snapshot)).toEqual(preview);
    expect(await f.openService().latest(f.snapshot)).toEqual(receipt);
  });

  it('reuses one prepared operation for overlapping previews of the same acceptance', async () => {
    const f = await fixture();
    await f.accept('new.txt', 'candidate\n');
    const [first, second] = await Promise.all([
      f.service.prepare(f.snapshot),
      f.openService().prepare(f.snapshot),
    ]);
    expect(second).toEqual(first);
    expect((await f.openService().latest(f.snapshot))?.preview.operationId).toBe(first.operationId);
  });

  it('rejects an old confirmation after a changed acceptance creates a new preview', async () => {
    const f = await fixture();
    await f.accept('new.txt', 'candidate\n');
    const firstSnapshot = structuredClone(f.snapshot);
    const first = await f.service.prepare(f.snapshot);
    await f.accept('extra.txt', 'another accepted file\n');
    const latest = await f.openService().prepare(f.snapshot);
    expect(latest.operationId).not.toBe(first.operationId);
    await expect(f.service.publish(firstSnapshot, first.operationId)).rejects.toThrow(/预览/);
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
    expect((await f.openService().latest(f.snapshot))?.preview).toEqual(latest);
  });

  it('rejects versions lacking the acceptance or the passing review for those exact bytes', async () => {
    const f = await fixture();
    const artifact = await f.accept('existing.txt', 'candidate\n');
    f.snapshot.commission.acceptedArtifactIds = [];
    await expect(f.service.prepare(f.snapshot)).rejects.toThrow();
    f.snapshot.commission.acceptedArtifactIds = [artifact.id];
    f.snapshot.evidence[0].artifactVersionIds = ['a different reviewed version'];
    await expect(f.service.prepare(f.snapshot)).rejects.toThrow();
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
  });

  it('rejects tracked files whose imported baseline does not match the remote', async () => {
    const f = await fixture({ dirtyImport: true });
    await f.accept('existing.txt', 'candidate\n');
    await expect(f.service.prepare(f.snapshot)).rejects.toThrow(/existing\.txt/);
  });

  it('refuses additions covered by filters or working-tree encoding in the pinned base', async () => {
    const f = await fixture({
      attributes:
        '*.asset filter=lfs\n*.encoded working-tree-encoding=UTF-16LE\n*.custom filter=unspecified\n',
    });
    for (const path of ['new asset.asset', 'new file.encoded', 'new driver.custom']) {
      await f.accept(path, 'candidate\n');
      await expect(f.service.prepare(f.snapshot)).rejects.toThrow(/filter|working-tree-encoding/);
      f.snapshot.artifacts = [];
      f.snapshot.evidence = [];
      f.snapshot.commission.acceptedArtifactIds = [];
    }
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
  });

  it.each([
    {
      file: 'new.asset',
      bytes: 'accepted binary asset\n',
      attribute: 'filter',
      rule: 'filter=lfs',
    },
    {
      file: 'unchanged.txt',
      bytes: 'unchanged\r\n',
      attribute: 'working-tree-encoding',
      rule: 'working-tree-encoding=UTF-16LE',
    },
  ])(
    'rejects a $attribute rule introduced by the candidate for $file',
    async ({ file, bytes, attribute, rule }) => {
      const f = await fixture();
      await f.accept(file, bytes);
      await f.accept('.gitattributes', file + ' ' + rule + '\n');
      await expect(f.service.prepare(f.snapshot)).rejects.toThrow(attribute);
      expect(await f.service.latest(f.snapshot)).toBeNull();
      expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
        'refs/heads/main\n',
      );
    },
  );

  it('blocks a confirmation when the accepted revision or remote base has changed', async () => {
    const f = await fixture();
    await f.accept('existing.txt', 'candidate\n');
    const first = await f.service.prepare(f.snapshot);
    f.snapshot.commission.revision++;
    expect((await f.service.publish(f.snapshot, first.operationId)).status).toBe('blocked');
    const second = await f.service.prepare(f.snapshot);
    git(f.source, 'commit', '--allow-empty', '-m', 'Concurrent remote base');
    git(f.source, 'push', 'origin', 'main');
    expect((await f.openService().publish(f.snapshot, second.operationId)).status).toBe('blocked');
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
  });

  it('never replaces a destination branch that becomes occupied', async () => {
    const f = await fixture();
    await f.accept('new.txt', 'candidate\n');
    const preview = await f.service.prepare(f.snapshot);
    git(f.remote, 'update-ref', `refs/heads/${preview.targetBranch}`, f.base);
    expect((await f.openService().publish(f.snapshot, preview.operationId)).status).toBe('blocked');
    expect(git(f.remote, 'rev-parse', preview.targetBranch).trim()).toBe(f.base);
  });

  it('rechecks acceptance immediately before dispatch', async () => {
    const f = await fixture();
    await f.accept('new.txt', 'candidate\n');
    const preview = await f.service.prepare(f.snapshot);
    const latest = vi
      .fn()
      .mockReturnValueOnce(f.snapshot)
      .mockReturnValue({
        ...f.snapshot,
        commission: { ...f.snapshot.commission, status: 'active' },
      });
    expect((await f.service.publish(f.snapshot, preview.operationId, latest)).status).toBe(
      'blocked',
    );
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
  });

  it('recovers a completed push when confirmation was interrupted before saving the receipt', async () => {
    const f = await fixture();
    await f.accept('new.txt', 'candidate\n');
    const preview = await f.service.prepare(f.snapshot);
    const refs = DeliveryGit.prototype.refs;
    let reads = 0;
    const connection = vi.spyOn(DeliveryGit.prototype, 'refs').mockImplementation(function (
      this: DeliveryGit,
      ...args: Parameters<typeof refs>
    ) {
      if (++reads === 3) return Promise.reject(new Error('Connection interrupted'));
      return refs.apply(this, args);
    });
    expect((await f.service.publish(f.snapshot, preview.operationId)).status).toBe('unknown');
    connection.mockRejectedValue(new Error('Connection interrupted'));
    expect(await f.openService().prepare(f.snapshot)).toEqual(preview);
    expect((await f.openService().latest(f.snapshot))?.status).toBe('unknown');
    const beforeNewAcceptance = structuredClone(f.snapshot);
    await f.accept('extra.txt', 'another accepted file\n');
    await expect(f.openService().prepare(f.snapshot)).rejects.toThrow(/核查/);
    expect((await f.openService().latest(f.snapshot))?.preview).toEqual(preview);
    connection.mockRestore();
    const actualCommit = git(f.remote, 'rev-parse', preview.targetBranch).trim();
    const recovered = await f.openService().inspect(f.snapshot, preview.operationId);
    expect(recovered).toMatchObject({ status: 'published', commit: actualCommit });
    expect(await f.openService().publish(beforeNewAcceptance, preview.operationId)).toEqual(
      recovered,
    );
    const replacement = await f.openService().prepare(f.snapshot);
    expect(replacement.operationId).not.toBe(preview.operationId);
    await expect(f.openService().publish(f.snapshot, preview.operationId)).rejects.toThrow(/预览/);

    git(f.remote, 'update-ref', 'refs/heads/' + preview.targetBranch, f.base);
    expect(await f.openService().inspect(f.snapshot, preview.operationId)).toEqual(recovered);
    expect(git(f.remote, 'rev-parse', preview.targetBranch).trim()).toBe(f.base);
  });

  it('shows native binary file changes and truncates long textual diffs', async () => {
    const f = await fixture();
    await f.accept('binary.dat', 'bytes\0\xff');
    await f.accept('long.txt', '文本行\n'.repeat(50_000));
    const preview = await f.service.prepare(f.snapshot);
    expect(preview.changes.map((change) => change.path)).toEqual(['binary.dat', 'long.txt']);
    expect(preview.diff).toContain('Binary files /dev/null and b/binary.dat differ');
    expect(preview.diff).toContain('+文本行\n');
    expect(preview.diff).not.toContain('\ufffd');
    expect(Buffer.byteLength(preview.diff)).toBeLessThanOrEqual(48 * 1024);
    expect(preview.diffTruncated).toBe(true);
  });

  it('preserves an interrupted push after restart while a changed acceptance makes preflight stale', async () => {
    const f = await fixture();
    await f.accept('new.txt', 'candidate\n');
    const preview = await f.service.prepare(f.snapshot);
    const interrupted = vi
      .spyOn(DeliveryGit.prototype, 'push')
      .mockRejectedValue(new Error('Push interrupted'));
    expect((await f.service.publish(f.snapshot, preview.operationId)).status).toBe('unknown');
    interrupted.mockRestore();

    await f.accept('extra.txt', 'another accepted file\n');
    expect((await f.openService().publish(f.snapshot, preview.operationId)).status).toBe('unknown');
    await expect(f.openService().prepare(f.snapshot)).rejects.toThrow(/核查/);
    expect(await f.openService().latest(f.snapshot)).toMatchObject({ status: 'unknown', preview });
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
  });

  it('refuses embedded credentials, alternate transports, and unconfigured local remotes', async () => {
    const f = await fixture();
    await f.accept('existing.txt', 'candidate\n');
    await expect(new GitDeliveryService(f.dataRoot).prepare(f.snapshot)).rejects.toThrow();
    git(f.source, 'remote', 'set-url', 'origin', 'ext::unexpected command');
    await expect(f.service.prepare(f.snapshot)).rejects.toThrow();
    git(
      f.source,
      'remote',
      'set-url',
      'origin',
      'https://synthetic-token@github.com/example/project.git',
    );
    await expect(f.service.prepare(f.snapshot)).rejects.toThrow(/^[^\n]*$/);
    await expect(f.service.prepare(f.snapshot)).rejects.not.toThrow(/synthetic-token/);
  });
});
