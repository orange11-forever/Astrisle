import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { islandAppearance } from './islands';

type V3 = [number, number, number];
type Palette = ReturnType<typeof islandAppearance>;
type Surface = { position: Float32Array; normal: Float32Array; color: Float32Array };
type Transform = { position?: V3; scale?: V3; rotation?: V3; parent?: THREE.Matrix4 };

function addPart(
  parts: THREE.BufferGeometry[],
  source: THREE.BufferGeometry,
  color: string,
  { position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0], parent }: Transform = {},
) {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  geometry.deleteAttribute('uv');
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
  );
  if (parent) matrix.premultiply(parent);
  geometry.applyMatrix4(matrix);
  const colors = new Float32Array(geometry.getAttribute('position').count * 3);
  const tint = new THREE.Color(color);
  for (let i = 0; i < colors.length; i += 3) tint.toArray(colors, i);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  parts.push(geometry);
}

function finishSurface(parts: THREE.BufferGeometry[]): Surface {
  const geometry = mergeGeometries(parts, false)!;
  const surface = {
    position: geometry.getAttribute('position').array as Float32Array,
    normal: geometry.getAttribute('normal').array as Float32Array,
    color: geometry.getAttribute('color').array as Float32Array,
  };
  for (const part of parts) part.dispose();
  geometry.dispose();
  return surface;
}

function SurfaceGeometry({ surface }: { surface: Surface }) {
  return (
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[surface.position, 3]} />
      <bufferAttribute attach="attributes-normal" args={[surface.normal, 3]} />
      <bufferAttribute attach="attributes-color" args={[surface.color, 3]} />
    </bufferGeometry>
  );
}

function addTree(parts: THREE.BufferGeometry[], palette: Palette, position: V3, scale: number) {
  const parent = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion(),
    new THREE.Vector3(scale, scale, scale),
  );
  addPart(parts, new THREE.CylinderGeometry(0.1, 0.17, 1.8, 7), '#897c66', {
    position: [0, 0.9, 0],
    rotation: [0, 0, -0.06],
    parent,
  });
  addPart(parts, new THREE.CylinderGeometry(0.05, 0.08, 0.8, 6), '#897c66', {
    position: [0.25, 1.3, 0],
    rotation: [0, 0, -0.65],
    parent,
  });
  [
    [0, 2, 0, 0.85],
    [-0.48, 1.8, 0.1, 0.59],
    [0.45, 2.3, 0.1, 0.64],
    [0, 2.65, -0.1, 0.56],
  ].forEach(([x, y, z, s], i) => {
    addPart(parts, new THREE.IcosahedronGeometry(1, 1), i % 2 ? palette.lightLeaf : palette.leaf, {
      position: [x!, y!, z!],
      scale: [s!, s! * 0.8, s!],
      parent,
    });
  });
}

export function IslandTree({
  position,
  scale = 1,
  palette,
}: {
  position: V3;
  scale?: number;
  palette: Palette;
}) {
  const surface = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    addTree(parts, palette, [0, 0, 0], 1);
    return finishSurface(parts);
  }, [palette.leaf, palette.lightLeaf]);
  return (
    <mesh position={position} scale={scale} castShadow>
      <SurfaceGeometry surface={surface} />
      <meshStandardMaterial vertexColors roughness={0.95} />
    </mesh>
  );
}

function addFlowers(
  parts: THREE.BufferGeometry[],
  position: V3,
  palette: Palette,
  count: number,
  parent?: THREE.Matrix4,
) {
  for (let i = 0; i < count; i++) {
    const angle = i * 2.4;
    const radius = 0.18 + Math.sqrt(i) * 0.13;
    const height = 0.22 + (i % 3) * 0.07;
    const x = position[0] + Math.cos(angle) * radius;
    const z = position[2] + Math.sin(angle) * radius;
    addPart(parts, new THREE.CylinderGeometry(0.012, 0.014, height, 4), palette.leaf, {
      position: [x, position[1] + height / 2, z],
      parent,
    });
    addPart(parts, new THREE.IcosahedronGeometry(0.085, 0), i % 3 ? palette.flower : '#f2ead6', {
      position: [x, position[1] + height, z],
      rotation: [0.3, angle, 0.1],
      parent,
    });
    addPart(parts, new THREE.OctahedronGeometry(1, 0), palette.lightLeaf, {
      position: [x + 0.04, position[1] + height * 0.5, z],
      scale: [0.08, 0.025, 0.045],
      rotation: [0, 0, 0.6],
      parent,
    });
  }
}

