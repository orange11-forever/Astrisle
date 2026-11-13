import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_CHARACTERS } from '@astrisle/contracts';
import type { CharacterModel, CharacterProfile } from '@astrisle/contracts';

const MAX_MODEL_BYTES = 100 * 1024 * 1024;
const idSchema = z.enum(['mori', 'luma', 'user']);
const nameSchema = z
  .string()
  .trim()
  .refine(
    (value) => [...value].length >= 1 && [...value].length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(value),
    '角色名称须为 1–40 个字符，不能包含控制字符',
  );
const assetIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const updateSchema = z
  .object({
    displayName: nameSchema.optional(),
    resetModel: z.boolean().optional(),
    rotationY: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  })
  .strict();
const modelSchema = z
  .object({
    assetId: assetIdSchema,
    filename: z.string().min(1).max(255),
    format: z.enum(['glb', 'gltf']),
    byteLength: z.number().int().min(1).max(MAX_MODEL_BYTES),
    triangleCount: z.number().int().nonnegative(),
    animationCount: z.number().int().nonnegative(),
    hasSkins: z.boolean(),
  })
  .strict();
const profileSchema = z
  .object({
    id: idSchema,
    displayName: nameSchema,
    model: modelSchema.optional(),
    modelRevision: z.number().int().nonnegative().optional(),
    rotationY: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  })
  .strict();

// Decoder-dependent formats are intentionally rejected; the renderer never downloads decoders.
const compressed = new Set([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
  'KHR_texture_basisu',
]);
const extensions = new Set([
  'KHR_lights_punctual',
  'KHR_materials_clearcoat',
  'KHR_materials_dispersion',
  'KHR_materials_ior',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_iridescence',
  'KHR_materials_anisotropy',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'KHR_materials_emissive_strength',
  'EXT_materials_bump',
  'EXT_texture_webp',
  'EXT_texture_avif',
  'EXT_mesh_gpu_instancing',
]);
type Json = Record<string, any>;
function requireValid(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`无效的 glTF 2 模型：${detail}`);
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function embeddedData(uri: unknown): Buffer {
  requireValid(typeof uri === 'string', '资源必须内嵌 (embedded)');
  const match =
    /^data:(application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp|avif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      uri,
    );
  requireValid(
    match && match[2].length > 0,
    '仅支持内嵌 (embedded) 缓冲区和 PNG/JPEG/WebP/AVIF 图片；请重新导出自包含 GLB',
  );
  return Buffer.from(match[2], 'base64');
}
function scanResources(value: unknown, depth = 0): void {
  requireValid(depth < 80, 'JSON 嵌套过深');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uri') embeddedData(child);
    if (compressed.has(key))
      throw new Error(`暂不支持 ${key} 压缩 (compression)，请导出未压缩的 GLB / glTF 2`);
    scanResources(child, depth + 1);
  }
}

