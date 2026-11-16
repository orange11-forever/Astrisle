import { inflateSync } from 'node:zlib';
import { MAX_CHARACTER_SOURCE_BYTES } from '../../../packages/contracts/src/character-asset';

/** Bound binary nodes and compressed arrays before Three's browser parser allocates them. */
export function preflightFbx(bytes: Buffer): string[] {
  if (bytes.subarray(0, 18).toString() !== 'Kaydara FBX Binary')
    return [
      ...bytes
        .toString('utf8')
        .matchAll(/\b(?:RelativeFilename|FileName|Filename):\s*"([^"\r\n]+)"/g),
    ].map((match) => match[1]);
  function valid(condition: unknown): asserts condition {
    if (!condition) throw new Error('FBX 二进制节点或数组无效，解压后须在 100 MB 以内');
  }
  valid(bytes.length >= 27);
  const version = bytes.readUInt32LE(23),
    wide = version >= 7500;
  valid(version >= 6400 && version <= 7700);
  const header = wide ? 25 : 13;
  let decoded = 0,
    nodes = 0;
  const refs: string[] = [];
  const number = (at: number) =>
    wide ? Number(bytes.readBigUInt64LE(at)) : bytes.readUInt32LE(at);
  function node(start: number, parentEnd: number, depth: number): number {
    valid(depth < 200 && ++nodes <= 100_000 && start + header <= parentEnd);
    const end = number(start);
    if (!end) return start + header;
    const count = number(start + (wide ? 8 : 4));
    const length = number(start + (wide ? 16 : 8));
    const nameLength = bytes[start + header - 1];
    const name = bytes.subarray(start + header, start + header + nameLength).toString('utf8');
    let at = start + header + nameLength;
    const propertyEnd = at + length;
    valid(
      Number.isSafeInteger(end) &&
        end > start &&
        end <= parentEnd &&
        propertyEnd <= end &&
        count <= length,
    );
    for (let i = 0; i < count; i++) {
      valid(at < propertyEnd);
      const type = String.fromCharCode(bytes[at++]);
      const scalar: Record<string, number> = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
      if (scalar[type]) at += scalar[type];
      else if (type === 'S' || type === 'R') {
        valid(at + 4 <= propertyEnd);
        const size = bytes.readUInt32LE(at);
        at += 4;
        valid(at + size <= propertyEnd);
        if (type === 'S' && ['RelativeFilename', 'FileName', 'Filename'].includes(name)) {
          valid(size <= 4096);
          refs.push(bytes.subarray(at, at + size).toString('utf8'));
        }
        at += size;
      } else {
        const width: Record<string, number> = { b: 1, c: 1, d: 8, f: 4, i: 4, l: 8 };
        valid(width[type] && at + 12 <= propertyEnd);
        const size = bytes.readUInt32LE(at) * width[type];
        const encoding = bytes.readUInt32LE(at + 4),
          compressed = bytes.readUInt32LE(at + 8);
        at += 12;
        decoded += size;
        valid(decoded <= MAX_CHARACTER_SOURCE_BYTES && (encoding === 0 || encoding === 1));
        if (encoding === 0) at += size;
        else {
          valid(compressed > 0 && at + compressed <= propertyEnd);
          try {
            valid(
              inflateSync(bytes.subarray(at, at + compressed), { maxOutputLength: size + 1 })
                .length === size,
            );
          } catch {
            valid(false);
          }
          at += compressed;
        }
      }
      valid(at <= propertyEnd);
    }
    valid(at === propertyEnd);
    while (at < end) at = node(at, end, depth + 1);
    valid(at === end);
    return at;
  }
  let at = 27;
  while (at + 176 < bytes.length) at = node(at, bytes.length, 0);
  valid(nodes > 0);
  return refs;
}
