import { useMemo } from 'react';
import * as THREE from 'three';
import { coastBoardwalk, coastDeckHeight, coastLanding } from './coastal-islet';
import { createIslandPropBuilder, IslandPropGeometry, type PropPoint } from './IslandPropGeometry';

type Builder = ReturnType<typeof createIslandPropBuilder>;

const pools = [
  { x: -1.37, z: 5.31, rx: 0.69, rz: 0.93, angle: -0.24 },
  { x: -0.89, z: 7.16, rx: 0.94, rz: 0.78, angle: 0.19 },
  { x: -2.2, z: 7.71, rx: 0.32, rz: 0.55, angle: -0.34 },
];
const poolSides = 28;
const rimY = -0.075;
const waterY = -0.206;
const poolWaterScale = 0.8;

function triangles(builder: Builder, positions: number[], tint: string) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  builder.add(geometry, [0, 0, 0], tint);
}

function surfaceBand(
  builder: Builder,
  upper: PropPoint[],
  lower: PropPoint[],
  tint: string,
  inside = false,
) {
  const positions: number[] = [];
  upper.forEach((point, index) => {
    const next = (index + 1) % upper.length;
    const a = upper[next]!;
    const b = lower[index]!;
    const c = lower[next]!;
    if (inside) positions.push(...point, ...b, ...a, ...a, ...b, ...c);
    else positions.push(...point, ...a, ...b, ...a, ...c, ...b);
  });
  triangles(builder, positions, tint);
}

function ringDisk(builder: Builder, ring: PropPoint[], center: PropPoint, tint: string) {
  const positions = ring.flatMap((point, index) => [
    ...center,
    ...ring[(index + 1) % ring.length]!,
    ...point,
  ]);
  triangles(builder, positions, tint);
}

function poolPoint(
  pool: (typeof pools)[number],
  angle: number,
  scale: number,
  y: number,
): PropPoint {
  const wobble = 1 + Math.sin(angle * 3 + pool.angle) * 0.068 + Math.cos(angle * 5) * 0.041;
  const x = pool.rx * Math.cos(angle) * scale * wobble;
  const z = pool.rz * Math.sin(angle) * scale * wobble;
  const cos = Math.cos(pool.angle);
  const sin = Math.sin(pool.angle);
  return [pool.x + x * cos - z * sin, y, pool.z + x * sin + z * cos];
}

function poolRing(pool: (typeof pools)[number], scale: number, y: number) {
  return Array.from({ length: poolSides }, (_, i) =>
    poolPoint(pool, (i * Math.PI * 2) / poolSides, scale, y),
  );
}

function isletRock(builder: Builder) {
  const layers = [
    { scale: 1, y: rimY, shift: 0, tint: '#9c9c7d' },
    { scale: 1.025, y: -0.28, shift: 0.045, tint: '#828973' },
    { scale: 0.98, y: -0.48, shift: -0.026, tint: '#a39c8b' },
    { scale: 1.012, y: -0.67, shift: -0.07, tint: '#777b74' },
    { scale: 0.91, y: -0.89, shift: -0.03, tint: '#8f9084' },
    { scale: 0.86, y: -1.21, shift: -0.17, tint: '#676f6c' },
    { scale: 0.69, y: -1.46, shift: -0.24, tint: '#7d7f76' },
    { scale: 0.48, y: -1.98, shift: -0.54, tint: '#62676c' },
    { scale: 0.23, y: -2.62, shift: -0.84, tint: '#505966' },
  ];
  const rings = layers.map(({ scale, y, shift }, layer) =>
    Array.from({ length: 38 }, (_, i): PropPoint => {
      const angle = (i * Math.PI * 2) / 38;
      const outline = 1 + Math.sin(angle * 3 - 0.62) * 0.076 + Math.cos(angle * 5 + 0.81) * 0.05;
      const stratum = layer ? Math.sin(angle * 4 + layer * 0.43) * (0.028 + layer * 0.018) : 0;
      return [
        -0.1 + Math.cos(angle) * 2.8 * scale * outline + shift,
        y + stratum,
        6.7 + Math.sin(angle) * 3.02 * scale * outline - shift * 0.28,
      ];
    }),
  );
  for (let layer = 1; layer < rings.length; layer++)
    surfaceBand(builder, rings[layer - 1]!, rings[layer]!, layers[layer]!.tint);
  const lowRing = rings.at(-1)!;
  const underside: PropPoint = [-0.98, -3.18, 7.07];
  triangles(
    builder,
    lowRing.flatMap((point, i) => [...point, ...lowRing[(i + 1) % lowRing.length]!, ...underside]),
    '#4a5360',
  );

  const shore = rings[0]!;
  const rims = pools.map((pool) => poolRing(pool, 1, rimY));
  const project = (ring: PropPoint[]) => ring.map(([x, , z]) => new THREE.Vector2(x, -z));
  const vertices = [...shore, ...rims.flat()];
  const faces = THREE.ShapeUtils.triangulateShape(project(shore), rims.map(project));
  triangles(
    builder,
    faces.flatMap((face) => face.flatMap((i) => vertices[i]!)),
    layers[0]!.tint,
  );

  pools.forEach((pool, i) => {
    const shelf = poolRing(pool, 0.89, -0.156);
    const waterline = poolRing(pool, poolWaterScale, waterY);
    const bed = poolRing(pool, 0.53, -0.384);
    surfaceBand(builder, rims[i]!, shelf, '#beb39a', true);
    surfaceBand(builder, shelf, waterline, '#9b9f83', true);
    surfaceBand(builder, waterline, bed, '#718679', true);
    ringDisk(builder, bed, [pool.x, -0.43, pool.z], '#526c63');
  });
}

