import { useMemo } from 'react';
import * as THREE from 'three';
import { createIslandPropBuilder, IslandPropGeometry, type PropPoint } from './IslandPropGeometry';
import { laneCenterline } from './harbor-lane';
import { harborStreetHeight } from './harbor-layout';
import type { GroundPoint } from './island-motion';

type Builder = ReturnType<typeof createIslandPropBuilder>;

const apron: GroundPoint[] = [
  [7.62, -0.72],
  [8.81, -1.45],
  [11.57, -1.57],
  [12.76, -0.95],
  [13.17, 0.25],
  [13.05, 2.12],
  [12.37, 3.06],
  [8.05, 3.06],
  [7.73, 2.32],
];
const dockX = laneCenterline[4][0];
const dockFront = 4.83;
const dockRailZ = 4.67;
const dockBack = 2.92;
const deckWidth = 1.26;
const waterY = -0.485;

function outline(points: GroundPoint[]) {
  return new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
}

function stoneApron(b: Builder) {
  const slabTop = 0.013;
  const slabBase = -0.58;
  const foundation = new THREE.ExtrudeGeometry(outline(apron), {
    depth: slabTop - slabBase,
    bevelEnabled: false,
  }).rotateX(-Math.PI / 2);
  b.add(foundation, [0, slabBase, 0], '#a29781');
  const lowerShelf = apron.map(
    ([x, z]): GroundPoint => [10.15 + (x - 10.15) * 0.83, 0.69 + (z - 0.69) * 0.85],
  );
  b.add(
    new THREE.ExtrudeGeometry(outline(lowerShelf), {
      depth: 0.63,
      bevelEnabled: false,
    }).rotateX(-Math.PI / 2),
    [0, -1.12, 0],
    '#727b76',
  );
  for (let i = 1; i < apron.length; i++) {
    const [ax, az] = apron[i - 1]!;
    const [bx, bz] = apron[i]!;
    const length = Math.hypot(bx - ax, bz - az);
    const stones = Math.ceil(length / 0.56);
    const yaw = -Math.atan2(bz - az, bx - ax);
    for (let tier = 0; tier < 3; tier++) {
      for (let j = 0; j < stones; j++) {
        const progress = (j + (tier === 1 ? 0.4 : 0.5)) / stones;
        const x = THREE.MathUtils.lerp(ax, bx, progress);
        const z = THREE.MathUtils.lerp(az, bz, progress);
        if (z >= 3.02 && Math.abs(x - dockX) < 0.72 && tier === 2) continue;
        const tint = ['#888e81', '#a3a18d', '#beb09a'][tier]!;
        b.box([x, -0.41 + tier * 0.21, z], [length / stones - 0.026, 0.17, 0.15], tint, [
          0,
          yaw,
          0,
        ]);
      }
    }
  }
  for (let i = 1; i + 1 < apron.length; i++) {
    const [x, z] = apron[i]!;
    b.add(
      new THREE.DodecahedronGeometry(1).scale(0.68, 0.47, 0.56),
      [x * 0.98, -0.93 - 0.077 * (i % 3), z * 0.94],
      i % 2 ? '#7c847b' : '#888e80',
      [0.33, i * 0.8, -0.19],
    );
  }

  const pavers = ['#bcad94', '#cbbaa1', '#c2b49d', '#c8b598', '#d0bea3'];
  const borders = laneCenterline.slice(1).map(([x, z], index) => {
    const [fromX, fromZ] = laneCenterline[index]!;
    return [
      Math.min(x, fromX),
      Math.max(x, fromX),
      Math.min(z, fromZ),
      Math.max(z, fromZ),
    ] as const;
  });
  for (let row = 0; row < 4; row++) {
    b.box(
      [7.77, harborStreetHeight - 0.012, 1.59 + row * 0.227],
      [0.23, 0.024, 0.216],
      pavers[row]!,
    );
  }
  for (let row = 0; row < 14; row++) {
    const z = -0.09 + row * 0.227;
    for (let column = 0; column < 12; column++) {
      const x = 8.07 + (column + (row % 2) * 0.5) * 0.35;
      const paved = borders.some(
        ([left, right, back, front]) =>
          x > left - 0.53 && x < right + 0.53 && z > back - 0.53 && z < front + 0.53,
      );
      if (!paved || (z > dockBack - 0.11 && Math.abs(x - dockX) < deckWidth / 2)) continue;
      b.box(
        [x, harborStreetHeight - 0.012, z],
        [0.337, 0.024, 0.216],
        pavers[(row * 7 + column * 3 + (column % 4)) % pavers.length]!,
      );
    }
  }
}

