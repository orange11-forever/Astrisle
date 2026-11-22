import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { islandAppearance, type IslandThemeId } from './islands';
import { PROMENADE_RADIUS } from './island-motion';
import { FACILITIES, TEA_TABLE } from './island-facilities';
import { gardenApproaches, nearGardenApproach } from './garden-access';
import {
  POND_BEARING,
  POND_CENTER,
  POND_WATER_LEVEL,
  createPondLeaf,
  createPondPetal,
  createPondRipples,
  createPondStone,
  createPondWater,
  pondPoint,
} from './island-pond';
import { createIslandTerrain, shoreGroundHeight, shoreRadius } from './island-terrain';
import { OBSERVATORY, onObservatoryApproach } from './island-observatory';
import { TeaGardenDressing } from './TeaGardenDressing';

type V3 = [number, number, number];
type Palette = ReturnType<typeof islandAppearance>;
type Surface = { position: Float32Array; normal: Float32Array; color: Float32Array };
type Transform = { position?: V3; scale?: V3; rotation?: V3; parent?: THREE.Matrix4 };

function addPart(
  parts: THREE.BufferGeometry[],
  source: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
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

function addPondGarden(parts: THREE.BufferGeometry[], palette: Palette) {
  const parent = new THREE.Matrix4().makeRotationY(POND_BEARING).setPosition(...POND_CENTER);
  const bankStone = new THREE.Color(palette.stone).lerp(new THREE.Color('#8e8872'), 0.42);
  const wetStone = new THREE.Color('#647c73');
  const moss = new THREE.Color(palette.leaf).lerp(new THREE.Color('#72834f'), 0.44);
  const stones = [
    [0.18, 0.19, 0.94],
    [0.49, 0.13, 1.03],
    [0.93, 0.11, 0.92],
    [1.57, 0.126, 0.86],
    [2.08, 0.08, 0.96],
    [2.69, 0.15, 0.94],
    [3.19, 0.162, 0.93],
    [3.53, 0.118, 0.96],
    [4.27, 0.098, 0.94],
    [4.77, 0.078, 0.96],
    [5.04, 0.139, 0.9],
    [5.62, 0.1, 0.98],
  ] as const;
  for (const [angle, size, distance] of stones) {
    const position = pondPoint(angle, distance, -0.058);
    const tint = bankStone.clone().lerp(wetStone, 0.16 + Math.cos(angle * 3) ** 2 * 0.5);
    addPart(parts, createPondStone(angle), tint, {
      position,
      scale: [size, size * 0.57, size * 0.79],
      rotation: [0.13, angle * 1.87, 0.17 * Math.sin(angle)],
      parent,
    });
    if (size > 0.125) {
      addPart(parts, createPondStone(angle * 2), moss, {
        position: [position[0] + 0.021, position[1] + size * 0.36, position[2] - 0.015],
        scale: [size * 0.51, size * 0.12, size * 0.36],
        rotation: [0.1, angle * 1.87, 0],
        parent,
      });
    }
  }
  for (let i = 0; i < 18; i++) {
    const angle = i * 2.39996 + 0.24;
    const size = 0.022 + (i % 4) * 0.011;
    const radius = 0.7 + (i % 5) * 0.066;
    addPart(parts, new THREE.IcosahedronGeometry(1, 0), i % 3 ? bankStone : wetStone, {
      position: pondPoint(angle, radius, Math.min(-0.032, -0.22 + (radius - 0.68) * 0.7)),
      scale: [size, size * 0.54, size * 0.85],
      rotation: [0, angle, 0.1],
      parent,
    });
  }

  const reedShade = new THREE.Color(palette.leaf).lerp(new THREE.Color('#3f6954'), 0.52);
  const reedTip = new THREE.Color(palette.lightLeaf).lerp(new THREE.Color('#84905b'), 0.46);
  for (const [x, z, height] of [
    [-0.94, 0.15, 0.46],
    [-0.66, 0.224, 0.32],
    [0.79, 0.212, 0.27],
  ] as const) {
    for (let i = 0; i < 8; i++) {
      const angle = i * 2.39996 + x;
      const length = height * (0.56 + (i % 4) * 0.15);
      const leaf = createPondLeaf(length, 0.038 + (i % 3) * 0.012, 0.53 + (i % 3) * 0.26);
      const tint = i % 3 ? reedShade : reedTip;
      const transform: Transform = {
        position: [x + Math.cos(angle) * 0.049, -0.093, z + Math.sin(angle) * 0.026],
        rotation: [0, angle, 0],
        parent,
      };
      // The mirrored face keeps the blade visible from both sides of the bank.
      addPart(parts, leaf.clone().scale(-1, 1, 1), tint, transform);
      addPart(parts, leaf, tint, transform);
    }
  }
  for (let i = 0; i < 5; i++) {
    const x = -1.052 + i * 0.067;
    const z = 0.147 + Math.sin(i * 1.6) * 0.043;
    const height = 0.29 + (i % 3) * 0.09;
    const tilt = 0.018 + i * 0.009;
    addBranch(parts, [x, -0.086, z], [x + tilt, height, z + 0.038], 0.009, '#687d56', parent);
    addPart(parts, new THREE.CapsuleGeometry(0.019, 0.062 + (i % 2) * 0.019, 3, 7), '#8a684a', {
      position: [x + tilt, height - 0.013, z + 0.038],
      rotation: [0.1, 0, -0.072],
      parent,
    });
  }

  const pads = [
    { x: -0.35, z: 0.043, size: 0.139, yaw: 0.36, bloom: 0.8 },
    { x: -0.12, z: -0.13, size: 0.087, yaw: 3.5, bloom: 0 },
    { x: 0.17, z: 0.116, size: 0.104, yaw: 4.63, bloom: 0 },
    { x: 0.42, z: -0.065, size: 0.151, yaw: 1.91, bloom: 1 },
    { x: 0.63, z: 0.1, size: 0.092, yaw: 2.4, bloom: 0 },
    { x: 0.75, z: -0.13, size: 0.081, yaw: 0.94, bloom: 0 },
  ];
  const waterLine = POND_WATER_LEVEL + 0.009;
  const padYoung = new THREE.Color('#57875d').lerp(new THREE.Color(palette.leaf), 0.4);
  const padMature = new THREE.Color('#436e56').lerp(new THREE.Color(palette.leaf), 0.5);
  const shadedPetal = new THREE.Color('#d78eaa').lerp(new THREE.Color(palette.flower), 0.25);
  for (const { x, z, size, yaw, bloom } of pads) {
    const pad = new THREE.CircleGeometry(size, 24, yaw + 0.14, Math.PI * 2 - 0.28);
    const vertices = pad.getAttribute('position');
    for (let i = 1; i < vertices.count; i++) {
      const u = vertices.getX(i);
      const v = vertices.getY(i);
      const scallop = Math.cos(Math.atan2(v, u) * 9) * 0.025 + 1;
      vertices.setXYZ(i, u * scallop, v * scallop * 0.89, -0.003 + u * 0.034);
    }
    pad.computeVertexNormals();
    addPart(parts, pad, bloom ? padMature : padYoung, {
      position: [x, waterLine, z],
      rotation: [-Math.PI / 2, 0, 0],
      parent,
    });
    for (let vein = 0; vein < 4; vein++) {
      const angle = yaw + 0.46 + vein * 1.37;
      addBranch(
        parts,
        [x, waterLine + 0.004, z],
        [x + Math.cos(angle) * size * 0.77, waterLine + 0.004, z - Math.sin(angle) * size * 0.69],
        0.0017,
        '#7f9f70',
        parent,
      );
    }
    if (!bloom) continue;
    for (const ring of [0, 1]) {
      const count = ring ? 6 : 9;
      for (let i = 0; i < count; i++) {
        const angle = (i * Math.PI * 2) / count + ring * 0.4;
        const petal = createPondPetal(
          (ring ? 0.079 : 0.124) * bloom,
          (ring ? 0.049 : 0.063) * bloom,
          ring ? 0.04 : 0.019,
        );
        addPart(parts, petal, ring ? '#fff0dd' : shadedPetal, {
          position: [x, waterLine + 0.019 + ring * 0.012, z],
          rotation: [0, angle, 0],
          parent,
        });
      }
    }
    addPart(parts, new THREE.SphereGeometry(0.027 * bloom, 10, 5), '#e3b554', {
      position: [x, waterLine + 0.058, z],
      scale: [1, 0.56, 1],
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

function pointOnCliff(cliff: THREE.Mesh, ray: THREE.Raycaster, bearing: number, height: number) {
  const x = Math.cos(bearing);
  const z = Math.sin(bearing);
  ray.set(new THREE.Vector3(x * 11, height, z * 11), new THREE.Vector3(-x, 0, -z));
  return ray.intersectObject(cliff)[0]?.point;
}

const observatoryWood = ['#a18465', '#b29976', '#ad8d6b', '#bb9f79', '#a88c6b'];
const observatoryIron = '#4b6264';
const observatoryBrass = '#ba985c';
const observatoryLampBases: [number, number, number][] = [
  [4.23, 0.08, -5.54],
  [5.61, 0.13, -6.04],
  [6.12, OBSERVATORY.deck.height, -8.7],
  [3.7, OBSERVATORY.deck.height, -8.7],
];

function observatorySurfaces() {
  const deck: THREE.BufferGeometry[] = [];
  const walk: THREE.BufferGeometry[] = [];
  const telescope: THREE.BufferGeometry[] = [];
  const lamps: THREE.BufferGeometry[] = [];
  const { left, right, entryZ, farZ, height } = OBSERVATORY.deck;
  const { x: entryX, width, startZ, endZ } = OBSERVATORY.boardwalk;
  const box = (parts: THREE.BufferGeometry[], position: V3, size: V3, color: string, yaw = 0) =>
    addPart(parts, new THREE.BoxGeometry(...size), color, { position, rotation: [0, yaw, 0] });

  const rows = 12;
  const run = (startZ - endZ) / rows;
  const rise = (height - 0.014) / rows;
  for (let row = 0; row < rows; row++) {
    const y = 0.014 + (row + 1) * rise - 0.042;
    box(
      walk,
      [entryX, y, startZ - (row + 0.5) * run],
      [width - 0.02, 0.084, run - 0.008],
      observatoryWood[row % observatoryWood.length]!,
    );
  }
  for (const edge of [entryX - width / 2, entryX + width / 2]) {
    addPart(
      walk,
      new THREE.BoxGeometry(0.07, 0.065, Math.hypot(startZ - endZ, height)),
      '#756654',
      {
        position: [edge, 0.044, (startZ + endZ) / 2],
        rotation: [Math.atan2(height - 0.014, startZ - endZ), 0, 0],
      },
    );
  }

  const chamfer = 0.36;
  const plankDepth = (entryZ - farZ) / 17;
  for (let row = 0; row < 17; row++) {
    const z = entryZ - (row + 0.5) * plankDepth;
    const bevel = Math.max(0, chamfer - Math.min(entryZ - z, z - farZ));
    box(
      deck,
      [(left + right) / 2, height - 0.049, z],
      [right - left - bevel * 2, 0.098, plankDepth - 0.009],
      observatoryWood[row % observatoryWood.length]!,
    );
    for (const x of [left + 0.12 + bevel, right - 0.12 - bevel]) {
      box(deck, [x, height + 0.002, z], [0.023, 0.005, 0.023], '#746653');
    }
  }
  // Cantilevered beams and braces tie the overhanging seaward edge to the island.
  for (const x of [3.93, 5.43]) {
    box(deck, [x, -0.058, -7.73], [0.18, 0.23, 3.14], '#795e49');
    box(deck, [x, -0.39, -6.78], [0.24, 0.83, 0.24], '#795e49');
    addBranch(deck, [x, -0.71, -6.79], [x, -0.03, -9.02], 0.115, '#856e53');
  }

  // The entry stays open and the low rails preserve the horizon through the deck.
  const rim: [number, number][] = [
    [entryX - width / 2, entryZ - 0.045],
    [left + chamfer, entryZ - 0.045],
    [left + 0.045, entryZ - chamfer],
    [left + 0.045, farZ + chamfer],
    [left + chamfer, farZ + 0.045],
    [right - chamfer, farZ + 0.045],
    [right - 0.045, farZ + chamfer],
    [right - 0.045, entryZ - chamfer],
    [right - chamfer, entryZ - 0.045],
    [entryX + width / 2, entryZ - 0.045],
  ];
  const post = (x: number, z: number) => {
    box(deck, [x, height + 0.22, z], [0.078, 0.5, 0.078], observatoryIron);
    box(deck, [x, height + 0.48, z], [0.092, 0.026, 0.092], observatoryBrass);
  };
  rim.forEach(([x, z], index) => {
    post(x, z);
    const next = rim[index + 1];
    if (!next) return;
    const [nx, nz] = next;
    const yaw = Math.atan2(nx - x, nz - z);
    const length = Math.hypot(nx - x, nz - z);
    const midX = (nx + x) / 2;
    const midZ = (nz + z) / 2;
    if (length > 1.4) post(midX, midZ);
    box(deck, [midX, height + 0.46, midZ], [0.061, 0.061, length], '#78827a', yaw);
    box(deck, [midX, height + 0.21, midZ], [0.019, 0.019, length], observatoryIron, yaw);
  });

  // A brass compass set flush into the deck marks the northward sight line.
  const compass: V3 = [4.98, height + 0.009, -8.3];
  addPart(deck, new THREE.TorusGeometry(0.41, 0.012, 5, 32), observatoryBrass, {
    position: compass,
    rotation: [-Math.PI / 2, 0, 0],
  });
  box(deck, compass, [0.027, 0.012, 0.7], observatoryBrass);
  box(deck, compass, [0.027, 0.012, 0.51], observatoryBrass, Math.PI / 2);
  addPart(deck, new THREE.CylinderGeometry(0.063, 0.063, 0.012, 4), '#c7b486', {
    position: [compass[0], compass[1], compass[2] - 0.33],
  });

  // A low field journal shelf sits beside the telescope's observing lane.
  box(deck, [5.85, height + 0.28, -8.22], [0.18, 0.57, 0.27], observatoryIron);
  box(deck, [5.85, height + 0.58, -8.22], [0.72, 0.07, 0.48], '#927455', -0.23);
  box(deck, [5.84, height + 0.627, -8.24], [0.5, 0.026, 0.31], '#d6c39e', -0.3);
  for (let i = 0; i < 5; i++) {
    const angle = i * 2.4;
    box(
      deck,
      [5.84 + Math.cos(angle) * 0.17, height + 0.643, -8.24 + Math.sin(angle) * 0.09],
      [0.024, 0.005, 0.024],
      '#72838b',
      angle,
    );
  }

  const [scopeX, scopeZ] = OBSERVATORY.telescope;
  for (let i = 0; i < 3; i++) {
    const angle = i * ((2 * Math.PI) / 3) + 0.44;
    const x = scopeX + Math.cos(angle) * 0.33;
    const z = scopeZ + Math.sin(angle) * 0.33;
    addBranch(telescope, [x, height + 0.05, z], [scopeX, height + 0.91, scopeZ], 0.048, '#927751');
    box(telescope, [x, height + 0.026, z], [0.14, 0.043, 0.14], observatoryIron, angle);
  }
  addPart(telescope, new THREE.CylinderGeometry(0.12, 0.1, 0.18, 10), observatoryIron, {
    position: [scopeX, height + 0.91, scopeZ],
  });
  const axis = new THREE.Vector3(0.2, 0.52, -0.83).normalize();
  const tube = new THREE.Vector3(scopeX, height + 1.02, scopeZ);
  const tilt = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis),
  );
  for (const [offset, top, bottom, length, color] of [
    [0, 0.158, 0.118, 1.18, '#3b6874'],
    [-0.33, 0.146, 0.146, 0.046, observatoryBrass],
    [0.23, 0.17, 0.17, 0.075, observatoryBrass],
    [0.56, 0.197, 0.197, 0.118, '#b09462'],
    [0.624, 0.155, 0.155, 0.02, '#548e9c'],
    [-0.63, 0.08, 0.08, 0.16, observatoryBrass],
    [-0.73, 0.095, 0.095, 0.058, '#374c57'],
  ] as const) {
    addPart(telescope, new THREE.CylinderGeometry(top, bottom, length, 18), color, {
      position: tube.clone().addScaledVector(axis, offset).toArray(),
      rotation: [tilt.x, tilt.y, tilt.z],
    });
  }

  for (const [x, y, z] of observatoryLampBases) {
    box(deck, [x, y + 0.098, z], [0.11, 0.23, 0.11], observatoryIron);
    box(lamps, [x, y + 0.228, z], [0.118, 0.061, 0.118], '#eec58c');
    addPart(deck, new THREE.CylinderGeometry(0.093, 0.106, 0.055, 8), observatoryIron, {
      position: [x, y + 0.284, z],
    });
  }

  return {
    deck: finishSurface(deck),
    walk: finishSurface(walk),
    telescope: finishSurface(telescope),
    lamps: finishSurface(lamps),
  };
}

function ObservatoryDeck({
  lampStrength,
  onVisit,
}: {
  lampStrength: number;
  onVisit?: () => void;
}) {
  const surface = useMemo(observatorySurfaces, []);
  return (
    <group name="island-observatory">
      <mesh name="observatory-boardwalk" castShadow receiveShadow>
        <SurfaceGeometry surface={surface.walk} />
        <meshStandardMaterial vertexColors roughness={0.89} />
      </mesh>
      <mesh name="observatory-deck" castShadow receiveShadow>
        <SurfaceGeometry surface={surface.deck} />
        <meshStandardMaterial vertexColors roughness={0.85} />
      </mesh>
      <mesh
        name="observatory-telescope"
        castShadow
        receiveShadow
        onClick={
          onVisit &&
          ((event) => {
            event.stopPropagation();
            if (event.delta <= 4) onVisit();
          })
        }
      >
        <SurfaceGeometry surface={surface.telescope} />
        <meshStandardMaterial vertexColors metalness={0.27} roughness={0.43} />
      </mesh>
      <mesh name="observatory-lamps">
        <SurfaceGeometry surface={surface.lamps} />
        <meshStandardMaterial
          vertexColors
          emissive="#ffb164"
          emissiveIntensity={0.12 + lampStrength * 1.35}
          roughness={0.45}
        />
      </mesh>
      {[observatoryLampBases[1]!, observatoryLampBases[3]!].map(([x, y, z]) => (
        <pointLight
          key={z}
          position={[x, y + 0.32, z]}
          color="#ffc186"
          visible={lampStrength > 0}
          intensity={lampStrength * 0.72}
          distance={1.8}
          decay={2}
        />
      ))}
    </group>
  );
}

function landscapeSurface(palette: Palette, cliff: THREE.Mesh): Surface {
  const parts = [cliff.geometry];
  const bench = FACILITIES['garden-bench'].position;
  const tea = FACILITIES['tea-chair'].position;
  const swing = FACILITIES['garden-swing'].position;
  const nearFacility = (x: number, z: number, margin = 0) =>
    Math.hypot(x - bench[0], z - bench[1]) < 1.35 + margin ||
    Math.hypot(x - (tea[0] + TEA_TABLE[0]) / 2, z - (tea[1] + TEA_TABLE[1]) / 2) < 1.5 + margin ||
    Math.hypot(x - swing[0], z - swing[1]) < 1.65 + margin;
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
      if (
        nearFacility(x * radius, z * radius, 0.2) ||
        nearGardenApproach(x * radius, z * radius, 0.2) ||
        onObservatoryApproach(x * radius, z * radius, 0.17)
      )
        continue;
      addPart(parts, new THREE.BoxGeometry(0.12, 0.065, 0.48), i % 3 ? '#c5bca2' : '#ded3b9', {
        position: [x * radius, -0.005, z * radius],
        rotation: [0, -angle, 0],
      });
    }
  }
  [
    [-7.2, -0.02, -4.5, 1.0],
    [2.38, -0.02, -7.73, 0.72],
    [1.2, -0.02, -8.3, 0.8],
    [6.6, -0.02, -5.1, 1.05],
    [-8.25, -0.02, 1.0, 0.82],
    [-5.15, -0.02, 6.64, 0.7],
  ].forEach(([x, y, z, scale]) => addTree(parts, palette, [x!, y!, z!], scale!));
  // Continue both bridge decks in matching stone setts up to the circular promenade.
  for (const { start, end, width } of gardenApproaches) {
    const dx = end[0] - start[0],
      dz = end[1] - start[1];
    const length = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const rows = Math.ceil(length / 0.24);
    for (let row = 0; row < rows; row++) {
      const t = (row + 0.5) / rows;
      for (const side of [-1, 1]) {
        const offset = (side * width) / 4;
        addPart(
          parts,
          new THREE.BoxGeometry(width / 2 - 0.014, 0.032, length / rows - 0.014),
          (row + side) % 3 ? '#c5b79e' : '#baa98e',
          {
            position: [
              start[0] + dx * t + Math.cos(yaw) * offset,
              0.007,
              start[1] + dz * t - Math.sin(yaw) * offset,
            ],
            rotation: [0, yaw, 0],
          },
        );
      }
    }
  }
  // Driftwood-colored rocks and short coastal plants follow the verge in clusters.
  for (let i = 0; i < 27; i++) {
    const angle = i * 2.399963 + palette.rotation;
    const radius = Math.max(8.68, shoreRadius(angle, palette.rotation) - 0.27);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const atGlasshouseAccess = -0.8 * x + 0.6 * z > radius * 0.984;
    if (
      nearFacility(x, z, 0.44) ||
      (Math.abs(x) < 0.9 && z < -8.2) ||
      (x > OBSERVATORY.deck.left - 0.2 &&
        x < OBSERVATORY.deck.right + 0.2 &&
        z < OBSERVATORY.deck.entryZ) ||
      atGlasshouseAccess ||
      nearGardenApproach(x, z, 0.4) ||
      Math.hypot(x - POND_CENTER[0], z - POND_CENTER[2]) < 1.46
    )
      continue;
    const height = shoreGroundHeight(angle, radius, palette.rotation);
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), i % 3 ? palette.stone : '#a29c83', {
      position: [x, height - 0.035, z],
      scale: [0.19 + (i % 3) * 0.05, 0.15 + (i % 2) * 0.05, 0.32],
      rotation: [0.15, -angle, 0.1 * Math.sin(i)],
    });
    for (const side of [-1, 1]) {
      const offset = angle + side * 0.044;
      const verge = Math.min(radius - 0.1, shoreRadius(offset, palette.rotation) - 0.2);
      addLeafSpray(
        parts,
        [
          Math.cos(offset) * verge,
          shoreGroundHeight(offset, verge, palette.rotation),
          Math.sin(offset) * verge,
        ],
        palette,
        0.64 + (i % 4) * 0.09,
      );
    }
    if (i % 3 === 0)
      addFlowers(parts, [Math.cos(angle) * 8.61, -0.026, Math.sin(angle) * 8.61], palette, 5);
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
  addPondGarden(parts, palette);
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
  for (let i = 0; i < 12; i++) {
    const angle = i * 2.399963 + palette.rotation;
    const rim = shoreRadius(angle, palette.rotation);
    for (const [offset, length] of [
      [0, 0.62],
      [0.018, 0.37],
    ] as const) {
      const bearing = angle + offset;
      const x = Math.cos(bearing) * rim;
      const z = Math.sin(bearing) * rim;
      const tip: V3 = [x * 0.985, -0.19 - length, z * 0.985];
      addBranch(parts, [x * 0.992, -0.17, z * 0.992], tip, 0.025, '#717858');
      addLeafSpray(parts, tip, palette, 0.6);
    }
  }
  const ray = new THREE.Raycaster();
  const strata = new THREE.Color(palette.stone).lerp(new THREE.Color('#7c7b73'), 0.27);
  const strataColor = `#${strata.getHexString()}`;
  for (const [bearing, height, size] of [
    [0.21, -1.57, 0.56],
    [1.1, -2.3, 0.81],
    [2.11, -1.85, 0.65],
    [3.27, -2.3, 0.71],
    [4.21, -2.4, 0.72],
    [5.41, -1.9, 0.62],
  ] as const) {
    const angle = bearing + palette.rotation * 0.08;
    const rock = pointOnCliff(cliff, ray, angle, height);
    if (!rock) continue;
    rock.addScaledVector(ray.ray.direction, size * 0.52);
    addPart(parts, new THREE.DodecahedronGeometry(1, 0), strataColor, {
      position: [rock.x, rock.y, rock.z],
      scale: [size, size * 1.34, size * 1.11],
      rotation: [Math.sin(angle) * 0.34, -angle, 0.27],
    });
  }
  return finishSurface(parts);
}

