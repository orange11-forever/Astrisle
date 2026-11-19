import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
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

type ReadFailure = 'missing-version' | 'read-failed' | 'integrity-mismatch' | 'input-limit';

export async function readVerifiedFile(
  path: string,
  digest: unknown,
  limit: number,
  expectedSize?: number,
): Promise<Buffer | ReadFailure> {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return 'integrity-mismatch';
  try {
    const flags =
      process.platform === 'win32'
        ? 'r'
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const file = await open(path, flags);
    try {
      const info = await file.stat();
      if (!info.isFile()) return 'read-failed';
      if (expectedSize !== undefined && info.size !== expectedSize) return 'integrity-mismatch';
      if (info.size > limit) return 'input-limit';
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      return length === info.size && hash(bytes) === digest ? bytes : 'integrity-mismatch';
    } finally {
      await file.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-version' : 'read-failed';
  }
}

export function readVersionBytes(dataRoot: string, artifact: Artifact, limit: number) {
  if (
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0
  )
    return Promise.resolve('integrity-mismatch' as const);
  return readVerifiedFile(
    blobPath(dataRoot, artifact.sha256),
    artifact.sha256,
    limit,
    artifact.size,
  );
}