function tidalPools(builder: Builder) {
  for (const pool of pools) {
    const core = poolRing(pool, 0.38, waterY);
    const shallows = poolRing(pool, 0.64, waterY);
    const bank = poolRing(pool, poolWaterScale, waterY);
    ringDisk(builder, core, [pool.x, waterY, pool.z], '#377a7c');
    surfaceBand(builder, shallows, core, '#4c9b94', true);
    surfaceBand(builder, bank, shallows, '#74b4a3', true);

    // Broken highlights follow the contours of each basin.
    for (const [radius, start, sweep] of [
      [0.48, 0.28, 1.7],
      [0.68, 0.57, 1.2],
      [0.69, 3.84, 1.08],
    ] as const) {
      const positions: number[] = [];
      const edges = Array.from({ length: 11 }, (_, i) => {
        const t = i / 10;
        const width = Math.sin(t * Math.PI) * 0.019 + 0.002;
        const angle = start + sweep * t + pool.angle;
        return [-1, 1].map((side) => poolPoint(pool, angle, radius + side * width, waterY + 0.003));
      });
      for (let i = 1; i < edges.length; i++) {
        const [a, b] = edges[i - 1]!;
        const [c, d] = edges[i]!;
        positions.push(...a!, ...c!, ...b!, ...b!, ...c!, ...d!);
      }
      triangles(builder, positions, '#b4d0b6');
    }
  }
}

const deckColors = ['#ad8d65', '#b99972', '#a48260', '#b4946d', '#bfa07a'];

function deckPlank(builder: Builder, x: number, z: number, size: PropPoint, tint: string, lip = 0) {
  const geometry = new THREE.BoxGeometry(...size);
  // Both plank ends lie on the same height profile used by the characters.
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++)
    position.setY(i, position.getY(i) + coastDeckHeight(z + position.getZ(i)));
  geometry.computeVertexNormals();
  builder.add(geometry, [x, -size[1] / 2 - lip, z], tint);
}

