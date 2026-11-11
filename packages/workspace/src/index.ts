import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  NewWorkspaceInput,
  Workspace,
  ApplyPreview,
  ApplyChange,
  CommandResult,
} from '../../contracts/src/index';
import { assertPlainPath, contained, validatePath } from '../../executor/src/path-guard';

type Manifest = {
  schemaVersion: 1;
  files: Record<string, string>;
  excluded: string[];
  createdAt: string;
  workspaceId: string;
};
const excluded = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  '.cache',
  'dist',
  'build',
]);
const locks = new Map<string, Promise<unknown>>();
const previews = new Map<string, ApplyPreview>();
const MAX_FILES = 20000,
  MAX_FILE = 32 * 1024 * 1024,
  MAX_TOTAL = 256 * 1024 * 1024;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const metaRoot = (workspace: Workspace) => path.dirname(workspace.workPath);

async function scan(root: string, workspaceId: string): Promise<Manifest> {
  await assertPlainPath(root);
  const files: Record<string, string> = {},
    omitted: string[] = [];
  let total = 0;
  async function visit(directory: string) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(directory, entry.name),
        relative = path.relative(root, full).split(path.sep).join('/');
      validatePath(relative);
      await assertPlainPath(full);
      if (excluded.has(entry.name)) {
        omitted.push(relative);
        continue;
      }
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const st = await fs.stat(full);
        total += st.size;
        if (st.size > MAX_FILE || total > MAX_TOTAL || Object.keys(files).length >= MAX_FILES)
          throw new Error('Workspace import exceeds the supported size limit');
        files[relative] = hash(await fs.readFile(full));
      } else throw new Error(`Unsupported filesystem entry: ${relative}`);
    }
  }
  await visit(root);
  return {
    schemaVersion: 1,
    files,
    excluded: omitted,
    workspaceId,
    createdAt: new Date().toISOString(),
  };
}
async function readManifest(file: string): Promise<Manifest> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Manifest;
}
async function copyFiles(source: string, target: string, manifest: Manifest) {
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const from = path.join(source, relative),
      to = path.join(target, relative);
    await assertPlainPath(from);
    await assertPlainPath(to, true);
    const bytes = await fs.readFile(from);
    if (hash(bytes) !== expected) throw new Error(`Source changed during copy: ${relative}`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await assertPlainPath(to, true);
    await fs.writeFile(to, bytes, { flag: 'wx' });
  }
}
function changes(base: Manifest, next: Manifest): ApplyChange[] {
  return [...new Set([...Object.keys(base.files), ...Object.keys(next.files)])]
    .sort()
    .filter((p) => base.files[p] !== next.files[p])
    .map((p) => ({
      path: p,
      action: !base.files[p] ? 'create' : !next.files[p] ? 'delete' : 'modify',
      beforeHash: base.files[p],
      afterHash: next.files[p],
    }));
}
async function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
  const preceding = locks.get(id) || Promise.resolve();
  const current = preceding.catch(() => {}).then(action);
  locks.set(id, current);
  try {
    return await current;
  } finally {
    if (locks.get(id) === current) locks.delete(id);
  }
}

export async function createWorkspaceStorage(
  input: NewWorkspaceInput,
  dataRoot: string,
): Promise<Workspace> {
  if (!input.name?.trim() || input.name.length > 200)
    throw new Error('A workspace name of 1–200 characters is required');
  const id = randomUUID(),
    root = path.resolve(dataRoot, 'workspaces', id),
    workPath = path.join(root, 'work');
  const sourcePath = input.sourcePath ? path.resolve(input.sourcePath) : '';
  if (sourcePath) {
    validatePath(input.sourcePath!);
    await assertPlainPath(sourcePath);
    if (!(await fs.stat(sourcePath)).isDirectory())
      throw new Error('Import source must be a directory');
    if (contained(sourcePath, root))
      throw new Error('Data directory must not be inside the import source');
  }
  await assertPlainPath(root, true);
  await fs.mkdir(workPath, { recursive: true });
  try {
    const baseline = sourcePath
      ? await scan(sourcePath, id)
      : {
          schemaVersion: 1 as const,
          files: {},
          excluded: [],
          workspaceId: id,
          createdAt: new Date().toISOString(),
        };
    if (sourcePath) await copyFiles(sourcePath, workPath, baseline);
    await fs.writeFile(path.join(root, 'baseline.json'), JSON.stringify(baseline, null, 2), {
      flag: 'wx',
    });
    return {
      id,
      name: input.name.trim(),
      sourcePath,
      workPath,
      createdAt: new Date().toISOString(),
    };
  } catch (e) {
    await fs.rm(root, { recursive: true, force: true });
    throw e;
  }
}

export async function createTaskWorkspace(workspace: Workspace, taskId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error('Invalid task ID');
  return exclusive(workspace.id, async () => {
    const root = path.join(metaRoot(workspace), 'tasks', taskId),
      work = path.join(root, 'work');
    await assertPlainPath(root, true);
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(work); // a repeated ID must never reuse a dirty task directory
    const baseline = await scan(workspace.workPath, workspace.id);
    await copyFiles(workspace.workPath, work, baseline);
    await fs.writeFile(path.join(root, 'baseline.json'), JSON.stringify(baseline), { flag: 'wx' });
    return work;
  });
}

