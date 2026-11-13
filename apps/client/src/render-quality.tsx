import { createContext, useContext, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import * as THREE from 'three';

export type SceneQuality = 'balanced' | 'clear';
export const SceneQualityContext = createContext<SceneQuality>('clear');
export const useSceneQuality = () => useContext(SceneQualityContext);

const maxRenderPixels = 4_000_000;

export function scenePixelRatio(quality: SceneQuality, width: number, height: number) {
  const target = quality === 'clear' ? 1.5 : 1;
  const area = width * height;
  return area > 0 && Number.isFinite(area)
    ? Math.min(target, Math.sqrt(maxRenderPixels / area))
    : target;
}

/** Keep resolution bounded by the actual canvas area, including panel and window resizing. */
export function useScenePixelRatio(
  quality: SceneQuality,
  container: RefObject<HTMLElement | null>,
) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = ({ width, height }: { width: number; height: number }) =>
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    update(element.getBoundingClientRect());
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect));
    observer.observe(element);
    return () => observer.disconnect();
  }, [container]);
  return scenePixelRatio(quality, size.width, size.height);
}

/** Shared cache textures stay shared; only GPU sampling changes, never image or geometry data. */
export function configureModelTextureSampling(
  root: THREE.Object3D,
  quality: SceneQuality,
  maxAnisotropy: number,
) {
  const limit = Number.isFinite(maxAnisotropy) ? Math.max(1, maxAnisotropy) : 1;
  const anisotropy = quality === 'clear' ? Math.min(8, limit) : 1;
  const textures = new Set<THREE.Texture>();
  let changed = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const texture of Object.values(material)) {
        if (!(texture instanceof THREE.Texture) || textures.has(texture)) continue;
        textures.add(texture);
        // Preserve deliberate pixel-art and non-mipmapped samplers supplied by the model.
        if (
          texture.magFilter !== THREE.LinearFilter ||
          (texture.minFilter !== THREE.LinearMipmapLinearFilter &&
            texture.minFilter !== THREE.LinearMipmapNearestFilter) ||
          texture.anisotropy === anisotropy
        )
          continue;
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
        changed++;
      }
    }
  });
  return changed;
}

export function SceneQualitySelect({
  value,
  onChange,
}: {
  value: SceneQuality;
  onChange: (quality: SceneQuality) => void;
}) {
  return (
    <>
      <label htmlFor="scene-quality">场景画质</label>
      <select
        id="scene-quality"
        value={value}
        aria-describedby="scene-quality-hint"
        onChange={(event) => onChange(event.target.value === 'balanced' ? 'balanced' : 'clear')}
      >
        <option value="clear">清晰（推荐）</option>
        <option value="balanced">均衡</option>
      </select>
      <p className="quiet" id="scene-quality-hint">
        清晰模式优先模型边缘和贴图细节，均衡模式减少渲染负担。
      </p>
    </>
  );
}
