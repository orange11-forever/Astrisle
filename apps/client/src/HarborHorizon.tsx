import { useMemo } from 'react';
import { Color, DoubleSide } from 'three';

type Layer = { positions: number[]; colors: number[]; triangles: number[] };
type Row = readonly [height: number, color: Color, opacity: number];
type Formation = readonly [
  bearing: number,
  radius: number,
  altitude: number,
  width: number,
  height: number,
  detail?: number,
];

const distantRidges: Formation[] = [
  [0.22, 169, -40, 61, 14, 4],
  [0.87, 177, -36, 48, 10, 1],
  [1.47, 170, -44, 69, 16, 3],
  [2.17, 176, -39, 54, 9, 7],
  [2.86, 162, -37, 57, 15, 2],
  [3.53, 172, -42, 68, 14, 7],
  [4.06, 181, -40, 72, 12, 4],
  [4.61, 164, -43, 60, 18, 5],
  [5.25, 177, -38, 59, 13, 4],
  [5.91, 166, -42, 63, 11, 9],
];
const cloudBanks: Formation[] = [
  [0.16, 129, -35, 67, 10, 2],
  [0.68, 148, -27, 52, 8, 3],
  [1.26, 133, -41, 73, 12, 5],
  [1.89, 126, -30, 58, 8, 6],
  [2.57, 145, -35, 73, 12, 2],
  [3.2, 132, -31, 66, 9, 7],
  [3.61, 141, -37, 73, 13, 3],
  [4.16, 151, -33, 86, 10, 1],
  [4.63, 139, -33, 60, 14, 7],
  [5.17, 125, -36, 53, 9, 6],
  [5.8, 152, -30, 72, 10, 4],
];
const islands: Formation[] = [
  [0.37, 117, -25, 18, 3.6, 2],
  [0.91, 107, -33, 11, 3.2],
  [1.48, 128, -25, 21, 4.4, 3],
  [1.92, 113, -31, 10, 2.8],
  [2.56, 122, -27, 17, 4.1, 3],
  [3.16, 117, -29, 12, 3.1],
  [3.77, 117, -40, 19, 3.9, 2],
  [4.1, 128, -43, 13, 3.3],
  [4.53, 125, -29, 19, 4.5, 3],
  [5.14, 106, -34, 12, 3],
  [5.7, 124, -26, 17, 4.7, 2],
  [6.17, 108, -31, 10, 2.6],
];

function createLayer(): Layer {
  return { positions: [], colors: [], triangles: [] };
}

function addArc(
  layer: Layer,
  bearing: number,
  radius: number,
  span: number,
  segments: number,
  rowsAt: (progress: number) => Row[],
) {
  const start = layer.positions.length / 3;
  for (let column = 0; column <= segments; column++) {
    const progress = column / segments;
    const angle = bearing + span * (progress - 0.5);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const rows = rowsAt(progress);
    for (const [y, color, opacity] of rows) {
      layer.positions.push(x, y, z);
      layer.colors.push(color.r, color.g, color.b, opacity);
    }
    if (column === 0) continue;
    for (let row = 1; row < rows.length; row++) {
      const index = start + column * rows.length + row;
      const previous = index - rows.length;
      layer.triangles.push(previous - 1, index - 1, previous, previous, index - 1, index);
    }
  }
}

function buildDistantHaze() {
  const layer = createLayer();
  const navy = new Color('#344365');
  const mauve = new Color('#767b9d');
  const blue = new Color('#5c7a9c');
  addArc(layer, 0, 198, Math.PI * 2, 96, (progress) => {
    const angle = progress * Math.PI * 2;
    const drift = 4 * Math.sin(angle * 3 + 1.2) + 3 * Math.cos(angle * 2);
    const light = 0.92 + 0.08 * Math.sin(angle * 4 - 0.5);
    return [
      [-100 + drift, navy, 0],
      [-71 + drift, navy, 0.28 * light],
      [-50 + drift, mauve, 0.28 * light],
      [-31 + drift, blue, 0.13 * light],
      [-13 + drift, blue, 0],
    ];
  });
  return layer;
}

function buildRidges() {
  const layer = createLayer();
  const crest = new Color('#696d8d');
  const face = new Color('#414868');
  const blue = new Color('#394966');
  const violet = new Color('#4f496a');
  const silhouette = [0, 0.13, 0.28, 0.51, 0.46, 0.74, 0.6, 1, 0.72, 0.54, 0.61, 0.33, 0.2, 0];
  for (const [bearing, radius, base, width, height, variation = 0] of distantRidges) {
    addArc(layer, bearing, radius, width / radius, silhouette.length - 1, (t) => {
      const taper = Math.sin(Math.PI * t);
      const crestHeight = silhouette[Math.round(t * (silhouette.length - 1))]!;
      const top = base + height * (crestHeight + 0.16 * taper * Math.sin(t * 12 + variation));
      return [
        [base - height * taper * (0.8 - 0.14 * Math.cos(t * 9 + variation)), violet, 0],
        [base - height * taper * 0.28, blue, 0.4 * taper],
        [top - height * taper * 0.16, face, 0.59 * taper],
        [top, crest, 0.43 * taper],
      ];
    });
  }
  return layer;
}