export function Pennant({
  position,
  palette,
  reduced = false,
}: {
  position: V3;
  palette: Palette;
  reduced?: boolean;
}) {
  const flag = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (flag.current && !reduced)
      flag.current.rotation.y = Math.sin(clock.elapsedTime * 1.8 + palette.seed) * 0.15;
  });
  const pole = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    addPart(parts, new THREE.CylinderGeometry(0.025, 0.035, 2.2, 8), '#b49a65', {
      position: [0, 1.1, 0],
    });
    addPart(parts, new THREE.SphereGeometry(0.065, 8, 6), '#c9b27b', { position: [0, 2.25, 0] });
    return finishSurface(parts);
  }, []);
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(0.7, -0.12);
    s.lineTo(0.52, -0.35);
    s.lineTo(0, -0.3);
    s.closePath();
    return s;
  }, []);
  return (
    <group position={position}>
      <mesh castShadow>
        <SurfaceGeometry surface={pole} />
        <meshStandardMaterial vertexColors metalness={0.3} roughness={0.7} />
      </mesh>
      <mesh ref={flag} position={[0.03, 2.02, 0]} rotation={[0, 0.1, 0]}>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color={palette.flag} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function landscapeSurface(palette: Palette): Surface {
  const parts: THREE.BufferGeometry[] = [];
  addPart(parts, new THREE.CylinderGeometry(7.35, 6.25, 1.05, 14), palette.stone, {
    position: [0, -0.9, 0],
    rotation: [0, palette.rotation, 0],
  });
  addPart(parts, new THREE.ConeGeometry(6.25, 3, 10), palette.stone, {
    position: [0, -2.925, 0],
    rotation: [0, 0.22, Math.PI],
  });
  addPart(parts, new THREE.CylinderGeometry(7.42, 7.3, 0.27, 64), palette.grass, {
    position: [0, -0.26, 0],
  });
  const path = new THREE.CatmullRomCurve3(
    Array.from({ length: 33 }, (_, i) => {
      const angle = (i / 32) * Math.PI * 1.5 - 0.4;
      return new THREE.Vector3(Math.cos(angle) * 6.43, 0, Math.sin(angle) * 6.43);
    }),
  );
  addPart(parts, new THREE.TubeGeometry(path, 64, 0.24, 6, false), '#d8cbb0', {
    position: [0, -0.07, 0],
    scale: [1, 0.2, 1],
  });
  [
    [-5.8, -0.13, -3.9, 0.9],
    [-2.2, -0.13, -6.3, 0.83],
    [3.9, -0.13, -5.6, 0.85],
    [-6.7, -0.13, 0.2, 0.7],
  ].forEach(([x, y, z, scale]) => addTree(parts, palette, [x!, y!, z!], scale!));
  for (let i = 0; i < 24; i++) {
    const angle = i * 0.65 + palette.rotation;
    const radius = 6.8 + (i % 3) * 0.12;
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), palette.stone, {
      position: [Math.cos(angle) * radius, -0.1, Math.sin(angle) * radius],
      scale: [0.21 + (i % 3) * 0.06, 0.16, 0.25],
    });
    if (i % 2 === 0)
      addFlowers(parts, [Math.cos(angle) * 6.78, -0.12, Math.sin(angle) * 6.78], palette, 7);
  }
  const pond = new THREE.Matrix4().compose(
    new THREE.Vector3(5.55, -0.06, 3.45),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.7, 0)),
    new THREE.Vector3(1, 1, 1),
  );
  for (const side of [-1, 1])
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), palette.stone, {
      position: [side * 0.9, 0.03, side * 0.31],
      scale: [0.4, 0.23, 0.32],
      parent: pond,
    });
  addFlowers(parts, [-0.6, -0.02, -0.54], palette, 5, pond);
  const bridge = new THREE.Matrix4().compose(
    new THREE.Vector3(0, -0.1, 6.15),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.08, 0)),
    new THREE.Vector3(1, 1, 1),
  );
  for (let i = 0; i < 8; i++)
    addPart(parts, new THREE.BoxGeometry(0.2, 0.13, 1.36), i % 2 ? '#b8a384' : '#c3af90', {
      position: [(i - 3.5) * 0.23, 0.08, 0.1],
      parent: bridge,
    });
  for (const x of [-0.8, 0.8])
    addPart(parts, new THREE.BoxGeometry(0.12, 0.4, 1.4), '#8f826c', {
      position: [x, -0.1, 0.15],
      parent: bridge,
    });
  // Faceted outcrops break the underside's silhouette without floating cloud meshes.
  [
    [-3.7, -1.6, 2.6, 1.1],
    [3.4, -1.75, 2.7, 1.2],
    [-1.5, -2.5, -2.2, 0.9],
  ].forEach(([x, y, z, scale]) => {
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), palette.stone, {
      position: [x!, y!, z!],
      scale: [scale!, scale! * 1.15, scale!],
      rotation: [0.2, palette.rotation, 0.1],
    });
  });
  return finishSurface(parts);
}

