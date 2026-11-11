import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceStorage,
  createTaskWorkspace,
  integrateTaskWorkspace,
  exportWorkspace,
  prepareWorkspaceApply,
  applyWorkspace,
} from '../../packages/workspace/src/index';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'astrisle-workspace-')));
  roots.push(root);
  const source = join(root, 'source');
  await fs.mkdir(join(source, '.git'), { recursive: true });
  await fs.writeFile(join(source, '.git', 'HEAD'), 'unchanged');
  await fs.writeFile(join(source, 'dirty.txt'), 'dirty input');
  return { root, source };
}

describe('independent managed workspace', () => {
  it('imports dirty files without touching source git metadata and exports every surviving file', async () => {
    const { root, source } = await fixture();
    const workspace = await createWorkspaceStorage(
      { name: 'import', sourcePath: source },
      join(root, 'data'),
    );
    expect(await fs.readFile(join(workspace.workPath, 'dirty.txt'), 'utf8')).toBe('dirty input');
    expect(await fs.readFile(join(source, '.git', 'HEAD'), 'utf8')).toBe('unchanged');
    await expect(fs.stat(join(workspace.workPath, '.git'))).rejects.toThrow();
    await exportWorkspace(workspace, join(root, 'export'));
    expect(await fs.readFile(join(root, 'export', 'dirty.txt'), 'utf8')).toBe('dirty input');
  });
  it('integrates only task changes and detects common-base conflicts before any writes', async () => {
    const { root, source } = await fixture();
    const workspace = await createWorkspaceStorage(
      { name: 'import', sourcePath: source },
      join(root, 'data'),
    );
    const task = await createTaskWorkspace(workspace, 'task1');
    await fs.writeFile(join(task, 'new.txt'), 'new');
    await fs.writeFile(join(workspace.workPath, 'unrelated.txt'), 'keep');
    expect((await integrateTaskWorkspace(workspace, task)).ok).toBe(true);
    expect(await fs.readFile(join(workspace.workPath, 'unrelated.txt'), 'utf8')).toBe('keep');
    const task2 = await createTaskWorkspace(workspace, 'task2');
    await fs.writeFile(join(task2, 'dirty.txt'), 'task');
    await fs.writeFile(join(workspace.workPath, 'dirty.txt'), 'external');
    expect((await integrateTaskWorkspace(workspace, task2)).conflicts).toContain('dirty.txt');
    expect(await fs.readFile(join(workspace.workPath, 'dirty.txt'), 'utf8')).toBe('external');
  });
  it('supports empty projects and disabled safe apply never mutates originals', async () => {
    const { root, source } = await fixture();
    const empty = await createWorkspaceStorage({ name: 'empty' }, join(root, 'data'));
    expect(await fs.readdir(empty.workPath)).toEqual([]);
    const imported = await createWorkspaceStorage(
      { name: 'import', sourcePath: source },
      join(root, 'data'),
    );
    await fs.writeFile(join(imported.workPath, 'dirty.txt'), 'candidate');
    const preview = await prepareWorkspaceApply(imported);
    expect(preview.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'dirty.txt', action: 'modify' })]),
    );
    expect(preview.supported).toBe(false);
    expect((await applyWorkspace(preview.operationId)).ok).toBe(false);
    expect(await fs.readFile(join(source, 'dirty.txt'), 'utf8')).toBe('dirty input');
  });
  it('preserves unchanged files while integrating deletions and tolerates repeated integration', async () => {
    const { root, source } = await fixture();
    await fs.writeFile(join(source, 'keep.txt'), 'keep');
    const workspace = await createWorkspaceStorage(
      { name: 'import', sourcePath: source },
      join(root, 'data'),
    );
    const task = await createTaskWorkspace(workspace, 'delete');
    await fs.unlink(join(task, 'dirty.txt'));
    const integrated = await integrateTaskWorkspace(workspace, task);
    expect(integrated.ok).toBe(true);
    expect(integrated.files).toContain('dirty.txt');
    expect(await fs.readFile(join(workspace.workPath, 'keep.txt'), 'utf8')).toBe('keep');
    expect((await integrateTaskWorkspace(workspace, task)).ok).toBe(true);
    await expect(fs.stat(join(workspace.workPath, 'dirty.txt'))).rejects.toThrow();
  });
});