function boardwalk(builder: Builder, lights: Builder) {
  const { width, rampLength, junctionZ, lookoutX, lookoutZ } = coastBoardwalk;
  const half = width / 2;
  // Butt the sections together at the turns and keep each seam above a continuous backing.
  const sections = [
    { left: -half, right: half, near: 0, far: rampLength },
    { left: -half, right: half, near: rampLength, far: junctionZ - half },
    {
      left: -half,
      right: lookoutX + half,
      near: junctionZ - half,
      far: junctionZ + half,
      cross: true,
    },
    { left: lookoutX - half, right: lookoutX + half, near: junctionZ + half, far: lookoutZ + half },
  ];
  for (const { left, right, near, far, cross } of sections) {
    const length = far - near;
    const span = right - left;
    deckPlank(
      builder,
      (left + right) / 2,
      (near + far) / 2,
      [span, 0.092, length],
      '#806747',
      0.008,
    );
    const rows = Math.ceil((cross ? span : length) / 0.247);
    for (let row = 0; row < rows; row++) {
      const t = (row + 0.5) / rows;
      deckPlank(
        builder,
        cross ? left + t * span : (left + right) / 2,
        cross ? (near + far) / 2 : near + t * length,
        cross ? [span / rows - 0.009, 0.045, length] : [span, 0.045, length / rows - 0.009],
        deckColors[row % deckColors.length]!,
      );
    }
  }

  const start = 1.76;
  const end = 4.32;
  for (const side of [-1, 1]) {
    const x = side * (half - 0.037);
    builder.beam([x, -0.1, start - 0.22], [x, -0.1, end + 0.2], 0.144, '#685c4a');
    for (const z of [start, end]) {
      builder.box([x, -0.06, z], [0.22, 0.36, 0.44], '#9d9481');
      builder.box([x, 0.43, z], [0.127, 0.61, 0.127], '#6d6553');
      builder.box([x, 0.735, z], [0.17, 0.08, 0.17], '#9e8a65');
    }
    for (const y of [0.48, 0.65]) {
      const rope = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(x, y, start),
        new THREE.Vector3(x, y - 0.15, (start + end) / 2),
        new THREE.Vector3(x, y, end),
      );
      builder.add(new THREE.TubeGeometry(rope, 18, 0.018, 5, false), [0, 0, 0], '#857550');
    }
    for (let i = 1; i < 7; i++) {
      const t = i / 7;
      const z = start + (end - start) * t;
      builder.beam([x, 0.14, z], [x, 0.65 - 0.3 * (1 - t) * t, z], 0.021, '#8d7a58');
    }
  }
  builder.beam([-half, -0.25, start], [half, -0.18, end], 0.095, '#716554');
  builder.beam([half, -0.24, start], [-half, -0.2, end], 0.095, '#716554');

  const apronFar = lookoutZ + half - 0.065;
  const railing: [number, number][] = [
    [lookoutX - half + 0.06, junctionZ + half],
    [lookoutX - half + 0.06, apronFar],
    [lookoutX + half - 0.06, apronFar],
    [lookoutX + half - 0.06, junctionZ - half + 0.06],
    [half + 0.07, junctionZ - half + 0.06],
  ];
  railing.forEach(([x, z], index) => {
    builder.box([x, 0.37, z], [0.088, 0.46, 0.088], '#82745e');
    const next = railing[index + 1];
    if (!next) return;
    for (const y of [0.37, 0.59]) builder.beam([x, y, z], [next[0], y, next[1]], 0.048, '#8a7859');
  });

  // Low lamps mark the entrance and the turn without covering the tidal pools.
  for (const [x, z] of [
    [-0.73, 1.8],
    [0.73, 1.8],
    [-0.62, 4.61],
    [2.04, 6.46],
  ] as const) {
    builder.box([x, 0.15, z], [0.22, 0.36, 0.22], '#7a7b6b');
    builder.box([x, 0.35, z], [0.19, 0.08, 0.19], '#91846a');
    lights.box([x, 0.417, z], [0.145, 0.095, 0.145], '#d8b980');
    builder.add(new THREE.ConeGeometry(0.146, 0.095, 4), [x, 0.51, z], '#656e6b', [
      0,
      Math.PI / 4,
      0,
    ]);
  }
}

function beacon(builder: Builder, lights: Builder) {
  const x = -0.73;
  const z = 8.81;
  const course = (top: number, bottom: number, height: number, y: number, tint: string) =>
    builder.add(new THREE.CylinderGeometry(top, bottom, height, 12), [x, y, z], tint);

  course(0.55, 0.68, 0.19, 0.01, '#9f9b89');
  course(0.5, 0.57, 0.16, 0.145, '#c1b69e');
  course(0.425, 0.478, 0.72, 0.562, '#d5c7a7');
  course(0.392, 0.425, 0.39, 1.117, '#aa6755');
  course(0.347, 0.392, 0.55, 1.587, '#dfcfad');
  course(0.48, 0.345, 0.15, 1.937, '#79756b');
  course(0.475, 0.48, 0.075, 2.05, '#b1a384');
  course(0.362, 0.426, 0.13, 2.137, '#477571');
  lights.add(new THREE.CylinderGeometry(0.337, 0.337, 0.38, 12), [x, 2.37, z], '#f3cd8e');
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    const px = x + Math.cos(angle) * 0.359;
    const pz = z + Math.sin(angle) * 0.359;
    builder.beam([px, 2.155, pz], [px, 2.597, pz], 0.047, '#536563');
  }
  course(0.477, 0.392, 0.11, 2.608, '#597673');
  course(0.105, 0.477, 0.29, 2.808, '#4f7573');
  course(0.065, 0.105, 0.12, 3.013, '#686e61');
  builder.add(new THREE.SphereGeometry(0.064, 9, 6), [x, 3.115, z], '#9c885d');

  // Weathered door, lintel and sill face the lookout.
  builder.box([x + 0.446, 0.509, z], [0.09, 0.571, 0.335], '#9d9b85');
  builder.box([x + 0.493, 0.493, z], [0.039, 0.508, 0.259], '#657a70');
  builder.box([x + 0.517, 0.51, z + 0.083], [0.021, 0.029, 0.032], '#c1ac78');
  builder.box([x + 0.49, 0.227, z], [0.231, 0.064, 0.425], '#b1a794');
  builder.add(
    new THREE.CylinderGeometry(0.094, 0.094, 0.044, 12),
    [x + 0.35, 1.646, z],
    '#7e897d',
    [0, 0, Math.PI / 2],
  );
  builder.add(
    new THREE.CylinderGeometry(0.065, 0.065, 0.045, 12),
    [x + 0.368, 1.646, z],
    '#4c6d6b',
    [0, 0, Math.PI / 2],
  );
}