function mineralSurface(): Surface {
  const parts: THREE.BufferGeometry[] = [];
  [
    [-3.8, -2, 3],
    [3.2, -2.1, 3.2],
    [-0.7, -3.7, 1.3],
  ].forEach(([x, y, z], cluster) => {
    for (let i = 0; i < 3; i++)
      addPart(parts, new THREE.OctahedronGeometry(1, 0), i === 1 ? '#b4b1d0' : '#859bab', {
        position: [x! + (i - 1) * 0.21, y! + (i % 2) * 0.2, z!],
        scale: [0.12, 0.34 + (i % 2) * 0.2, 0.13],
        rotation: [0.12, cluster * 1.4, (i - 1) * 0.2],
      });
  });
  return finishSurface(parts);
}

export function IslandLandscape({
  workspaceId,
  reduced,
}: {
  workspaceId: string;
  reduced: boolean;
}) {
  const palette = useMemo(() => islandAppearance(workspaceId), [workspaceId]);
  const surface = useMemo(() => landscapeSurface(palette), [palette]);
  const minerals = useMemo(mineralSurface, []);
  return (
    <group name="island-landscape">
      <mesh castShadow receiveShadow>
        <SurfaceGeometry surface={surface} />
        <meshStandardMaterial vertexColors roughness={0.95} flatShading />
      </mesh>
      <mesh>
        <SurfaceGeometry surface={minerals} />
        <meshStandardMaterial
          vertexColors
          roughness={0.38}
          metalness={0.18}
          emissive="#655b82"
          emissiveIntensity={0.12}
          flatShading
        />
      </mesh>
      <group position={[5.55, -0.06, 3.45]} rotation={[0, -0.7, 0]}>
        <mesh scale={[1.2, 0.07, 0.68]} receiveShadow>
          <sphereGeometry args={[1, 24, 8]} />
          <meshStandardMaterial color={palette.water} metalness={0.22} roughness={0.15} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} scale={[1, 0.5, 1]} position={[0.15, 0.075, 0]}>
          <torusGeometry args={[0.46, 0.013, 4, 32]} />
          <meshBasicMaterial color="#b9d0cc" />
        </mesh>
      </group>
      <Pennant position={[-5.9, -0.06, 3.6]} palette={palette} reduced={reduced} />
    </group>
  );
}