function sailLoft(b: Builder) {
  const x = 10.24;
  const z = -0.91;
  const timber = '#536e6c';
  const trim = '#9f9076';
  const roof = ['#955e49', '#a36a50', '#ae775a', '#98604d'];
  const front = z + 0.43;
  b.box([x, 0.095, z], [2.07, 0.17, 1.03], '#85897b');
  b.box([x, 0.75, z - 0.41], [1.95, 1.22, 0.12], timber);
  for (const side of [-1, 1]) {
    b.box([x + side * 0.94, 0.75, z], [0.12, 1.22, 0.89], timber);
    b.box([x + side * 0.63, 0.75, front], [0.61, 1.22, 0.1], timber);
    b.box([x + side * 0.91, 0.74, front + 0.07], [0.09, 1.33, 0.1], trim);
    b.box([x + side * 0.31, 0.73, front + 0.07], [0.065, 1.15, 0.08], trim);
    for (let strip = 0; strip < 5; strip++) {
      b.box(
        [x + side * (0.37 + strip * 0.11), 0.76, front + 0.056],
        [0.018, 1.16, 0.02],
        '#435e5d',
      );
    }
    const angle = side * Math.atan2(0.39, 0.62);
    for (let strip = 0; strip < 15; strip++) {
      b.box(
        [x - 1.04 + 0.15 * strip, 1.535, z + side * 0.31],
        [0.148, 0.064, 0.745],
        roof[(strip + (side < 0 ? 2 : 0)) % roof.length]!,
        [angle, 0, 0],
      );
    }
    b.box([x, 1.345, z + side * 0.62], [2.31, 0.101, 0.096], '#775648');
  }
  b.box([x, 1.738, z], [2.3, 0.086, 0.12], '#754d3d');
  b.box([x, 1.27, front], [1.94, 0.2, 0.13], '#6f7c70');
  b.box([x, 0.65, z + 0.05], [0.65, 0.97, 0.07], '#384c4d');
  b.box([x, 0.5, front - 0.08], [0.56, 0.078, 0.41], '#9d7954');
  b.box([x - 0.66, 0.92, front + 0.078], [0.31, 0.3, 0.03], '#b99c68');
  b.box([x - 0.66, 0.92, front + 0.097], [0.018, 0.31, 0.027], '#64766b');
  b.box([x - 0.66, 0.92, front + 0.097], [0.32, 0.018, 0.027], '#64766b');
  b.box([x + 0.64, 1.09, front + 0.07], [0.41, 0.26, 0.045], '#385b5e');
  b.beam([x + 0.54, 1.02, front + 0.101], [x + 0.64, 1.19, front + 0.101], 0.022, '#e6d6b0');
  b.beam([x + 0.64, 1.19, front + 0.101], [x + 0.74, 1.02, front + 0.101], 0.022, '#e6d6b0');
  b.beam([x + 0.54, 1.02, front + 0.101], [x + 0.74, 1.02, front + 0.101], 0.022, '#e6d6b0');
}

