import { useMemo } from 'react';
import * as THREE from 'three';
import { createIslandPropBuilder, IslandPropGeometry, type PropPoint } from './IslandPropGeometry';

type Builder = ReturnType<typeof createIslandPropBuilder>;
type Hull = { x: number; z: number; rim: number; length: number; beam: number };

const sailboat: Hull = { x: 3.8, z: 4.25, rim: -0.25, length: 2.88, beam: 0.92 };
const flowerSkiff: Hull = { x: -3.3, z: 4.2, rim: -0.29, length: 2.6, beam: 0.98 };

// The wide stern, tapering bow and raised ends let each sheerline read from above.
const stations = [
  [-0.5, 0.235, 0.043],
  [-0.44, 0.359, 0.005],
  [-0.28, 0.475, -0.008],
  [-0.06, 0.5, -0.016],
  [0.16, 0.44, 0],
  [0.32, 0.31, 0.035],
  [0.44, 0.139, 0.08],
  [0.5, 0.014, 0.114],
] as const;

type HullRing = { width: number; length: number; height: number; sheer: number };

function hullOutline(boat: Hull, ring: HullRing) {
  const half = (side: number) =>
    stations.map(
      ([x, z, height]): PropPoint => [
        boat.x + x * boat.length * ring.length,
        boat.rim + ring.height + height * ring.sheer,
        boat.z + side * z * boat.beam * ring.width,
      ],
    );
  return [...half(1), ...half(-1).reverse()];
}

function hullBand(lower: PropPoint[], upper: PropPoint[], inside = false) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([...lower, ...upper].flat(), 3),
  );
  const indices: number[] = [];
  const count = lower.length;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    if (inside) indices.push(i, count + i, next, next, count + i, count + next);
    else indices.push(i, next, count + i, next, count + next, count + i);
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function decking(outline: PropPoint[], underside = false) {
  const contour = outline.map(([x, , z]) => new THREE.Vector2(x, -z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(outline.flat(), 3));
  geometry.setIndex(faces.flatMap((face) => (underside ? face.reverse() : face)));
  geometry.computeVertexNormals();
  return geometry;
}

function addHull(builder: Builder, boat: Hull, painted: string, trim: string) {
  const baseline: PropPoint = [0, 0, 0];
  const bootTop = hullOutline(boat, { width: 0.98, length: 0.99, height: -0.185, sheer: 0.13 });
  const keel = hullOutline(boat, { width: 0.47, length: 0.83, height: -0.42, sheer: 0.21 });
  const side = hullOutline(boat, { width: 1, length: 1, height: -0.043, sheer: 1 });
  const gunwale = hullOutline(boat, { width: 1.025, length: 1.002, height: 0.008, sheer: 1 });
  const inner = hullOutline(boat, { width: 0.85, length: 0.962, height: -0.005, sheer: 1 });
  const floor = hullOutline(boat, { width: 0.66, length: 0.87, height: -0.15, sheer: 0 });
  builder.add(hullBand(keel, bootTop), baseline, '#354d51');
  builder.add(decking(keel, true), baseline, '#354d51');
  builder.add(hullBand(bootTop, side), baseline, painted);
  builder.add(hullBand(side, gunwale), baseline, trim);
  builder.add(hullBand(gunwale, inner), baseline, trim);
  builder.add(hullBand(floor, inner, true), baseline, '#826b51');
  builder.add(decking(floor), baseline, '#a68b65');
  for (const [x, width] of [
    [-0.87, 0.21],
    [0.64, 0.19],
  ] as const) {
    builder.box(
      [boat.x + x, boat.rim - 0.055, boat.z],
      [width, 0.046, boat.beam * 0.72],
      '#c3a778',
    );
    builder.box(
      [boat.x + x, boat.rim - 0.031, boat.z],
      [0.013, 0.003, boat.beam * 0.71],
      '#8e7355',
    );
  }
}

function line(builder: Builder, from: PropPoint, to: PropPoint, radius: number, tint: string) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const axis = end.clone().sub(start);
  const rotation = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize()),
  );
  builder.add(
    new THREE.CylinderGeometry(radius * 0.85, radius, axis.length(), 8),
    start.lerp(end, 0.5).toArray(),
    tint,
    [rotation.x, rotation.y, rotation.z],
  );
}

