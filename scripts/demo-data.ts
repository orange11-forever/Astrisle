import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { CharacterStore, validateCharacterModel } from '../apps/desktop/src/characters';
import type { CharacterId, CharacterModel } from '../packages/contracts/src/index';
import {
  characterResourcePath,
  MAX_CHARACTER_STORED_BYTES,
} from '../packages/contracts/src/character-asset';
import { assertPlainPath } from '../packages/executor/src/path-guard';

const formats = new Set(['glb', 'gltf', '3mf', 'stl', 'obj', 'fbx']);

async function readBounded(path: string, limit: number, expectedLength?: number): Promise<Buffer> {
  await assertPlainPath(path);
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > limit ||
      (expectedLength !== undefined && stat.size !== expectedLength)
    )
      throw new Error('文件类型或长度与记录不符');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('读取期间文件长度发生变化');
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function characterSnapshot(bytes: Buffer): string {
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (Array.isArray(data?.characters)) {
    for (const profile of data.characters) {
      const model = profile?.model;
      if (model?.format !== undefined || typeof model?.filename !== 'string') continue;
      const format = extname(model.filename).slice(1).toLowerCase();
      // Older imports may omit the format; their saved filename identifies it unambiguously.
      if (formats.has(format)) model.format = format;
    }
  }
  return JSON.stringify(data, null, 2);
}

function verifyFormat(bytes: Buffer, format: CharacterModel['format']): void {
  if (format === 'glb' || format === 'gltf') {
    validateCharacterModel(bytes, `model.${format}`);
    return;
  }
  if (!bytes.subarray(0, 28).toString('ascii').startsWith('{"astrisleCharacterAsset":'))
    throw new Error('角色资源包标记无效');
  const bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    bundle?.astrisleCharacterAsset !== 1 ||
    bundle.format !== format ||
    typeof bundle.entry !== 'string' ||
    extname(bundle.entry).slice(1).toLowerCase() !== format ||
    !bundle.files ||
    typeof bundle.files !== 'object' ||
    Array.isArray(bundle.files) ||
    Object.keys(bundle.files).length > 256 ||
    !Object.hasOwn(bundle.files, bundle.entry) ||
    typeof bundle.files[bundle.entry] !== 'string' ||
    !bundle.files[bundle.entry]
  )
    throw new Error('角色资源包与记录的格式不符');
  Object.keys(bundle.files).forEach(characterResourcePath);
}

/** Only this process's temporary pending snapshot can be removed by cleanup. */
export async function prepareDemoData(sourceRoot: string, temporaryParent = tmpdir()) {
  let source: string;
  let snapshot: string;
  try {
    source = await realpath(sourceRoot);
    snapshot = characterSnapshot(await readBounded(join(source, 'characters.json'), 64 * 1024));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(
      missing
        ? `未找到当前角色配置 characters.json（${sourceRoot}）。请检查 ASTRISLE_DATA_ROOT 或先保存角色设置。`
        : '无法读取当前角色配置 characters.json。',
      { cause: error },
    );
  }
  const parent = await realpath(temporaryParent);
  const root = await realpath(await mkdtemp(join(parent, 'astrisle-demo-')));
  const owner = await lstat(root, { bigint: true });
  async function cleanup() {
    let current;
    try {
      current = await lstat(root, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const actual = await realpath(root);
    if (
      dirname(actual) !== parent ||
      actual !== root ||
      !current.isDirectory() ||
      current.dev !== owner.dev ||
      current.ino !== owner.ino
    )
      throw new Error('临时演示目录已变更，已停止自动清理');
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
  try {
    await writeFile(join(root, 'characters.json'), snapshot, { flag: 'wx', mode: 0o600 });
    const profiles = await new CharacterStore(root).profiles().catch((error) => {
      throw new Error('当前 characters.json 与 Astrisle 角色配置格式不符。', { cause: error });
    });
    const expected: Record<CharacterId, string> = {
      mori: 'builtin',
      luma: 'builtin',
      user: 'builtin',
    };
    const copied = new Map<string, CharacterModel>();
    const assets = join(root, 'character-assets');
    for (const profile of profiles) {
      const model = profile.model;
      if (!model) continue;
      try {
        const previous = copied.get(model.assetId);
        if (
          previous &&
          (previous.format !== model.format || previous.byteLength !== model.byteLength)
        )
          throw new Error('共享模型的格式或长度不一致');
        if (!previous) {
          const filename = `${model.assetId}.${model.format}`;
          const bytes = await readBounded(
            join(source, 'character-assets', filename),
            MAX_CHARACTER_STORED_BYTES,
            model.byteLength,
          );
          if (createHash('sha256').update(bytes).digest('hex') !== model.assetId)
            throw new Error('实际 SHA-256 与角色资产 ID 不一致');
          verifyFormat(bytes, model.format);
          await mkdir(assets, { recursive: true });
          await writeFile(join(assets, filename), bytes, { flag: 'wx', mode: 0o600 });
          copied.set(model.assetId, model);
        }
        expected[profile.id] = model.assetId;
      } catch (error) {
        const reason =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? '模型文件不存在'
            : (error as Error).message;
        throw new Error(
          `角色 ${profile.id} 的已配置 ${model.format.toUpperCase()} 模型无法用于演示：${reason}`,
          { cause: error },
        );
      }
    }
    return { root, expected, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