function shoreDetails(builder: Builder) {
  const rocks = [
    [-0.8, 4.03, 0.26],
    [-1.51, 4.33, 0.36],
    [-2.29, 5.35, 0.27],
    [-2.47, 6.19, 0.41],
    [-2.63, 6.91, 0.32],
    [-1.81, 8.46, 0.29],
    [-1.57, 9.1, 0.24],
    [0.42, 7.23, 0.16],
    [0.44, 8.97, 0.22],
    [2.24, 5.73, 0.28],
    [2.31, 7.3, 0.32],
    [1.89, 8.86, 0.26],
  ];
  const colors = ['#9e9b8d', '#858c7b', '#b1a793'];
  rocks.forEach(([x, z, size], i) => {
    builder.add(
      new THREE.DodecahedronGeometry(1).scale(size!, size! * 0.6, size! * 0.77),
      [x!, -0.071, z!],
      colors[i % colors.length]!,
      [i * 0.7, i * 0.91, i * 0.32],
    );
  });

  const tufts = [
    [-1.61, 4.34],
    [-2.28, 5.85],
    [-2.46, 6.51],
    [-1.82, 8.32],
    [-1.4, 9.02],
    [0.42, 7.47],
    [0.59, 8.57],
    [2.24, 6.73],
    [1.97, 8.82],
  ];
  const foliage = ['#6b846d', '#809977', '#969c72'];
  tufts.forEach(([x, z], i) => {
    for (let blade = 0; blade < 7; blade++) {
      const angle = blade * 2.399963 + i * 0.59;
      const reach = 0.09 + (blade % 3) * 0.042;
      const px = Math.cos(angle) * reach;
      const pz = Math.sin(angle) * reach;
      builder.beam(
        [x!, rimY, z!],
        [x! + px, rimY + 0.133 + (blade % 4) * 0.036, z! + pz],
        0.029,
        foliage[blade % foliage.length]!,
      );
    }
  });
}

export function createCoastalSurfaces() {
  const structure = createIslandPropBuilder();
  const water = createIslandPropBuilder();
  const lights = createIslandPropBuilder();
  isletRock(structure);
  tidalPools(water);
  boardwalk(structure, lights);
  beacon(structure, lights);
  shoreDetails(structure);
  return { structure: structure.finish(), water: water.finish(), lights: lights.finish() };
}

export function CoastalIslet() {
  const { structure, water, lights } = useMemo(createCoastalSurfaces, []);
  return (
    <group name="coastal-islet" position={[coastLanding[0], 0, coastLanding[1]]}>
      <mesh name="coast-rock-and-boardwalk" receiveShadow castShadow>
        <IslandPropGeometry surface={structure} />
        <meshStandardMaterial vertexColors roughness={0.87} />
      </mesh>
      <mesh name="coast-tidal-pools" receiveShadow>
        <IslandPropGeometry surface={water} />
        <meshStandardMaterial vertexColors roughness={0.26} metalness={0.06} />
      </mesh>
      <mesh name="coast-beacon-light">
        <IslandPropGeometry surface={lights} />
        <meshStandardMaterial
          vertexColors
          emissive="#e8ae66"
          emissiveIntensity={0.57}
          roughness={0.32}
        />
      </mesh>
    </group>
  );
}