function mineralSurface(cliff: THREE.Mesh, palette: Palette): Surface {
  const parts: THREE.BufferGeometry[] = [];
  const ray = new THREE.Raycaster();
  for (let cluster = 0; cluster < 5; cluster++) {
    const angle = 0.72 + (cluster * Math.PI * 2) / 5 + palette.rotation * 0.14;
    for (let i = 0; i < 3; i++) {
      const bearing = angle + (i - 1) * 0.026;
      const crystal = pointOnCliff(cliff, ray, bearing, -1.3 - cluster * 0.19 - (i % 2) * 0.12);
      if (!crystal) continue;
      crystal.addScaledVector(ray.ray.direction, -0.075);
      addPart(parts, new THREE.OctahedronGeometry(1, 0), i === 1 ? '#b5b3c9' : '#8c9ca9', {
        position: [crystal.x, crystal.y, crystal.z],
        scale: [0.09, i === 1 ? 0.24 : 0.16, 0.09],
        rotation: [Math.sin(bearing) * 0.46, cluster * 1.4, -Math.cos(bearing) * 0.46],
      });
    }
  }
  return finishSurface(parts);
}

export function IslandLandscape({
  workspaceId,
  themeId,
  reduced,
  observatoryLampStrength = 0,
  onVisitObservatory,
}: {
  workspaceId: string;
  themeId?: IslandThemeId;
  reduced: boolean;
  observatoryLampStrength?: number;
  onVisitObservatory?: () => void;
}) {
  const palette = useMemo(() => islandAppearance(workspaceId, themeId), [workspaceId, themeId]);
  const { surface, minerals } = useMemo(() => {
    const material = new THREE.MeshBasicMaterial();
    const cliff = new THREE.Mesh(createIslandTerrain(palette), material);
    const minerals = mineralSurface(cliff, palette);
    const surface = landscapeSurface(palette, cliff);
    material.dispose();
    return { surface, minerals };
  }, [palette]);
  const water = useMemo(() => createPondWater(palette.water), [palette.water]);
  const ripples = useMemo(createPondRipples, []);
  useEffect(() => () => water.dispose(), [water]);
  useEffect(() => () => ripples.dispose(), [ripples]);
  return (
    <group name="island-landscape">
      <ObservatoryDeck lampStrength={observatoryLampStrength} onVisit={onVisitObservatory} />
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
      <group name="garden-pond" position={POND_CENTER} rotation={[0, POND_BEARING, 0]}>
        <mesh geometry={water} receiveShadow renderOrder={1}>
          <meshStandardMaterial
            vertexColors
            transparent
            depthWrite={false}
            metalness={0.13}
            roughness={0.24}
          />
        </mesh>
        <mesh geometry={ripples} renderOrder={2}>
          <meshBasicMaterial vertexColors transparent depthWrite={false} />
        </mesh>
      </group>
      <Pennant position={[-7.2, 0, 4.1]} palette={palette} reduced={reduced} />
      <TeaGardenDressing />
    </group>
  );
}