export function validateCharacterModel(
  data: Uint8Array,
  filename: string,
): Omit<CharacterModel, 'assetId' | 'filename'> {
  const format = extname(filename).toLowerCase().slice(1);
  requireValid(
    format === 'glb' || format === 'gltf',
    '请选择 .glb 或自包含 .gltf（GLB / glTF 2）文件',
  );
  requireValid(
    data.byteLength > 0 && data.byteLength <= MAX_MODEL_BYTES,
    '文件大小须在 100 MB 以内',
  );
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let jsonBytes: Uint8Array = bytes;
  let binary: Uint8Array | undefined;
  if (format === 'glb') {
    requireValid(
      bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2,
      '需要 GLB 2 文件头',
    );
    requireValid(bytes.readUInt32LE(8) === bytes.length, 'GLB 文件长度不匹配');
    let offset = 12;
    let hasJson = false;
    while (offset < bytes.length) {
      requireValid(offset + 8 <= bytes.length, 'GLB 块头不完整');
      const length = bytes.readUInt32LE(offset);
      const type = bytes.readUInt32LE(offset + 4);
      requireValid(length % 4 === 0 && offset + 8 + length <= bytes.length, 'GLB 块长度无效');
      requireValid(hasJson || type === 0x4e4f534a, '首个 GLB 块必须是 JSON');
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) {
        requireValid(!hasJson, '重复的 JSON 块');
        jsonBytes = chunk;
        hasJson = true;
      } else if (type === 0x004e4942) {
        requireValid(!binary, '重复的 BIN 块');
        binary = chunk;
      }
      offset += 8 + length;
    }
  }
  let document: Json;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes));
  } catch {
    throw new Error('无效的 glTF 2 JSON');
  }
  requireValid(document && document.asset?.version === '2.0', '只支持 glTF 2.0');
  requireValid(
    !document.asset.minVersion || document.asset.minVersion === '2.0',
    '最低版本必须兼容 glTF 2.0',
  );
  scanResources(document);
  for (const extension of [
    ...(document.extensionsUsed || []),
    ...(document.extensionsRequired || []),
  ]) {
    if (compressed.has(extension))
      throw new Error(`暂不支持 ${extension} 压缩 (compression)，请导出未压缩的 GLB / glTF 2`);
  }
  for (const extension of document.extensionsRequired || [])
    requireValid(extensions.has(extension), `不支持必需扩展 (extension) ${extension}`);
  const buffers: Json[] = document.buffers || [];
  requireValid(Array.isArray(buffers) && buffers.length > 0, '缺少缓冲区');
  const bufferSizes = buffers.map((buffer, i) => {
    requireValid(integer(buffer.byteLength, 1), '缓冲区大小无效');
    const payload =
      buffer.uri === undefined ? (i === 0 ? binary : undefined) : embeddedData(buffer.uri);
    requireValid(
      payload &&
        payload.byteLength >= buffer.byteLength &&
        payload.byteLength - buffer.byteLength <= 3,
      '缓冲区必须完整内嵌 (embedded)',
    );
    return buffer.byteLength;
  });
  const views: Json[] = document.bufferViews || [];
  requireValid(Array.isArray(views), 'bufferViews 无效');
  views.forEach((view) => {
    requireValid(
      integer(view.buffer) &&
        view.buffer < buffers.length &&
        integer(view.byteOffset ?? 0) &&
        integer(view.byteLength, 1),
      'bufferView 无效',
    );
    requireValid(
      (view.byteOffset || 0) + view.byteLength <= bufferSizes[view.buffer],
      'bufferView 超出缓冲区',
    );
    if (view.byteStride !== undefined)
      requireValid(
        integer(view.byteStride, 4) && view.byteStride <= 252 && view.byteStride % 4 === 0,
        'byteStride 无效',
      );
  });
  const accessors: Json[] = document.accessors || [];
  const componentSizes: Record<number, number> = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  };
  const elements: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  };
  requireValid(Array.isArray(accessors), 'accessors 无效');
  accessors.forEach((accessor) => {
    const elementSize = componentSizes[accessor.componentType] * elements[accessor.type];
    requireValid(
      elementSize &&
        integer(accessor.count, 1) &&
        accessor.count <= 10_000_000 &&
        integer(accessor.byteOffset ?? 0),
      'accessor 无效',
    );
    if (accessor.bufferView !== undefined) {
      const view = views[accessor.bufferView];
      requireValid(integer(accessor.bufferView) && view, 'accessor 引用无效');
      const stride = view.byteStride || elementSize;
      requireValid(
        stride >= elementSize &&
          (accessor.byteOffset || 0) + (accessor.count - 1) * stride + elementSize <=
            view.byteLength,
        'accessor 超出缓冲区',
      );
    }
    if (accessor.sparse) {
      const sparse = accessor.sparse;
      requireValid(
        integer(sparse.count, 1) && sparse.count <= accessor.count,
        '稀疏 accessor 无效',
      );
      for (const field of ['indices', 'values']) {
        const part = sparse[field];
        const view = views[part?.bufferView];
        const size = field === 'indices' ? componentSizes[part?.componentType] : elementSize;
        requireValid(
          part &&
            integer(part.bufferView) &&
            view &&
            size &&
            integer(part.byteOffset ?? 0) &&
            (part.byteOffset || 0) + sparse.count * size <= view.byteLength,
          '稀疏 accessor 超出缓冲区',
        );
      }
    }
  });
  for (const image of document.images || []) {
    if (image.uri !== undefined)
      requireValid(/^data:image\//.test(image.uri), '图片必须内嵌 (embedded)');
    else
      requireValid(
        integer(image.bufferView) &&
          views[image.bufferView] &&
          ['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(image.mimeType),
        '图片必须内嵌 (embedded) 且格式受支持',
      );
  }
  const meshes: Json[] = document.meshes || [];
  requireValid(Array.isArray(meshes) && meshes.length > 0, '缺少角色网格');
  let triangleCount = 0;
  for (const mesh of meshes) {
    requireValid(Array.isArray(mesh.primitives) && mesh.primitives.length > 0, '缺少网格图元');
    for (const primitive of mesh.primitives) {
      const position = accessors[primitive.attributes?.POSITION];
      requireValid(
        integer(primitive.attributes?.POSITION) && position?.type === 'VEC3',
        '网格缺少有效 POSITION',
      );
      for (const index of Object.values(primitive.attributes))
        requireValid(integer(index) && accessors[index], '顶点属性引用无效');
      if (primitive.indices !== undefined)
        requireValid(
          integer(primitive.indices) && accessors[primitive.indices]?.type === 'SCALAR',
          '索引引用无效',
        );
      const count =
        primitive.indices === undefined ? position.count : accessors[primitive.indices].count;
      const mode = primitive.mode ?? 4;
      requireValid(integer(mode) && mode <= 6, '网格模式无效');
      triangleCount += mode === 4 ? Math.floor(count / 3) : mode >= 5 ? Math.max(0, count - 2) : 0;
    }
  }
  requireValid(
    triangleCount > 0 && triangleCount <= 2_000_000,
    '需要可显示的三角网格（最多 200 万三角形）',
  );
  const nodes: Json[] = document.nodes || [];
  requireValid(Array.isArray(nodes) && nodes.length > 0 && nodes.length <= 10_000, '节点数量无效');
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const visit = (index: number, depth = 0) => {
    requireValid(
      integer(index) && nodes[index] && !visiting.has(index) && depth < 200,
      '节点层级无效或存在循环',
    );
    if (visited.has(index)) return;
    const node = nodes[index];
    if (node.mesh !== undefined)
      requireValid(integer(node.mesh) && meshes[node.mesh], '节点网格引用无效');
    visiting.add(index);
    for (const child of node.children || []) visit(child, depth + 1);
    visiting.delete(index);
    visited.add(index);
  };
  nodes.forEach((_, index) => visit(index));
  const scenes: Json[] = document.scenes || [];
  requireValid(
    Array.isArray(scenes) && scenes.length > 0 && scenes[document.scene ?? 0]?.nodes?.length,
    '缺少可显示场景',
  );
  for (const scene of scenes)
    for (const index of scene.nodes || [])
      requireValid(integer(index) && nodes[index], '场景节点引用无效');
  return {
    format,
    byteLength: bytes.length,
    triangleCount,
    animationCount: document.animations?.length || 0,
    hasSkins: !!document.skins?.length,
  };
}

/** User-local preferences, separate from immutable tasks and from public project assets. */
export class CharacterStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataRoot: string) {}

  async profiles(): Promise<CharacterProfile[]> {
    await this.queue;
    return this.readProfiles();
  }
  private async readProfiles(): Promise<CharacterProfile[]> {
    try {
      const data = z
        .object({ version: z.literal(1), characters: z.array(profileSchema).length(3) })
        .strict()
        .parse(JSON.parse(await readFile(join(this.dataRoot, 'characters.json'), 'utf8')));
      requireValid(new Set(data.characters.map((p) => p.id)).size === 3, '角色配置 ID 重复');
      return DEFAULT_CHARACTERS.map((p) => data.characters.find((saved) => saved.id === p.id)!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return DEFAULT_CHARACTERS.map((p) => ({ ...p }));
      throw error;
    }
  }
  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async persist(profiles: CharacterProfile[]): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    const temporary = join(this.dataRoot, `.characters-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, characters: profiles }, null, 2), {
        flag: 'wx',
      });
      await rename(temporary, join(this.dataRoot, 'characters.json'));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async update(rawId: unknown, rawPatch: unknown): Promise<CharacterProfile> {
    const id = idSchema.parse(rawId);
    const patch = updateSchema.parse(rawPatch);
    return this.transaction(async () => {
      const profiles = await this.readProfiles();
      const profile = profiles.find((p) => p.id === id)!;
      if (patch.displayName !== undefined) profile.displayName = patch.displayName;
      if (patch.rotationY !== undefined) profile.rotationY = patch.rotationY;
      if (patch.resetModel) {
        delete profile.model;
        delete profile.rotationY;
      }
      await this.persist(profiles);
      return profile;
    });
  }
  async importFile(rawId: unknown, sourcePath: string): Promise<CharacterProfile> {
    const id = idSchema.parse(rawId);
    // One handle prevents replacing a selected source between size validation and the read.
    const handle = await open(sourcePath, 'r');
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      requireValid(
        stat.isFile() && stat.size > 0 && stat.size <= MAX_MODEL_BYTES,
        '请选择 100 MB 以内的模型文件',
      );
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        requireValid(bytesRead > 0, '读取期间文件发生变化');
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
    const metadata = validateCharacterModel(bytes, sourcePath);
    const assetId = createHash('sha256').update(bytes).digest('hex');
    return this.transaction(async () => {
      const profiles = await this.readProfiles();
      const directory = join(this.dataRoot, 'character-assets');
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        await rename(temporary, join(directory, `${assetId}.${metadata.format}`));
      } finally {
        await rm(temporary, { force: true });
      }
      const profile = profiles.find((p) => p.id === id)!;
      profile.model = { ...metadata, assetId, filename: basename(sourcePath) };
      profile.modelRevision = (profile.modelRevision || 0) + 1;
      profile.rotationY = 0;
      await this.persist(profiles);
      return profile;
    });
  }
  async loadModel(rawAssetId: unknown): Promise<Uint8Array> {
    const assetId = assetIdSchema.parse(rawAssetId);
    const profiles = await this.profiles();
    const model = profiles.find((profile) => profile.model?.assetId === assetId)?.model;
    if (!model) throw new Error('角色模型未登记或已被替换，请重新导入');
    const bytes = await readFile(
      join(this.dataRoot, 'character-assets', `${assetId}.${model.format}`),
    );
    if (
      bytes.length !== model.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== assetId
    )
      throw new Error('角色模型副本校验失败，请重新导入');
    return new Uint8Array(bytes);
  }
}
