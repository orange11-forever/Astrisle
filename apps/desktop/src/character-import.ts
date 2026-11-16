import { open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import {
  characterResourcePath,
  MAX_CHARACTER_SOURCE_BYTES,
  MAX_CHARACTER_STORED_BYTES,
} from '../../../packages/contracts/src/character-asset';
import type { CharacterAssetBundle } from '../../../packages/contracts/src/character-asset';
import type { CharacterModel } from '@astrisle/contracts';
import { preflightFbx } from './fbx-preflight';

export async function readCharacterFile(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CHARACTER_SOURCE_BYTES)
      throw new Error('请选择 100 MB 以内的模型或资源文件');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('读取期间文件发生变化');
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function validate3mf(bytes: Uint8Array) {
  let size = 0,
    count = 0;
  const parts = unzipSync(bytes, {
    filter: (file) => {
      if (++count > 512 || (size += file.originalSize) > MAX_CHARACTER_SOURCE_BYTES)
        throw new Error('3MF 解压后须在 100 MB / 512 个资源以内');
      if (!file.name.endsWith('/')) characterResourcePath(file.name);
      return true;
    },
  });
  if (!parts['_rels/.rels'] || !Object.keys(parts).some((key) => /^3D\/[^/]+\.model$/.test(key)))
    throw new Error('3MF 缺少根关系或 3D 模型');
  for (const [name, data] of Object.entries(parts)) {
    if (!/\.(?:model|rels|xml)$/i.test(name)) continue;
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External/i.test(xml))
      throw new Error('3MF 包含不支持的外部资源或 XML 实体');
    for (const match of xml.matchAll(/\b(?:Target|path)\s*=\s*["']([^"']+)["']/g))
      characterResourcePath(match[1].replace(/^\//, ''));
    if (
      /<(?:\w+:)?(?:compositematerials|multiproperties|beamlattice|slice|slicestack)\b/i.test(xml)
    )
      throw new Error('3MF 包含暂不支持的复合材质、晶格或切片扩展；请导出普通网格');
    const required = /\brequiredextensions\s*=\s*["']([^"']*)["']/.exec(xml)?.[1];
    if (
      required?.trim() &&
      (required.trim() !== 'm' ||
        !/xmlns:m=["']http:\/\/schemas.microsoft.com\/3dmanufacturing\/material\/2015\/02["']/.test(
          xml,
        ))
    )
      throw new Error(`3MF 必需扩展暂不支持：${required}`);
  }
}

export async function packageCharacterFile(
  source: string,
): Promise<{ bytes: Buffer; format: CharacterModel['format']; filename: string }> {
  const format = extname(source).slice(1).toLowerCase() as CharacterModel['format'];
  if (!['glb', 'gltf', 'obj', 'stl', '3mf', 'fbx'].includes(format))
    throw new Error('请选择 GLB、glTF 2、3MF、STL、OBJ 或 FBX 模型');
  const bytes = await readCharacterFile(source);
  if (format === 'glb' || format === 'gltf') return { bytes, format, filename: basename(source) };
  if (format === '3mf') validate3mf(bytes);
  if (format === 'stl') {
    const triangles = bytes.length >= 84 ? bytes.readUInt32LE(80) : 0;
    if (bytes.length >= 84 && 84 + triangles * 50 === bytes.length) {
      if (triangles < 1 || triangles > 2_000_000) throw new Error('STL 需要 1 至 200 万个三角形');
    } else if (!/^.{0,4}solid/s.test(bytes.subarray(0, 9).toString('binary'))) {
      throw new Error('STL 二进制三角形数量与文件长度不匹配');
    }
  }
  const root = await realpath(dirname(source));
  const entry = `model.${format}`;
  const files: Record<string, string> = Object.create(null);
  files[entry] = bytes.toString('base64');
  let total = bytes.length;
  async function resource(raw: string, optional = false): Promise<Buffer | undefined> {
    let name: string;
    try {
      name = characterResourcePath(raw);
    } catch (error) {
      if (optional) return;
      throw error;
    }
    if (files[name]) return Buffer.from(files[name], 'base64');
    if (Object.keys(files).length >= 256) throw new Error('模型资源不能超过 256 个');
    let file: string;
    try {
      file = await realpath(resolve(root, name));
    } catch {
      if (optional) return;
      throw new Error(`模型资源缺失：${name}`);
    }
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`模型资源路径超出文件夹：${name}`);
    const data = await readCharacterFile(file);
    if ((total += data.length) > MAX_CHARACTER_SOURCE_BYTES)
      throw new Error('模型及资源总计须在 100 MB 以内');
    if (!/\.(mtl|png|jpe?g|webp|avif|bmp)$/i.test(name))
      throw new Error(`不支持的模型资源格式：${name}`);
    files[name] = data.toString('base64');
    return data;
  }
  if (format === 'obj') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const match of text.matchAll(/^\s*mtllib\s+(.+)$/gm)) {
      const name = characterResourcePath(match[1].trim());
      const mtl = (await resource(name))!.toString('utf8');
      const materials = new MTLLoader().parse(mtl, '');
      for (const material of Object.values(materials.materialsInfo))
        for (const [key, value] of Object.entries(material))
          if (/^(?:map_|bump|disp|norm)/i.test(key)) {
            if (
              !['map_kd', 'map_ks', 'map_ke', 'norm', 'map_bump', 'bump', 'disp', 'map_d'].includes(
                key.toLowerCase(),
              )
            )
              throw new Error(`OBJ 材质暂不支持贴图通道 ${key}；请导出 GLB 以保留 PBR 材质`);
            const texture = materials.getTextureParams(String(value), {}).url;
            await resource(`${dirname(name) === '.' ? '' : dirname(name) + '/'}${texture}`);
          }
    }
  }
  if (format === 'fbx') {
    const refs = new Set(preflightFbx(bytes));
    for (const ref of refs) await resource(ref, true);
  }
  const bundle: CharacterAssetBundle = { astrisleCharacterAsset: 1, format, entry, files };
  const packaged = Buffer.from(JSON.stringify(bundle));
  if (packaged.length > MAX_CHARACTER_STORED_BYTES) throw new Error('模型资源包过大');
  return { bytes: packaged, format, filename: basename(source) };
}
