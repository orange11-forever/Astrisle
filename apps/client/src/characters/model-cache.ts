import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createProceduralGaitTemplate, disposeProceduralTemplate } from './procedural-gait';
import { parseCharacterBundle, inspectParsedCharacter } from './format-loader';
import type { ParsedCharacter } from './format-loader';
import { disposeResources } from './model-resources';

export interface SharedCharacterModel {
  animations: THREE.AnimationClip[];
  instantiate(options?: { procedural?: boolean; rotationY?: number }): THREE.Group;
  disposeTemplates?(): void;
}
type Entry = {
  references: number;
  ready: Promise<SharedCharacterModel>;
  dispose?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

async function parse(bytes: Uint8Array): Promise<ParsedCharacter> {
  const bundled = await parseCharacterBundle(bytes);
  if (bundled) return bundled;
  const manager = new THREE.LoadingManager();
  let resourceFailed = false;
  manager.onError = () => {
    resourceFailed = true;
  };
  manager.setURLModifier((url) => {
    // Images in validated GLB files become ephemeral blob URLs inside GLTFLoader.
    if (
      !/^(?:blob:|data:(?:image\/(?:png|jpeg|webp|avif)|application\/(?:octet-stream|gltf-buffer));base64,)/.test(
        url,
      )
    ) {
      throw new Error('角色模型包含外部资源，请重新导出自包含 GLB');
    }
    return url;
  });
  const gltf = await new GLTFLoader(manager).parseAsync(new Uint8Array(bytes).buffer, '');
  // GLTFLoader can recover from image errors with an untextured mesh. Make that failure visible.
  if (resourceFailed) {
    disposeResources(gltf.scenes);
    throw new Error('角色模型内嵌资源读取失败，请检查贴图并重新导出');
  }
  return gltf;
}

function prepare(gltf: ParsedCharacter): SharedCharacterModel {
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const size = bounds.getSize(new THREE.Vector3());
  if (
    !Number.isFinite(size.y) ||
    size.y < 0.000001 ||
    size.x > size.y * 100 ||
    size.z > size.y * 100
  ) {
    throw new Error('模型没有可显示的有效尺寸，请检查角色网格');
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 1.85 / size.y;
  const templates = new Map<number, THREE.Group | null>();
  const model: SharedCharacterModel = {
    animations: gltf.animations,
    instantiate(options = {}) {
      if (options.procedural && !gltf.animations.length) {
        const angle = options.rotationY ?? 0;
        if (!templates.has(angle))
          templates.set(angle, createProceduralGaitTemplate(model.instantiate(), angle));
        const template = templates.get(angle);
        if (template) {
          const instance = clone(template) as THREE.Group;
          // Object3D cloning does not copy instance method overrides.
          instance.traverse((object) => {
            if (object instanceof THREE.Mesh) object.raycast = () => {};
          });
          return instance;
        }
      }
      // SkeletonUtils gives each avatar independent bones while sharing geometry and textures.
      const scene = clone(gltf.scene);
      const remove: THREE.Object3D[] = [];
      scene.traverse((object) => {
        if (object instanceof THREE.Light || object instanceof THREE.Camera) remove.push(object);
        if (object instanceof THREE.Mesh) {
          object.castShadow = false;
          object.receiveShadow = false;
          // The low-cost hit box in CharacterVisual handles selection for dense meshes.
          object.raycast = () => {};
        }
      });
      remove.forEach((object) => object.removeFromParent());
      const normalized = new THREE.Group();
      normalized.name = 'Imported_character_normalized';
      normalized.scale.setScalar(scale);
      normalized.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
      normalized.add(scene);
      const root = new THREE.Group();
      root.add(normalized);
      return root;
    },
    disposeTemplates() {
      for (const template of templates.values()) if (template) disposeProceduralTemplate(template);
      templates.clear();
    },
  };
  return model;
}

/** Parse with the same loaders used by every island before committing a replacement. */
export async function inspectCharacterImport(bytes: Uint8Array) {
  const parsed = await parse(bytes);
  try {
    return inspectParsedCharacter(parsed);
  } finally {
    disposeResources(parsed.scenes);
  }
}

/** GPU resources are owned by the cache; avatar clones own only their skeleton state. */
export function disposeCharacterClone(root: THREE.Object3D) {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
  });
  skeletons.forEach((skeleton) => skeleton.dispose());
}

export function createCharacterModelCache(loadBytes: (assetId: string) => Promise<Uint8Array>) {
  const entries = new Map<string, Entry>();
  const retire = (assetId: string, entry: Entry) => {
    if (entry.timer || entry.references > 0) return;
    // Effect reconnects and scene switches in the same turn can keep the loaded asset alive.
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entry.references > 0 || !entry.dispose) return;
      entry.dispose();
      if (entries.get(assetId) === entry) entries.delete(assetId);
    }, 0);
  };
  return {
    acquire(assetId: string) {
      let entry = entries.get(assetId);
      if (!entry) {
        const created: Entry = { references: 0, ready: undefined! };
        created.ready = loadBytes(assetId)
          .then(parse)
          .then((gltf) => {
            try {
              const model = prepare(gltf);
              created.dispose = () => {
                model.disposeTemplates?.();
                disposeResources(gltf.scenes);
              };
              retire(assetId, created);
              return model;
            } catch (error) {
              disposeResources(gltf.scenes);
              throw error;
            }
          })
          .catch((error: unknown) => {
            if (entries.get(assetId) === created) entries.delete(assetId);
            throw error;
          });
        entries.set(assetId, created);
        entry = created;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      entry.references++;
      let released = false;
      return {
        ready: entry.ready,
        release() {
          if (released) return;
          released = true;
          entry.references--;
          retire(assetId, entry);
        },
      };
    },
  };
}

export const characterModelCache = createCharacterModelCache(async (assetId) => {
  if (!window.astrisle?.loadCharacterModel) throw new Error('请在 Astrisle 桌面版加载本地角色模型');
  return window.astrisle.loadCharacterModel(assetId);
});
