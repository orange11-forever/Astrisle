import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { islandAppearance } from './islands';
import { ISLAND_RADIUS, PROMENADE_RADIUS } from './island-motion';
import { FACILITIES, TEA_TABLE } from './island-facilities';

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

function addBranch(
  parts: THREE.BufferGeometry[],
  from: V3,
  to: V3,
  radius: number,
  color: string,
  parent?: THREE.Matrix4,
) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const direction = end.clone().sub(start);
  const rotation = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
  );
  addPart(
    parts,
    new THREE.CylinderGeometry(radius * 0.6, radius, start.distanceTo(end), 5),
    color,
    {
      position: start.add(end).multiplyScalar(0.5).toArray() as V3,
      rotation: [rotation.x, rotation.y, rotation.z],
      parent,
    },
  );
}

function addLeafSpray(
  parts: THREE.BufferGeometry[],
  position: V3,
  palette: Palette,
  scale = 1,
  parent?: THREE.Matrix4,
) {
  for (let i = 0; i < 5; i++) {
    const angle = i * 2.4;
    addPart(parts, new THREE.OctahedronGeometry(1, 0), i % 2 ? palette.leaf : palette.lightLeaf, {
      position: [
        position[0] + Math.cos(angle) * 0.12 * scale,
        position[1] + 0.1 * scale,
        position[2] + Math.sin(angle) * 0.12 * scale,
      ],
      scale: [0.09 * scale, (0.22 + (i % 2) * 0.07) * scale, 0.045 * scale],
      rotation: [Math.sin(angle) * 0.7, angle, Math.cos(angle) * 0.7],
      parent,
    });
  }
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
  // The branches remain visible between distinct crowns from every orbit angle.
  for (let i = 0; i < 4; i++) {
    const angle = i * 2.2 + 0.3;
    addBranch(
      parts,
      [0, 1.05 + i * 0.2, 0],
      [Math.cos(angle) * 0.57, 1.85 + i * 0.16, Math.sin(angle) * 0.5],
      0.055,
      '#897c66',
      parent,
    );
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), palette.stone, {
      position: [Math.cos(angle) * 0.19, 0.025, Math.sin(angle) * 0.19],
      scale: [0.18, 0.07, 0.12],
      rotation: [0, angle, 0],
      parent,
    });
  }
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
    // Smaller peripheral clusters soften the large low-poly crowns without more meshes.
    for (let j = 0; j < 3; j++) {
      const angle = j * 2.1 + i * 1.7;
      addPart(
        parts,
        new THREE.IcosahedronGeometry(1, 0),
        j === 1 ? palette.lightLeaf : palette.leaf,
        {
          position: [
            x! + Math.cos(angle) * s! * 0.76,
            y! + (j - 1) * 0.16,
            z! + Math.sin(angle) * s! * 0.76,
          ],
          scale: [s! * 0.36, s! * 0.27, s! * 0.33],
          rotation: [0.1, angle, 0.2],
          parent,
        },
      );
    }
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
    const blossom = i % 3 ? palette.flower : '#f2ead6';
    for (let petal = 0; petal < 5; petal++) {
      const petalAngle = (petal * Math.PI * 2) / 5 + angle;
      addPart(parts, new THREE.OctahedronGeometry(1, 0), blossom, {
        position: [
          x + Math.cos(petalAngle) * 0.055,
          position[1] + height,
          z + Math.sin(petalAngle) * 0.055,
        ],
        scale: [0.066, 0.025, 0.039],
        rotation: [0, -petalAngle, 0],
        parent,
      });
    }
    addPart(parts, new THREE.IcosahedronGeometry(0.032, 0), '#dfbb77', {
      position: [x, position[1] + height, z],
      scale: [1, 0.65, 1],
      parent,
    });
    addPart(parts, new THREE.OctahedronGeometry(1, 0), palette.lightLeaf, {
      position: [x + 0.04, position[1] + height * 0.5, z],
      scale: [0.08, 0.025, 0.045],
      rotation: [0, angle, 0.6],
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
  const bench = FACILITIES['garden-bench'].position;
  const tea = FACILITIES['tea-chair'].position;
  const swing = FACILITIES['garden-swing'].position;
  const nearFacility = (x: number, z: number, margin = 0) =>
    Math.hypot(x - bench[0], z - bench[1]) < 1.35 + margin ||
    Math.hypot(x - (tea[0] + TEA_TABLE[0]) / 2, z - (tea[1] + TEA_TABLE[1]) / 2) < 1.5 + margin ||
    Math.hypot(x - swing[0], z - swing[1]) < 1.65 + margin;
  addPart(parts, new THREE.CylinderGeometry(ISLAND_RADIUS - 0.07, 7.6, 1.05, 18), palette.stone, {
    position: [0, -0.9, 0],
    rotation: [0, palette.rotation, 0],
  });
  addPart(parts, new THREE.ConeGeometry(7.6, 3.5, 12), palette.stone, {
    position: [0, -3.175, 0],
    rotation: [0, 0.22, Math.PI],
  });
  addPart(
    parts,
    new THREE.CylinderGeometry(ISLAND_RADIUS, ISLAND_RADIUS - 0.12, 0.27, 80),
    palette.grass,
    {
      position: [0, -0.16, 0],
    },
  );
  const path = new THREE.CatmullRomCurve3(
    Array.from({ length: 33 }, (_, i) => {
      const angle = (i / 32) * Math.PI * 2;
      return new THREE.Vector3(
        Math.cos(angle) * PROMENADE_RADIUS,
        0,
        Math.sin(angle) * PROMENADE_RADIUS,
      );
    }),
  );
  addPart(parts, new THREE.TubeGeometry(path, 96, 0.52, 8, true), '#d8cbb0', {
    position: [0, -0.035, 0],
    scale: [1, 0.08, 1],
  });
  // Flush paving joints and a low curb keep the full promenade width open.
  for (let i = 0; i < 72; i++) {
    const angle = (i * Math.PI * 2) / 72;
    const x = Math.cos(angle),
      z = Math.sin(angle);
    addPart(parts, new THREE.BoxGeometry(0.83, 0.009, 0.016), '#bfaf93', {
      position: [x * PROMENADE_RADIUS, 0.008, z * PROMENADE_RADIUS],
      rotation: [0, -angle, 0],
    });
    for (const radius of [6.49, 7.73]) {
      if (nearFacility(x * radius, z * radius, 0.2)) continue;
      addPart(parts, new THREE.BoxGeometry(0.12, 0.065, 0.48), i % 3 ? '#c5bca2' : '#ded3b9', {
        position: [x * radius, -0.005, z * radius],
        rotation: [0, -angle, 0],
      });
    }
  }
  [
    [-7.2, -0.02, -4.5, 1.0],
    [-2.2, -0.02, -8.1, 0.9],
    [1.2, -0.02, -8.3, 0.8],
    [6.6, -0.02, -5.1, 1.05],
    [-8.25, -0.02, 1.0, 0.82],
    [-6.6, -0.02, 5.2, 0.7],
  ].forEach(([x, y, z, scale]) => addTree(parts, palette, [x!, y!, z!], scale!));
  for (let i = 0; i < 24; i++) {
    const angle = i * 0.65 + palette.rotation;
    const radius = 8.45 + (i % 3) * 0.12;
    if (nearFacility(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.3)) continue;
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), palette.stone, {
      position: [Math.cos(angle) * radius, -0.1, Math.sin(angle) * radius],
      scale: [0.21 + (i % 3) * 0.06, 0.16, 0.25],
    });
    if (i % 2 === 0)
      addFlowers(parts, [Math.cos(angle) * 8.35, -0.02, Math.sin(angle) * 8.35], palette, 7);
  }
  // Four planted pockets: a soil middle, flowering layer and low leafy border.
  [
    [-5.85, 5.8, 0.7],
    [-7.95, -2.45, 0.65],
    [4.6, 6.95, 0.72],
    [6.95, -4.65, 0.62],
  ].forEach(([x, z, size], bed) => {
    addPart(parts, new THREE.CylinderGeometry(size!, size! * 0.94, 0.035, 12), '#8b9074', {
      position: [x!, -0.008, z!],
      scale: [1, 1, 0.72],
      rotation: [0, bed * 0.7, 0],
    });
    addFlowers(parts, [x!, 0.01, z!], palette, 9);
    for (let i = 0; i < 7; i++) {
      const angle = (i * Math.PI * 2) / 7;
      addLeafSpray(
        parts,
        [x! + Math.cos(angle) * size! * 0.78, 0.01, z! + Math.sin(angle) * size! * 0.57],
        palette,
        0.65 + (i % 2) * 0.2,
      );
    }
  });
  const pond = new THREE.Matrix4().compose(
    new THREE.Vector3(6.75, 0, 5.0),
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
  for (let i = 0; i < 11; i++) {
    const angle = (i * Math.PI * 2) / 11;
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), i % 3 ? '#a6a48e' : palette.stone, {
      position: [Math.cos(angle) * 1.15, 0.015, Math.sin(angle) * 0.66],
      scale: [0.15 + (i % 2) * 0.05, 0.1, 0.12],
      rotation: [0.1, angle, 0.12],
      parent: pond,
    });
  }
  for (let i = 0; i < 9; i++) {
    const x = -0.88 + (i % 3) * 0.09,
      z = -0.23 + Math.floor(i / 3) * 0.13;
    const height = 0.35 + (i % 4) * 0.08;
    addBranch(parts, [x, 0.04, z], [x + 0.04, height, z + 0.02], 0.012, palette.leaf, pond);
    addPart(parts, new THREE.CylinderGeometry(0.026, 0.026, 0.12, 5), '#9c8160', {
      position: [x + 0.04, height, z + 0.02],
      parent: pond,
    });
    if (i % 2 === 0) addLeafSpray(parts, [x, 0.025, z], palette, 0.65, pond);
  }
  for (const [x, z, radius] of [
    [0.26, 0.2, 0.17],
    [0.65, -0.16, 0.13],
    [-0.24, 0.28, 0.11],
  ]) {
    // A missing wedge gives the lily pad its characteristic open seam.
    addPart(
      parts,
      new THREE.CylinderGeometry(radius!, radius!, 0.014, 12, 1, false, 0.18, Math.PI * 1.85),
      palette.leaf,
      {
        position: [x!, 0.07, z!],
        parent: pond,
      },
    );
  }
  for (let i = 0; i < 5; i++) {
    const angle = (i * Math.PI * 2) / 5;
    addPart(parts, new THREE.OctahedronGeometry(1, 0), i % 2 ? '#f2ead6' : palette.flower, {
      position: [0.26 + Math.cos(angle) * 0.045, 0.095, 0.2 + Math.sin(angle) * 0.045],
      scale: [0.055, 0.035, 0.026],
      rotation: [0, -angle, 0],
      parent: pond,
    });
  }
  for (let i = 0; i < 3; i++)
    addPart(
      parts,
      new THREE.TorusGeometry(0.21 + i * 0.15, 0.009, 3, 30, Math.PI * 1.6),
      '#b9d0cc',
      {
        position: [0.15, 0.079 + i * 0.001, -0.02],
        scale: [1, 0.58, 1],
        rotation: [-Math.PI / 2, 0, i * 0.8],
        parent: pond,
      },
    );
  const bridge = new THREE.Matrix4().compose(
    new THREE.Vector3(0, -0.04, 6.45),
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
  const place = (x: number, z: number, angle = 0) =>
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, 0, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, angle, 0)),
      new THREE.Vector3(1, 1, 1),
    );
  const addBench = (parent: THREE.Matrix4) => {
    for (const x of [-0.72, 0.72])
      for (const z of [-0.22, 0.22])
        addPart(parts, new THREE.BoxGeometry(0.09, 0.48, 0.09), '#637775', {
          position: [x, 0.24, z],
          parent,
        });
    for (let i = 0; i < 4; i++)
      addPart(parts, new THREE.BoxGeometry(1.8, 0.075, 0.12), i % 2 ? '#b6a58b' : '#c4b397', {
        position: [0, 0.51, (i - 1.5) * 0.15],
        parent,
      });
    for (let i = 0; i < 3; i++)
      addPart(parts, new THREE.BoxGeometry(1.8, 0.12, 0.07), '#b6a58b', {
        position: [0, 0.72 + i * 0.15, -0.28],
        parent,
      });
  };
  const shelter = place(-5.5, -6.4, 0.35);
  addBench(shelter);
  for (const x of [-1.05, 1.05])
    for (const z of [-0.55, 0.55])
      addPart(parts, new THREE.BoxGeometry(0.09, 2.05, 0.09), '#8c826f', {
        position: [x, 1.025, z],
        parent: shelter,
      });
  for (let i = 0; i < 7; i++)
    addPart(parts, new THREE.BoxGeometry(0.12, 0.08, 1.5), '#b6a58b', {
      position: [(i - 3) * 0.35, 2.08, 0],
      parent: shelter,
    });
  for (const z of [-0.6, 0.6])
    addPart(parts, new THREE.BoxGeometry(2.4, 0.12, 0.09), '#95866e', {
      position: [0, 1.95, z],
      parent: shelter,
    });
  for (const x of [-0.88, 0.88])
    for (const z of [-0.55, 0.55])
      addBranch(parts, [x, 1.6, z], [x * 0.55, 1.95, z], 0.035, '#95866e', shelter);
  // The back trellis is open enough to see the bench and the far side of the garden.
  for (let i = 0; i < 5; i++) {
    const x = -0.9 + i * 0.36;
    addBranch(parts, [x, 1.02, -0.58], [x + 0.36, 1.48, -0.58], 0.018, '#b6a58b', shelter);
    addBranch(parts, [x, 1.48, -0.58], [x + 0.36, 1.02, -0.58], 0.018, '#b6a58b', shelter);
    addBranch(parts, [x, 1.48, -0.58], [x + 0.36, 1.94, -0.58], 0.018, '#b6a58b', shelter);
    addBranch(parts, [x, 1.94, -0.58], [x + 0.36, 1.48, -0.58], 0.018, '#b6a58b', shelter);
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 10; i++) {
      const height = 0.18 + i * 0.19;
      const x = side * 1.05 + Math.sin(i * 1.7) * 0.065;
      const z = -0.55 + Math.cos(i * 1.7) * 0.065;
      addBranch(
        parts,
        [x, height, z],
        [
          side * 1.05 + Math.sin((i + 1) * 1.7) * 0.065,
          height + 0.2,
          -0.55 + Math.cos((i + 1) * 1.7) * 0.065,
        ],
        0.017,
        palette.leaf,
        shelter,
      );
      addLeafSpray(parts, [x + side * 0.04, height, z], palette, 0.48, shelter);
    }
    addPart(parts, new THREE.CylinderGeometry(0.19, 0.14, 0.23, 8), '#b39476', {
      position: [side * 1.05, 0.115, -0.55],
      parent: shelter,
    });
    const lanternX = side * 0.68;
    addPart(parts, new THREE.CylinderGeometry(0.012, 0.012, 0.25, 4), '#657775', {
      position: [lanternX, 1.89, 0.3],
      parent: shelter,
    });
    addPart(parts, new THREE.BoxGeometry(0.16, 0.22, 0.16), '#eddbad', {
      position: [lanternX, 1.68, 0.3],
      parent: shelter,
    });
    for (const height of [1.55, 1.81])
      addPart(parts, new THREE.BoxGeometry(0.22, 0.035, 0.22), '#657775', {
        position: [lanternX, height, 0.3],
        parent: shelter,
      });
    for (const x of [-0.085, 0.085])
      for (const z of [-0.085, 0.085])
        addPart(parts, new THREE.BoxGeometry(0.018, 0.24, 0.018), '#657775', {
          position: [lanternX + x, 1.68, 0.3 + z],
          parent: shelter,
        });
  }
  for (let i = 0; i < 11; i++)
    addLeafSpray(
      parts,
      [-1.1 + i * 0.22, 1.99 + Math.sin(i * 0.8) * 0.04, -0.58],
      palette,
      0.6,
      shelter,
    );
  addFlowers(parts, [-1.05, 1.94, 0], palette, 7, shelter);
  const telescope = place(4.2, -6.9, -0.6);
  for (let i = 0; i < 3; i++)
    addPart(parts, new THREE.CylinderGeometry(0.025, 0.035, 1.1, 6), '#a08d67', {
      position: [Math.cos(i * 2.1) * 0.2, 0.55, Math.sin(i * 2.1) * 0.2],
      rotation: [Math.sin(i * 2.1) * 0.35, 0, Math.cos(i * 2.1) * 0.35],
      parent: telescope,
    });
  addPart(parts, new THREE.CylinderGeometry(0.16, 0.13, 0.95, 16), '#4b7278', {
    position: [0, 1.2, 0],
    rotation: [0.9, 0, 0],
    parent: telescope,
  });
  addPart(parts, new THREE.CylinderGeometry(0.18, 0.18, 0.08, 16), '#ba994f', {
    position: [0, 1.5, 0.36],
    rotation: [0.9, 0, 0],
    parent: telescope,
  });
  const planter = place(-7.9, -0.7, 0.1);
  addPart(parts, new THREE.BoxGeometry(0.65, 0.22, 1.35), '#ac987d', {
    position: [0, 0.1, 0],
    parent: planter,
  });
  addPart(parts, new THREE.BoxGeometry(0.56, 0.03, 1.24), '#6d7060', {
    position: [0, 0.22, 0],
    parent: planter,
  });
  for (const x of [-0.31, 0.31])
    for (const height of [0.08, 0.23])
      addPart(parts, new THREE.BoxGeometry(0.06, 0.055, 1.41), '#c5b092', {
        position: [x, height, 0],
        parent: planter,
      });
  for (const z of [-0.66, 0.66])
    addPart(parts, new THREE.BoxGeometry(0.66, 0.055, 0.06), '#c5b092', {
      position: [0, 0.23, z],
      parent: planter,
    });
  addFlowers(parts, [0, 0.24, 0], palette, 12, planter);
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4 + 0.12,
      x = Math.cos(angle) * 7.8,
      z = Math.sin(angle) * 7.8;
    if (nearFacility(x, z, 0.1)) continue;
    addPart(parts, new THREE.CylinderGeometry(0.035, 0.045, 0.65, 7), '#6d7879', {
      position: [x, 0.325, z],
    });
    addPart(parts, new THREE.BoxGeometry(0.16, 0.22, 0.16), '#e9d4a4', { position: [x, 0.73, z] });
    addPart(parts, new THREE.ConeGeometry(0.16, 0.12, 4), '#657d7d', {
      position: [x, 0.9, z],
      rotation: [0, Math.PI / 4, 0],
    });
  }
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
  for (let i = 0; i < 11; i++) {
    const angle = (i * Math.PI * 2) / 11 + palette.rotation;
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), i % 3 ? palette.stone : '#a3a190', {
      position: [Math.cos(angle) * 7.7, -1.05 - (i % 3) * 0.12, Math.sin(angle) * 7.7],
      scale: [0.65 + (i % 2) * 0.2, 0.24, 0.42],
      rotation: [0.1, -angle, -0.08],
    });
    if (i % 2 === 0) {
      const rootX = Math.cos(angle) * 8.55,
        rootZ = Math.sin(angle) * 8.55;
      addBranch(
        parts,
        [rootX, -0.27, rootZ],
        [rootX * 0.94, -0.82, rootZ * 0.94],
        0.035,
        '#8f9274',
      );
      addLeafSpray(parts, [rootX * 0.96, -0.55, rootZ * 0.96], palette, 0.65);
    }
  }
  return finishSurface(parts);
}

function mineralSurface(): Surface {
  const parts: THREE.BufferGeometry[] = [];
  [
    [-3.8, -2, 3],
    [3.2, -2.1, 3.2],
    [-0.7, -3.7, 1.3],
    [-2.9, -2.1, -3.4],
    [3.7, -1.8, -2.8],
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
      <group position={[6.75, 0, 5.0]} rotation={[0, -0.7, 0]}>
        <mesh scale={[1.2, 0.07, 0.68]} receiveShadow>
          <sphereGeometry args={[1, 24, 8]} />
          <meshStandardMaterial color={palette.water} metalness={0.22} roughness={0.15} />
        </mesh>
      </group>
      <Pennant position={[-7.2, 0, 4.1]} palette={palette} reduced={reduced} />
    </group>
  );
}