function sailRack(b: Builder) {
  const left = 9.86;
  const right = 10.73;
  const z = 2.32;
  const frame = '#796348';
  for (const x of [left, right]) {
    b.box([x, 0.86, z], [0.08, 1.7, 0.086], frame);
    b.beam([x, 0.075, z - 0.34], [x, 0.43, z], 0.065, '#947754');
    b.beam([x, 0.075, z + 0.26], [x, 0.43, z], 0.065, '#947754');
  }
  b.beam([left - 0.06, 1.65, z], [right + 0.06, 1.65, z], 0.08, '#9d825a');
  b.beam([left, 0.32, z], [right, 0.32, z], 0.056, frame);

  const sailPoint = (drop: number, across: number): PropPoint => [
    left + 0.27 + (across * 0.68 - 0.29) * drop,
    1.6 - 1.23 * drop + across * 0.25 * drop,
    z + 0.022 + 0.17 * Math.sin(drop * 2.77) * Math.sin(Math.PI * across),
  ];
  const points = [
    sailPoint(0, 0),
    sailPoint(0.45, 0),
    sailPoint(0.45, 0.5),
    sailPoint(0.45, 1),
    sailPoint(1, 0),
    sailPoint(1, 0.5),
    sailPoint(1, 1),
  ];
  const cloth = new THREE.BufferGeometry();
  cloth.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  cloth.setIndex([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3]);
  cloth.computeVertexNormals();
  b.add(cloth, [0, 0, 0], '#eadbb6');
  for (const [a, c] of [
    [0, 1],
    [1, 4],
    [0, 3],
    [3, 6],
    [4, 5],
    [5, 6],
    [1, 2],
    [2, 3],
  ] as const) {
    b.beam(points[a]!, points[c]!, 0.013, '#a98f66');
  }
  b.beam(points[0]!, [left + 0.27, 1.68, z], 0.013, '#b19266');
  b.beam(points[4]!, [left, 0.34, z], 0.016, '#b19266');
  b.beam(points[6]!, [right, 0.32, z], 0.016, '#b19266');

  // The cutting table and rolled cloth sit in the middle of the bend.
  const benchX = 10.31;
  const benchZ = 1.28;
  for (const x of [benchX - 0.43, benchX + 0.43]) {
    for (const end of [-1, 1]) {
      b.box([x, 0.33, benchZ + end * 0.14], [0.073, 0.63, 0.073], frame);
    }
  }
  b.box([benchX, 0.63, benchZ], [1.02, 0.071, 0.47], '#ad8a5c');
  b.box([benchX + 0.28, 0.691, benchZ - 0.07], [0.31, 0.052, 0.23], '#788b7a');
  b.add(
    new THREE.CylinderGeometry(0.06, 0.06, 0.48, 8),
    [benchX - 0.19, 0.72, benchZ + 0.08],
    '#e0c794',
    [0, 0, Math.PI / 2],
  );
  for (const [x, crateZ] of [
    [12.43, 0.76],
    [12.66, 1.46],
    [10.46, 2.72],
  ] as const) {
    b.box([x, 0.175, crateZ], [0.35, 0.32, 0.35], '#92724e');
    for (const offset of [-0.11, 0.11]) {
      b.box([x + offset, 0.342, crateZ], [0.036, 0.027, 0.38], '#ba9a66');
    }
  }
}

function addPier(ground: Builder, props: Builder) {
  const plankCount = 13;
  const pitch = (dockFront - dockBack) / plankCount;
  for (let i = 0; i < plankCount; i++) {
    ground.box(
      [dockX, harborStreetHeight - 0.037, dockBack + (i + 0.5) * pitch],
      [deckWidth, 0.074, pitch - 0.008],
      ['#a98a63', '#b99a71', '#b09168'][i % 3]!,
    );
  }
  const timber = '#826c50';
  for (const side of [-1, 1]) {
    const x = dockX + side * 0.56;
    ground.beam([x, -0.09, dockBack], [x, -0.09, dockFront], 0.11, timber);
    for (const z of [3.13, dockRailZ]) {
      props.box([x, -0.264, z], [0.123, 1.04, 0.128], timber);
      props.box([x, 0.268, z], [0.14, 0.035, 0.145], '#b69b72');
    }
    for (const z of [3.5, 4.17]) {
      props.add(
        new THREE.TorusGeometry(0.13, 0.034, 5, 9),
        [x + side * 0.09, -0.232, z],
        '#4b5250',
        [0, Math.PI / 2, 0],
      );
    }
  }
  props.beam([dockX - 0.56, 0.205, 3.11], [dockX - 0.56, 0.205, dockRailZ], 0.058, '#a78b64');
  props.beam([dockX - 0.56, 0.205, dockRailZ], [dockX + 0.56, 0.205, dockRailZ], 0.058, '#a78b64');
  const lampX = dockX + 0.61;
  props.box([lampX, 0.68, 3.13], [0.074, 1.29, 0.072], '#586961');
  props.beam([lampX, 1.28, 3.13], [lampX + 0.26, 1.28, 3.13], 0.043, '#586961');
  props.add(
    new THREE.CylinderGeometry(0.075, 0.059, 0.14, 6),
    [lampX + 0.22, 1.172, 3.13],
    '#e3b978',
  );
  props.add(new THREE.ConeGeometry(0.096, 0.078, 6), [lampX + 0.22, 1.264, 3.13], '#8f7756');
}

