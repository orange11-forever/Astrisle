import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Artifact } from '../../contracts/src/index';
export function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function blobPath(dataRoot: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid blob digest');
  return join(dataRoot, 'blobs', digest.slice(0, 2), digest);
}
export async function publishArtifact(
  dataRoot: string,
  workPath: string,
  file: string,
  details: Pick<Artifact, 'commissionId' | 'taskId' | 'name' | 'mediaType' | 'inputVersions'>,
): Promise<Artifact> {
  const base = await realpath(workPath),
    path = await realpath(resolve(base, file)),
    rel = relative(base, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !(await stat(path)).isFile())
    throw new Error('Artifact must be a regular file inside the task workspace');
  const bytes = await readFile(path);
  const digest = hash(bytes),
    dest = blobPath(dataRoot, digest);
  await mkdir(dirname(dest), {
    recursive: true,
  });
  try {
    const fd = await open(dest, 'wx', 0o444);
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (hash(await readFile(dest)) !== digest) throw new Error('Artifact blob verification failed');
  return {
    id: randomUUID(),
    versionId: randomUUID(),
    ...details,
    relativePath: rel.replaceAll('\\', '/'),
    sha256: digest,
    size: bytes.length,
    createdAt: new Date().toISOString(),
    validity: 'current',
  };
}
export async function readArtifact(dataRoot: string, artifact: Artifact): Promise<Buffer> {
  const bytes = await readFile(blobPath(dataRoot, artifact.sha256));
  if (hash(bytes) !== artifact.sha256) throw new Error('Artifact hash mismatch');
  return bytes;
}