function addMooring(builder: Builder, boat: Hull) {
  for (const [bowOffset, breadth, cleatHeight] of [
    [-0.42, 0.345, 0.036],
    [0.36, 0.226, 0.073],
  ] as const) {
    const bowX = boat.x + bowOffset * boat.length;
    const quayX = bowX + Math.sign(bowOffset) * 0.39;
    const start = new THREE.Vector3(bowX, boat.rim + cleatHeight, boat.z - boat.beam * breadth);
    const end = new THREE.Vector3(quayX, 0.163, 2.8);
    const curve = new THREE.CubicBezierCurve3(
      start,
      start
        .clone()
        .lerp(end, 0.31)
        .add(new THREE.Vector3(0, -0.135, 0)),
      start
        .clone()
        .lerp(end, 0.73)
        .add(new THREE.Vector3(0, -0.099, 0)),
      end,
    );
    builder.add(new THREE.TubeGeometry(curve, 12, 0.016, 5, false), [0, 0, 0], '#bfa883');
    builder.box(start.toArray(), [0.087, 0.034, 0.045], '#9b8058');
    builder.box([quayX, 0.103, 2.8], [0.178, 0.047, 0.111], '#66584a');
    builder.box([quayX, 0.157, 2.8], [0.121, 0.032, 0.046], '#ac8e60');
    for (const offset of [-0.044, 0.044])
      builder.box([quayX + offset, 0.133, 2.8], [0.038, 0.064, 0.048], '#77664d');
  }
}

function addSails(builder: Builder, boat: Hull) {
  const mastX = boat.x - 0.2;
  const head: PropPoint = [mastX, 0.995, boat.z];
  line(builder, [mastX, boat.rim - 0.141, boat.z], [mastX, 1.11, boat.z], 0.027, '#926d4c');
  builder.add(new THREE.SphereGeometry(0.038, 9, 6), [mastX, 1.115, boat.z], '#be9a5e');
  line(builder, [mastX - 0.96, -0.01, boat.z], [mastX + 0.045, 0.078, boat.z], 0.018, '#78644f');
  line(builder, [mastX - 0.89, 0.012, boat.z], [mastX - 0.044, 0.086, boat.z], 0.052, '#e8d6ac');
  for (const offset of [0.18, 0.48, 0.77])
    line(
      builder,
      [mastX - offset, 0.074 - offset * 0.083, boat.z - 0.051],
      [mastX - offset, 0.074 - offset * 0.083, boat.z + 0.051],
      0.007,
      '#a68c62',
    );

  // A small, softly bowed staysail and a furled mainsail leave an open silhouette.
  const tack: PropPoint = [boat.x + 1.23, -0.015, boat.z + 0.016];
  const clew: PropPoint = [boat.x + 0.14, 0.114, boat.z + 0.055];
  const sailPoint = (drop: number, fraction: number): PropPoint => [
    THREE.MathUtils.lerp(head[0], THREE.MathUtils.lerp(tack[0], clew[0], fraction), drop),
    THREE.MathUtils.lerp(head[1], THREE.MathUtils.lerp(tack[1], clew[1], fraction), drop),
    THREE.MathUtils.lerp(head[2], THREE.MathUtils.lerp(tack[2], clew[2], fraction), drop) +
      Math.sin(drop * 2.32) * Math.sin(fraction * Math.PI) * 0.14,
  ];
  const rows = 8;
  const columns = 6;
  const vertices = [...head];
  const indices: number[] = [];
  for (let row = 1; row <= rows; row++) {
    const first = 1 + (row - 1) * (columns + 1);
    for (let column = 0; column <= columns; column++) {
      vertices.push(...sailPoint(row / rows, column / columns));
      if (column === columns) continue;
      const current = first + column;
      if (row === 1) indices.push(0, current, current + 1);
      else {
        const upper = current - columns - 1;
        indices.push(upper, current, current + 1, upper, current + 1, upper + 1);
      }
    }
  }
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  sail.setIndex(indices);
  sail.computeVertexNormals();
  builder.add(sail, [0, 0, 0], '#f3e3be');
  for (const drop of [0.54, 0.78, 0.995]) {
    const points = Array.from(
      { length: 8 },
      (_, index) => new THREE.Vector3(...sailPoint(drop, index / 7)),
    );
    builder.add(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 11, 0.006, 4, false),
      [0, 0, 0],
      '#cfb98f',
    );
  }
  line(builder, head, tack, 0.01, '#a18560');
  line(builder, head, [boat.x - 1.21, -0.115, boat.z - 0.31], 0.007, '#b9a684');
  line(builder, clew, [mastX, -0.085, boat.z], 0.007, '#c1ab86');
}