function buildClouds() {
  const layer = createLayer();
  const lavender = new Color('#73749a');
  const mist = new Color('#758da9');
  const blue = new Color('#5f7193');
  for (const [bearing, radius, base, width, height, detail = 0] of cloudBanks) {
    addArc(layer, bearing, radius, width / radius, 30, (t) => {
      const taper = Math.sin(t * Math.PI) ** 0.7;
      const eddies = 0.7 + 0.16 * Math.sin(t * 15 + detail) + 0.1 * Math.cos(t * 36 - detail);
      const center = base + height * (0.21 * Math.sin(t * 8 - detail) + 0.12 * t);
      const thickness = height * taper * eddies;
      return [
        [center - thickness * 0.7, blue, 0],
        [center - thickness * 0.24, blue, taper * 0.19],
        [center + thickness * 0.13, detail % 2 ? lavender : mist, taper * 0.24],
        [center + thickness * 0.46, mist, taper * 0.14],
        [center + thickness * 0.7, lavender, 0],
      ];
    });
  }
  return layer;
}

function buildIslands() {
  const layer = createLayer();
  const plateau = new Color('#475b78');
  const rim = new Color('#4c617e');
  const face = new Color('#33445d');
  const underside = new Color('#272d48');
  const foliage = new Color('#526681');
  const stone = new Color('#53617a');
  const lamp = new Color('#b3aba7');
  const skyline = [
    0, 0.14, 0.23, 0.48, 0.58, 0.53, 0.7, 0.72, 0.65, 0.55, 0.52, 0.34, 0.26, 0.1, 0,
  ];
  for (const [bearing, radius, base, width, height, beacon] of islands) {
    const relief = (t: number) => {
      const cell = t * (skyline.length - 1);
      const index = Math.min(Math.floor(cell), skyline.length - 2);
      const ridge = skyline[index]! + (skyline[index + 1]! - skyline[index]!) * (cell - index);
      return base + height * (ridge + Math.sin(Math.PI * t) * Math.sin(t * 13 + radius) * 0.1);
    };
    addArc(layer, bearing, radius, width / radius, skyline.length - 1, (t) => {
      const taper = Math.sin(Math.PI * t);
      const opacity = Math.min(1, taper * 3.6);
      const top = relief(t);
      const rock = 0.69 + 0.24 * Math.sin(t * 15 + radius) + 0.16 * Math.cos(t * 24);
      return [
        [base - height * rock * taper, underside, taper * 0.25],
        [base - height * 0.24 * taper, face, opacity * 0.46],
        [top - height * 0.13 * taper, plateau, opacity * 0.59],
        [top, rim, opacity * 0.55],
      ];
    });
    for (const [t, size, spread] of [
      [0.25, 0.7, 0.79],
      [0.31, 1.03, 0.89],
      [0.36, 0.77, 0.68],
      [0.7, 0.92, 1.12],
    ] as const) {
      const treeBase = relief(t) - 0.09;
      addArc(
        layer,
        bearing + ((t - 0.5) * width) / radius,
        radius - 0.06,
        spread / radius,
        4,
        (s) => {
          const crown = Math.sin(Math.PI * s) ** 0.64;
          return [
            [treeBase, face, crown * 0.36],
            [treeBase + size * 0.32 * crown, face, crown * 0.64],
            [treeBase + size * crown, foliage, crown * 0.51],
          ];
        },
      );
    }
    if (beacon) {
      const towerBase = relief(0.54) - 0.12;
      const towerTop = towerBase + beacon * 0.64;
      const towerBearing = bearing + (0.04 * width) / radius;
      addArc(layer, towerBearing, radius - 0.11, 0.66 / radius, 2, () => [
        [towerBase, face, 0.62],
        [towerTop - 0.24, stone, 0.65],
      ]);
      addArc(layer, towerBearing, radius - 0.12, 0.95 / radius, 2, () => [
        [towerTop - 0.24, stone, 0.62],
        [towerTop - 0.2, lamp, 0.59],
        [towerTop, lamp, 0.53],
      ]);
      addArc(layer, towerBearing, radius - 0.12, 1.23 / radius, 2, (t) => [
        [towerTop, face, 0.72],
        [towerTop + 0.49 * Math.sin(t * Math.PI), face, 0.64],
      ]);
    }
  }
  return layer;
}

/** Four static meshes form the distant haze and sit behind the working island. */
export function HarborHorizon() {
  const layers = useMemo(
    () =>
      [buildDistantHaze(), buildRidges(), buildClouds(), buildIslands()].map((layer) => ({
        position: new Float32Array(layer.positions),
        color: new Float32Array(layer.colors),
        index: new Uint16Array(layer.triangles),
      })),
    [],
  );
  return (
    <group name="harbor-horizon">
      {layers.map(({ position, color, index }, order) => (
        <mesh key={order} renderOrder={-18 + order}>
          <bufferGeometry>
            <bufferAttribute attach="index" args={[index, 1]} />
            <bufferAttribute attach="attributes-position" args={[position, 3]} />
            <bufferAttribute attach="attributes-color" args={[color, 4]} />
          </bufferGeometry>
          <meshBasicMaterial
            vertexColors
            transparent
            depthWrite={false}
            side={DoubleSide}
            toneMapped={false}
            fog={false}
          />
        </mesh>
      ))}
    </group>
  );
}