/** Read-only inventory. Integration can require this exact inventory under its own lock. */
export async function previewTaskWorkspaceChanges(
  workspace: Workspace,
  taskPath: string,
): Promise<ApplyChange[]> {
  return exclusive(workspace.id, async () => {
    const full = path.resolve(taskPath),
      tasks = path.join(metaRoot(workspace), 'tasks');
    if (
      !contained(tasks, full) ||
      path.basename(full) !== 'work' ||
      path.dirname(path.dirname(full)) !== tasks
    )
      throw new Error('Task path is not managed by this workspace');
    await assertPlainPath(full);
    const base = await readManifest(path.join(path.dirname(full), 'baseline.json'));
    if (base.workspaceId !== workspace.id)
      throw new Error('Task baseline belongs to another workspace');
    return changes(base, await scan(full, workspace.id));
  });
}

export async function integrateTaskWorkspace(
  workspace: Workspace,
  taskPath: string,
  expectedChanges?: ApplyChange[],
): Promise<{ ok: boolean; conflicts: string[]; files: string[] }> {
  return exclusive(workspace.id, async () => {
    const full = path.resolve(taskPath),
      tasks = path.join(metaRoot(workspace), 'tasks');
    if (
      !contained(tasks, full) ||
      path.basename(full) !== 'work' ||
      path.dirname(path.dirname(full)) !== tasks
    )
      throw new Error('Task path is not managed by this workspace');
    await assertPlainPath(full);
    const base = await readManifest(path.join(path.dirname(full), 'baseline.json'));
    if (base.workspaceId !== workspace.id)
      throw new Error('Task baseline belongs to another workspace');
    const next = await scan(full, workspace.id),
      current = await scan(workspace.workPath, workspace.id),
      delta = changes(base, next);
    if (expectedChanges && JSON.stringify(delta) !== JSON.stringify(expectedChanges))
      return {
        ok: false,
        conflicts: ['Task change inventory changed after publication validation'],
        files: [],
      };
    const conflicts = delta
      .filter(
        (c) =>
          current.files[c.path] !== base.files[c.path] &&
          current.files[c.path] !== next.files[c.path],
      )
      .map((c) => c.path);
    if (conflicts.length) return { ok: false, conflicts, files: [] };
    // Stage every changed candidate before touching the managed integration tree.
    const staged = new Map<string, Buffer>();
    for (const change of delta)
      if (change.action !== 'delete') {
        const input = path.join(full, change.path);
        await assertPlainPath(input);
        const bytes = await fs.readFile(input);
        if (hash(bytes) !== next.files[change.path])
          throw new Error('Task changed during integration');
        staged.set(change.path, bytes);
      }
    const rechecked = await scan(workspace.workPath, workspace.id);
    const raced = delta
      .filter((c) => rechecked.files[c.path] !== current.files[c.path])
      .map((c) => c.path);
    if (raced.length) return { ok: false, conflicts: raced, files: [] };
    for (const change of delta) {
      if (current.files[change.path] === next.files[change.path]) continue;
      const output = path.join(workspace.workPath, change.path);
      await assertPlainPath(output, true);
      if (change.action === 'delete') await fs.unlink(output);
      else {
        await fs.mkdir(path.dirname(output), { recursive: true });
        await assertPlainPath(output, true);
        await fs.writeFile(output, staged.get(change.path)!);
      }
    }
    return { ok: true, conflicts: [], files: delta.map((c) => c.path) };
  });
}

export async function exportWorkspace(workspace: Workspace, destination: string): Promise<void> {
  validatePath(destination);
  const target = path.resolve(destination);
  await assertPlainPath(target, true);
  if (contained(workspace.workPath, target) || contained(target, workspace.workPath))
    throw new Error('Export destination overlaps the managed workspace');
  // Exclusive directory creation protects existing user files, including empty directories.
  await fs.mkdir(target);
  const manifest = await scan(workspace.workPath, workspace.id);
  await copyFiles(workspace.workPath, target, manifest);
}

export async function prepareWorkspaceApply(workspace: Workspace): Promise<ApplyPreview> {
  const baseline = await readManifest(path.join(metaRoot(workspace), 'baseline.json')),
    candidate = await scan(workspace.workPath, workspace.id);
  let conflicts: string[] = [];
  if (workspace.sourcePath) {
    const current = await scan(workspace.sourcePath, workspace.id);
    conflicts = changes(baseline, candidate)
      .filter((c) => current.files[c.path] !== baseline.files[c.path])
      .map((c) => c.path);
  }
  const preview: ApplyPreview = {
    operationId: randomUUID(),
    changes: changes(baseline, candidate),
    conflicts,
    supported: false,
    reason:
      'Windows locked-write helper has not passed concurrent external-write and crash-recovery verification. Export to a new directory is available; the original project is untouched.',
  };
  previews.set(preview.operationId, preview);
  return preview;
}
export async function applyWorkspace(operationId: string): Promise<CommandResult> {
  const preview = previews.get(operationId);
  return {
    ok: false,
    code: preview ? 'SAFE_APPLY_UNAVAILABLE' : 'UNKNOWN_OPERATION',
    message: preview?.reason || 'Unknown or expired apply preview; prepare a new preview.',
  };
}