function addTender(b: Builder) {
  const x = 12.57;
  const z = 4.37;
  const sections = [
    [-0.91, 0.26, 0.01],
    [-0.63, 0.41, 0],
    [-0.19, 0.43, -0.015],
    [0.3, 0.32, 0.01],
    [0.65, 0.16, 0.055],
    [0.91, 0.015, 0.12],
  ] as const;
  const ring = (width: number, y: number, rise: number) => {
    const half = (side: number) =>
      sections.map(
        ([length, beam, sheer]): PropPoint => [
          x + side * width * beam,
          y + sheer * rise,
          z + length * (0.83 + width * 0.17),
        ],
      );
    return [...half(-1), ...half(1).reverse()];
  };
  const rims = [ring(0.53, -0.59, 0.48), ring(0.94, -0.42, 0.65), ring(1, -0.3, 1)];
  for (let tier = 1; tier < rims.length; tier++) {
    const bottom = rims[tier - 1]!;
    const top = rims[tier]!;
    const count = bottom.length;
    const band = new THREE.BufferGeometry();
    band.setAttribute('position', new THREE.Float32BufferAttribute([...bottom, ...top].flat(), 3));
    band.setIndex(
      bottom.flatMap((_, i) => {
        const next = (i + 1) % count;
        return [i, next, i + count, next, next + count, i + count];
      }),
    );
    band.computeVertexNormals();
    b.add(band, [0, 0, 0], tier === 1 ? '#86594b' : '#658b84');
  }
  const sheer = rims[2]!;
  for (let i = 0; i < sheer.length; i++) {
    b.beam(sheer[i]!, sheer[(i + 1) % sheer.length]!, 0.037, '#c2a778');
  }
  b.box([x, -0.442, z - 0.08], [0.36, 0.066, 1.18], '#80664c');
  for (const offset of [-0.5, 0.06, 0.45]) {
    b.box([x, -0.32, z + offset], [offset > 0.4 ? 0.47 : 0.72, 0.042, 0.137], '#b8996c');
  }
  for (const [dockZ, boatZ] of [
    [3.16, 3.47],
    [dockRailZ, 5.27],
  ] as const) {
    const rope = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(dockX + 0.56, 0.25, dockZ),
      new THREE.Vector3(dockX + 0.93, -0.37, (dockZ + boatZ) / 2),
      new THREE.Vector3(x, -0.233, boatZ),
    );
    b.add(new THREE.TubeGeometry(rope, 8, 0.016, 5, false), [0, 0, 0], '#bba87e');
  }
  b.beam([x + 0.16, -0.26, z - 0.7], [x + 0.21, -0.26, z + 0.63], 0.023, '#a78354');
  b.box([x + 0.2, -0.26, z + 0.58], [0.12, 0.026, 0.29], '#c2a16c', [0, -0.07, 0]);
}

function buildLane() {
  const ground = createIslandPropBuilder();
  const props = createIslandPropBuilder();
  const surface = createIslandPropBuilder();
  stoneApron(ground);
  sailLoft(props);
  sailRack(props);
  addPier(ground, props);
  addTender(props);
  const basin = new THREE.ShapeGeometry(
    outline([
      [7.25, 2.83],
      [12.39, 2.81],
      [13.33, 3.27],
      [13.65, 4.17],
      [13.66, 5.2],
      [12.79, 5.64],
      [10.56, 5.85],
      [8.47, 5.73],
      [7.12, 5.49],
    ]),
  ).rotateX(-Math.PI / 2);
  surface.add(basin, [0, waterY, 0], '#417b85');
  const water = surface.finish();
  const deep = new THREE.Color('#417b85');
  const near = new THREE.Color('#83b6b0');
  const tint = new THREE.Color();
  for (let i = 0; i < water.position.length; i += 3) {
    const shoreline = THREE.MathUtils.clamp((water.position[i + 2]! - 2.8) / 3.1, 0, 1);
    tint.copy(deep).lerp(near, shoreline).toArray(water.color, i);
  }
  return { ground: ground.finish(), props: props.finish(), water };
}

export function HarborLane() {
  const { ground, props, water } = useMemo(buildLane, []);
  return (
    <group name="harbor-sailmaker-lane">
      <mesh name="harbor-lane-paving" receiveShadow>
        <IslandPropGeometry surface={ground} />
        <meshStandardMaterial vertexColors roughness={0.88} />
      </mesh>
      <mesh name="harbor-sailmaker-yard" castShadow receiveShadow>
        <IslandPropGeometry surface={props} />
        <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.85} />
      </mesh>
      <mesh name="harbor-sailmaker-basin">
        <IslandPropGeometry surface={water} />
        <meshStandardMaterial vertexColors roughness={0.27} metalness={0.12} />
      </mesh>
    </group>
  );
}
