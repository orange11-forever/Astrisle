import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import type { MaterialInfo } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import {
  characterResourcePath,
  MAX_CHARACTER_STORED_BYTES,
} from '../../../../packages/contracts/src/character-asset';
import type { CharacterAssetBundle } from '../../../../packages/contracts/src/character-asset';
import type { CharacterImportInspection } from '@astrisle/contracts';
import { disposeResources } from './model-resources';

export interface ParsedCharacter {
  scene: THREE.Group;
  scenes: THREE.Group[];
  animations: THREE.AnimationClip[];
}
function bytesOf(base64: string): Uint8Array {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    throw new Error('模型资源包内容无效');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
export function inspectParsedCharacter(parsed: ParsedCharacter): CharacterImportInspection {
  let triangleCount = 0,
    hasSkins = false,
    nodes = 0;
  parsed.scene.traverse((object) => {
    if (++nodes > 10_000) throw new Error('模型节点不能超过 10000 个');
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    if (!position || position.itemSize !== 3) throw new Error('模型缺少有效顶点');
    for (let i = 0; i < position.count; i++)
      if (![position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite))
        throw new Error('模型包含无效顶点坐标');
    triangleCount += Math.floor((object.geometry.index?.count ?? position.count) / 3);
    hasSkins ||= object instanceof THREE.SkinnedMesh;
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture && !value.image)
          throw new Error('模型贴图缺失或格式不支持，请内嵌 PNG/JPEG/WebP 贴图');
  });
  if (triangleCount < 1 || triangleCount > 2_000_000)
    throw new Error('模型需要有效三角网格，最多 200 万个三角形');
  const size = new THREE.Box3().setFromObject(parsed.scene).getSize(new THREE.Vector3());
  if (
    !Number.isFinite(size.y) ||
    size.y < 0.000001 ||
    size.x > size.y * 100 ||
    size.z > size.y * 100
  )
    throw new Error('模型没有可显示的有效尺寸，请检查角色网格');
  return { triangleCount, hasSkins, animationCount: parsed.animations.length };
}

