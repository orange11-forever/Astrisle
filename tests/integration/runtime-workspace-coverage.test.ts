import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createTaskWorkspace,
  createWorkspaceStorage,
  integrateTaskWorkspace,
  previewTaskWorkspaceChanges,
} from '../../packages/workspace/src/index';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('previews task changes without integrating and rejects files added after that inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astrisle-inventory-'));
  roots.push(root);
  const workspace = await createWorkspaceStorage({ name: 'Inventory race' }, root);
  const task = await createTaskWorkspace(workspace, 'author');
  await writeFile(join(task, 'published.txt'), 'published bytes');
  const inventory = await previewTaskWorkspaceChanges(workspace, task);
  expect(inventory).toEqual([expect.objectContaining({ path: 'published.txt', action: 'create' })]);
  expect(await readdir(workspace.workPath)).toEqual([]);
  await writeFile(join(task, 'unpublished.ts'), 'late unreviewed bytes');
  expect((await integrateTaskWorkspace(workspace, task, inventory)).ok).toBe(false);
  expect(await readdir(workspace.workPath)).toEqual([]);
});
it('rechecks exact candidate hashes before committing a previously inventoried change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astrisle-inventory-'));
  roots.push(root);
  const workspace = await createWorkspaceStorage({ name: 'Hash race' }, root);
  const task = await createTaskWorkspace(workspace, 'author');
  await writeFile(join(task, 'published.txt'), 'published bytes');
  const inventory = await previewTaskWorkspaceChanges(workspace, task);
  await writeFile(join(task, 'published.txt'), 'late mutation');
  expect((await integrateTaskWorkspace(workspace, task, inventory)).ok).toBe(false);
  await expect(readFile(join(workspace.workPath, 'published.txt'))).rejects.toThrow();
});
