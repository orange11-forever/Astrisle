import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type PropPoint = [number, number, number];

export interface IslandPropSurface {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint16Array | Uint32Array;
}

/** Batch vertex-colored prop details with a shared material into one draw. */
export function createIslandPropBuilder() {
  const parts: THREE.BufferGeometry[] = [];
  const add = (
    geometry: THREE.BufferGeometry,
    position: PropPoint,
    tint: string,
    rotation: PropPoint = [0, 0, 0],
  ) => {
    geometry.deleteAttribute('uv');
    geometry.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)));
    geometry.translate(...position);
    const vertexCount = geometry.attributes.position.count;
    if (!geometry.index) geometry.setIndex(Array.from({ length: vertexCount }, (_, i) => i));
    const colors = new Float32Array(vertexCount * 3);
    const color = new THREE.Color(tint);
    for (let offset = 0; offset < colors.length; offset += 3) color.toArray(colors, offset);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(geometry);
  };
  const box = (position: PropPoint, size: PropPoint, tint: string, rotation?: PropPoint) =>
    add(new THREE.BoxGeometry(...size), position, tint, rotation);

  return {
    add,
    box,
    beam(from: PropPoint, to: PropPoint, width: number, tint: string) {
      const base = new THREE.Vector3(...from);
      const tip = new THREE.Vector3(...to);
      const direction = tip.clone().sub(base);
      const rotation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          direction.clone().normalize(),
        ),
      );
      box(base.lerp(tip, 0.5).toArray(), [width, direction.length(), width], tint, [
        rotation.x,
        rotation.y,
        rotation.z,
      ]);
    },
    finish(): IslandPropSurface {
      const merged = mergeGeometries(parts)!;
      const surface: IslandPropSurface = {
        position: merged.attributes.position.array as Float32Array,
        normal: merged.attributes.normal.array as Float32Array,
        color: merged.attributes.color.array as Float32Array,
        index: merged.index!.array as Uint16Array | Uint32Array,
      };
      for (const part of parts) part.dispose();
      merged.dispose();
      return surface;
    },
  };
}

export function IslandPropGeometry({ surface }: { surface: IslandPropSurface }) {
  return (
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[surface.position, 3]} />
      <bufferAttribute attach="attributes-normal" args={[surface.normal, 3]} />
      <bufferAttribute attach="attributes-color" args={[surface.color, 3]} />
      <bufferAttribute attach="index" args={[surface.index, 1]} />
    </bufferGeometry>
  );
}