export async function parseCharacterBundle(bytes: Uint8Array): Promise<ParsedCharacter | null> {
  if (bytes.length > MAX_CHARACTER_STORED_BYTES) throw new Error('模型资源包过大');
  // Existing GLB and self-contained glTF continue through the original loader unchanged.
  const first = new TextDecoder().decode(bytes.subarray(0, 64));
  if (!first.startsWith('{"astrisleCharacterAsset":')) return null;
  const bundle = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as CharacterAssetBundle;
  if (
    bundle.astrisleCharacterAsset !== 1 ||
    !['obj', 'stl', 'fbx', '3mf'].includes(bundle.format) ||
    !bundle.files ||
    Object.keys(bundle.files).length > 256 ||
    !Object.hasOwn(bundle.files, bundle.entry)
  )
    throw new Error('模型资源包无效');
  Object.keys(bundle.files).forEach(characterResourcePath);
  const manager = new THREE.LoadingManager();
  let started = false;
  const failures: string[] = [];
  const blobUrls = new Set<string>();
  let finish!: () => void;
  const loaded = new Promise<void>((resolve) => {
    finish = resolve;
  });
  manager.onStart = () => {
    started = true;
  };
  manager.onLoad = () => finish();
  manager.onError = (url) => {
    failures.push(url.slice(0, 100));
  };
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:')) {
      blobUrls.add(url);
      return url;
    }
    if (/^data:image\/(?:png|jpeg|webp|avif|bmp);base64,/.test(url)) return url;
    let path = characterResourcePath(url);
    if (!Object.hasOwn(bundle.files, path) && bundle.format === 'fbx') {
      const matches = Object.keys(bundle.files).filter((file) => file.split('/').pop() === path);
      if (matches.length === 1) path = matches[0];
    }
    if (!Object.hasOwn(bundle.files, path))
      throw new Error(`模型资源缺失：${path}；请将贴图放在模型文件夹内或内嵌后重新导出`);
    const extension = path.split('.').pop()!.toLowerCase();
    const mime: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      avif: 'image/avif',
      bmp: 'image/bmp',
    };
    if (!mime[extension]) throw new Error(`模型贴图格式暂不支持：${path}`);
    return `data:${mime[extension]};base64,${bundle.files[path]}`;
  });
  const data = bytesOf(bundle.files[bundle.entry]);
  const text = () => new TextDecoder('utf-8', { fatal: true }).decode(data);
  let scene: THREE.Group | undefined;
  const warnings: string[] = [];
  function strictParse<T>(operation: () => T): T {
    // These loaders report unsupported data through synchronous warnings while
    // returning a lossy mesh. Surface that limitation before replacing an avatar.
    const previousWarn = console.warn,
      previousError = console.error;
    const capture =
      (previous: typeof console.warn) =>
      (...args: unknown[]) => {
        if (/^(?:THREE\.)?(?:FBX|3MF|ThreeMF)Loader:/.test(String(args[0])))
          warnings.push(args.map(String).join(' '));
        else previous(...args);
      };
    console.warn = capture(previousWarn);
    console.error = capture(previousError);
    try {
      return operation();
    } finally {
      console.warn = previousWarn;
      console.error = previousError;
    }
  }
  try {
    if (bundle.format === 'obj') {
      const loader = new OBJLoader(manager);
      const source = text();
      const combined: Record<string, MaterialInfo> = {};
      for (const match of source.matchAll(/^\s*mtllib\s+(.+)$/gm)) {
        const path = characterResourcePath(match[1].trim());
        if (!Object.hasOwn(bundle.files, path)) throw new Error(`模型材质库缺失：${path}`);
        const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        const materials = new MTLLoader(manager).parse(
          new TextDecoder().decode(bytesOf(bundle.files[path])),
          base,
        );
        // Prefix texture paths before merging multiple material libraries.
        for (const info of Object.values(materials.materialsInfo))
          for (const [key, value] of Object.entries(info))
            if (/^(?:map_|bump|disp|norm)/i.test(key) && base) {
              const options = {};
              const texture = materials.getTextureParams(String(value), options);
              (info as Record<string, unknown>)[key] = String(value).replace(
                texture.url,
                base + texture.url,
              );
            }
        Object.assign(combined, materials.materialsInfo);
      }
      for (const match of source.matchAll(/^\s*usemtl\s+(.+)$/gm))
        if (!Object.hasOwn(combined, match[1].trim()))
          throw new Error(`模型材质缺失：${match[1].trim()}`);
      if (Object.keys(combined).length) {
        const materials = new MTLLoader(manager).parse('', '');
        materials.setMaterials(combined);
        materials.preload();
        loader.setMaterials(materials);
      }
      scene = loader.parse(source);
    } else if (bundle.format === 'stl') {
      const geometry = new STLLoader(manager).parse(
        data.buffer as ArrayBuffer,
      ) as THREE.BufferGeometry & { alpha?: number };
      const material = new THREE.MeshStandardMaterial({
        color: geometry.hasAttribute('color') ? 0xffffff : 0xb8c6d9,
        vertexColors: geometry.hasAttribute('color'),
        opacity: geometry.alpha ?? 1,
        transparent: (geometry.alpha ?? 1) < 1,
      });
      scene = new THREE.Group();
      scene.add(new THREE.Mesh(geometry, material));
    } else if (bundle.format === 'fbx') {
      scene = strictParse(() => new FBXLoader(manager).parse(data.buffer as ArrayBuffer, ''));
    } else {
      scene = strictParse(() => new ThreeMFLoader(manager).parse(data.buffer as ArrayBuffer));
      scene.rotation.x = -Math.PI / 2;
    }
    if (started) await loaded;
    if (failures.length) throw new Error(`模型贴图读取失败：${failures[0]}；请检查资源格式`);
    if (warnings.length) throw new Error(`模型包含暂不支持的数据：${warnings[0]}`);
    const parsed = { scene, scenes: [scene], animations: scene.animations ?? [] };
    inspectParsedCharacter(parsed);
    return parsed;
  } catch (error) {
    if (started) await loaded;
    if (scene) disposeResources([scene]);
    throw error;
  } finally {
    blobUrls.forEach((url) => URL.revokeObjectURL(url));
  }
}