function addFlowerCargo(builder: Builder, boat: Hull) {
  const flowerColors = ['#d78f9a', '#e7b38a', '#f0dfb6', '#aa94be'];
  const containers = [
    [-0.6, -0.04, 0.43],
    [-0.075, 0.06, 0.44],
    [0.43, -0.055, 0.34],
  ] as const;
  containers.forEach(([offset, lateral, size], crate) => {
    const x = boat.x + offset;
    const z = boat.z + lateral;
    const floor = boat.rim - 0.1;
    for (const side of [-1, 1]) {
      for (const height of [0.048, 0.111]) {
        builder.box([x, floor + height, z + side * size * 0.42], [size, 0.047, 0.022], '#bc9865');
        builder.box(
          [x + side * size * 0.48, floor + height, z],
          [0.022, 0.047, size * 0.84],
          '#ac895b',
        );
      }
      for (const end of [-1, 1])
        builder.box(
          [x + side * size * 0.46, floor + 0.083, z + end * size * 0.4],
          [0.037, 0.164, 0.037],
          '#d4b587',
        );
    }
    builder.box([x, floor + 0.09, z], [size * 0.88, 0.052, size * 0.69], '#706e50');
    for (let bloom = 0; bloom < 8; bloom++) {
      const angle = bloom * 2.39996 + crate;
      const offset = Math.sqrt(bloom / 7) * size * 0.31;
      const stemX = x + Math.cos(angle) * offset;
      const stemZ = z + Math.sin(angle) * offset * 0.85;
      const height = floor + 0.19 + (bloom % 4) * 0.036;
      const tip: PropPoint = [
        stemX + Math.cos(angle) * 0.029,
        height,
        stemZ + Math.sin(angle) * 0.029,
      ];
      line(builder, [stemX, floor + 0.108, stemZ], tip, 0.0065, '#5e7550');
      builder.add(
        new THREE.SphereGeometry(0.029, 6, 4).scale(1.49, 0.64, 0.58),
        [stemX, height - 0.042, stemZ],
        bloom % 2 ? '#77885b' : '#9da56e',
        [0.3, angle, 0.37],
      );
      const tint = flowerColors[(bloom + crate) % flowerColors.length]!;
      for (let petal = 0; petal < 5; petal++) {
        const bearing = petal * 1.25664 + angle;
        builder.add(
          new THREE.SphereGeometry(0.022, 6, 4).scale(1.18, 0.45, 0.86),
          [tip[0] + Math.cos(bearing) * 0.026, tip[1], tip[2] + Math.sin(bearing) * 0.026],
          tint,
          [0.14, -bearing, 0.17],
        );
      }
      builder.add(
        new THREE.SphereGeometry(0.015, 6, 4),
        [tip[0], tip[1] + 0.009, tip[2]],
        '#e4bb72',
      );
    }
  });
  for (const z of [boat.z - 0.27, boat.z + 0.27]) {
    line(
      builder,
      [boat.x - 1.15, boat.rim + 0.075, z],
      [boat.x - 0.32, boat.rim + 0.046, z],
      0.018,
      '#a68760',
    );
    builder.add(
      new THREE.SphereGeometry(0.043, 9, 5).scale(2.7, 0.4, 1),
      [boat.x - 1.15, boat.rim + 0.071, z],
      '#bc9b6a',
    );
  }
}

export function HarborBoats() {
  const surface = useMemo(() => {
    const builder = createIslandPropBuilder();
    addHull(builder, sailboat, '#50757a', '#d7c5a0');
    addHull(builder, flowerSkiff, '#5b8171', '#c5a774');
    addSails(builder, sailboat);
    addFlowerCargo(builder, flowerSkiff);
    addMooring(builder, sailboat);
    addMooring(builder, flowerSkiff);
    return builder.finish();
  }, []);
  return (
    <mesh name="harbor-boats" castShadow receiveShadow>
      <IslandPropGeometry surface={surface} />
      <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.81} />
    </mesh>
  );
}
