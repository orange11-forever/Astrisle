import * as fs from 'node:fs/promises';
import path from 'node:path';

export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function contained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export function validatePath(value: string): void {
  if (
    !value ||
    value.length > 2048 ||
    /[\x00-\x1f]/.test(value) ||
    value.split(/[\\/]/).some((p) => p === '..')
  )
    throw new ToolError('PATH_DENIED', 'Invalid path or parent traversal');
  if (process.platform === 'win32') {
    if (/^(\\\\|\/\/|\\\?\\)/.test(value))
      throw new ToolError('PATH_DENIED', 'UNC and device paths are not supported');
    const withoutDrive = value.replace(/^[A-Za-z]:[\\/]/, '');
    if (
      withoutDrive.includes(':') ||
      withoutDrive
        .split(/[\\/]/)
        .some(
          (p) =>
            p !== '.' && (/[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p)),
        )
    )
      throw new ToolError('PATH_DENIED', 'Ambiguous Windows path');
  }
}
/** Reject symlinks/junctions in every existing segment, including the grant root. */
export async function assertPlainPath(candidate: string, writing = false): Promise<void> {
  const full = path.resolve(candidate),
    parsed = path.parse(full);
  let segment = parsed.root;
  for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    segment = path.join(segment, part);
    try {
      const st = await fs.lstat(segment);
      if (st.isSymbolicLink())
        throw new ToolError('PATH_DENIED', 'Symbolic links and junctions are not supported');
      if (writing && st.isFile() && st.nlink > 1)
        throw new ToolError('PATH_DENIED', 'Writing hard-linked files is not supported');
      const canonical = await fs.realpath(segment);
      if (path.relative(segment, canonical) !== '')
        throw new ToolError('PATH_DENIED', 'Reparsed path is not supported');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw e;
    }
  }
}
export async function guardPath(
  value: string,
  context: { workPath: string; scope: { readRoots: string[]; writeRoots: string[] } },
  writing: boolean,
): Promise<string> {
  validatePath(value);
  const target = path.resolve(context.workPath, value);
  const roots = writing ? context.scope.writeRoots : [context.workPath, ...context.scope.readRoots];
  if (
    !roots.some((root) => contained(root, target)) ||
    (writing && !contained(context.workPath, target))
  )
    throw new ToolError('SCOPE_DENIED', 'Path is outside the authorized task workspace');
  await assertPlainPath(target, writing);
  return target;
}
