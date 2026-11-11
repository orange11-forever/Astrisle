import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

export interface SharedCharacterModel {
  animations: THREE.AnimationClip[];
  instantiate(): THREE.Group;
}
type Entry = {
  references: number;
  ready: Promise<SharedCharacterModel>;
  dispose?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

function disposeResources(scenes: THREE.Object3D[]) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const scene of scenes)
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material))
          if (value instanceof THREE.Texture) textures.add(value);
      }
    });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap)
      images.add(texture.image);
    texture.dispose();
  }
  for (const image of images) image.close();
}

async function parse(bytes: Uint8Array): Promise<GLTF> {
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

function prepare(gltf: GLTF): SharedCharacterModel {
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
  return {
    animations: gltf.animations,
    instantiate() {
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
  };
}

/** GPU resources are owned by the cache; avatar clones own only their skeleton state. */
export function disposeCharacterClone(root: THREE.Object3D) {
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
  });
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
              created.dispose = () => disposeResources(gltf.scenes);
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
