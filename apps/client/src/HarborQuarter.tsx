import { useMemo } from 'react';
import * as THREE from 'three';
import type { ProjectSnapshot } from '@astrisle/contracts';
import { createIslandPropBuilder, IslandPropGeometry } from './IslandPropGeometry';
import { HarborBoats } from './HarborBoats';
import { HarborHouses } from './HarborHouses';
import { harborBridge, harborOrigin, harborYaw } from './harbor-layout';
import type { Panel } from './Scene';
import { ToolStation } from './ToolStation';

type Builder = ReturnType<typeof createIslandPropBuilder>;
type Outline = ReadonlyArray<readonly [number, number]>;

function shelf(builder: Builder, outline: Outline, floor: number, ceiling: number, tint: string) {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: ceiling - floor,
    bevelEnabled: false,
  }).rotateX(-Math.PI / 2);
  builder.add(geo, [0, floor, 0], tint);
}

function basinAndStreet(b: Builder) {
  const rim: Outline = [
    [-8.45, -2.8],
    [-6.8, -4.05],
    [-3.15, -4.5],
    [0.8, -4.78],
    [5.4, -4.21],
    [7.48, -3.42],
    [8.4, -1.68],
    [8.6, 1.6],
    [7.94, 4.55],
    [6.45, 5.75],
    [3.15, 6.04],
    [0.2, 5.88],
    [-3.76, 6.18],
    [-6.95, 5.65],
    [-8.23, 4.78],
    [-8.62, 2.78],
  ];
  shelf(
    b,
    rim.map(([x, z]) => [x * 0.74, z * 0.72]),
    -2.25,
    -1.47,
    '#59616b',
  );
  shelf(
    b,
    rim.map(([x, z]) => [x * 0.94, z * 0.91]),
    -1.62,
    -1.03,
    '#798080',
  );
  shelf(b, rim, -1.08, -0.55, '#9b9b8a');
  // Uncut bedrock shows below the dressed quay walls, especially from the rear orbit.
  for (let i = 0; i < rim.length; i++) {
    const [x, z] = rim[i]!;
    const size = 1.15 + 0.32 * Math.cos(i * 2.17);
    const yaw = Math.atan2(x, z);
    const rock = new THREE.DodecahedronGeometry(1)
      .scale(1.5 * size, 0.89 * size, 0.78 * size)
      .rotateZ(0.16 * Math.cos(i))
      .rotateY(yaw)
      .rotateX(0.12 * Math.sin(i));
    rock.computeBoundingBox();
    // Keep even the tallest tilted face beneath the bottom of the navigable basin.
    const y = -0.63 - rock.boundingBox!.max.y - 0.12 * (1 + Math.sin(i * 1.38));
    b.add(rock, [x * 0.87, y, z * 0.86], i % 3 === 0 ? '#8d928b' : '#777f80');
  }
  const land = new THREE.Shape();
  land.moveTo(-8.05, -2.93);
  land.lineTo(8.08, -2.93);
  land.lineTo(8.28, -1.5);
  land.lineTo(8.08, 1.4);
  land.lineTo(7.16, 3.02);
  land.lineTo(3.1, 3.88);
  land.lineTo(-0.4, 4.25);
  land.lineTo(-4.5, 4.0);
  land.lineTo(-6.8, 3.72);
  land.lineTo(-8.03, 2.76);
  land.closePath();
  b.add(
    new THREE.ExtrudeGeometry(land, { depth: 0.54, bevelEnabled: false }).rotateX(-Math.PI / 2),
    [0, -0.54, 0],
    '#aaa38f',
  );
  // Slight variations in value and staggered joints read as paving down the length of the quay.
  const pavers = ['#bab09d', '#c3b8a4', '#b8ad9b', '#c6baa4', '#c1af9a'];
  for (let row = 0; row < 7; row++) {
    const offset = (row % 2) * 0.29;
    for (let i = 0; i < 26; i++) {
      const x = -7.68 + i * 0.59 + offset;
      b.box(
        [x, 0.014, 0.23 + row * 0.36],
        [0.573, 0.024, 0.346],
        pavers[(i * 7 + row * 3 + Math.floor(i / 4)) % pavers.length]!,
      );
    }
  }
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 23; i++) {
      const x = -7.78 + i * 0.69 + (row % 2) * 0.28;
      b.box([x, -0.35 + row * 0.22, 2.85], [0.665, 0.2, 0.21], row ? '#aaa491' : '#8e9285');
    }
  }
  for (let i = 0; i < 28; i++) {
    b.box([-7.79 + i * 0.577, 0.025, 2.86], [0.56, 0.11, 0.32], i % 4 ? '#ccbea7' : '#bdad94');
  }
  // The cross-channel bridge lies between both moorings.
  const { x: bridgeX, width, quayEnd, gardenEnd, deckHeight } = harborBridge;
  const bridgeLength = gardenEnd - quayEnd;
  const plankThickness = 0.075;
  const plankCount = Math.ceil(bridgeLength / 0.163);
  const plankPitch = bridgeLength / plankCount;
  for (const side of [-1, 1]) {
    const x = bridgeX + side * (width / 2 - 0.065);
    b.beam([x, deckHeight - 0.114, quayEnd], [x, deckHeight - 0.114, gardenEnd], 0.13, '#826f59');
    const first = quayEnd + 0.05;
    const last = gardenEnd - 0.05;
    for (let post = 0; post < 4; post++)
      b.box(
        [x, deckHeight + 0.256, first + ((last - first) * post) / 3],
        [0.105, 0.72, 0.105],
        '#806f59',
      );
    b.beam([x, deckHeight + 0.566, first], [x, deckHeight + 0.566, last], 0.068, '#b69b71');
  }
  for (let i = 0; i < plankCount; i++)
    b.box(
      [bridgeX, deckHeight - plankThickness / 2, quayEnd + (i + 0.5) * plankPitch],
      [width, plankThickness, plankPitch - 0.01],
      i % 3 ? '#b59672' : '#a98a67',
    );

  // Dressed stones catch the water around the outside of the harbor basin.
  const seaWall = rim.slice(8, 15);
  for (let i = 1; i < seaWall.length; i++) {
    const [ax, az] = seaWall[i - 1]!,
      [bx, bz] = seaWall[i]!;
    const length = Math.hypot(bx - ax, bz - az),
      count = Math.ceil(length / 0.65);
    for (let j = 0; j < count; j++) {
      const t = (j + 0.5) / count;
      b.box(
        [ax + (bx - ax) * t, -0.4, az + (bz - az) * t],
        [length / count - 0.025, 0.33, 0.22],
        j % 3 ? '#a3a797' : '#8c9a91',
        [0, -Math.atan2(bz - az, bx - ax), 0],
      );
    }
  }
}

function flowerMarket(b: Builder) {
  for (const x of [-6.4, -4.9, 4.95]) {
    const z = x > 0 ? 1.1 : 0.9;
    b.box([x, 0.29, z], [1.06, 0.54, 0.51], '#90755d');
    for (const y of [0.12, 0.34, 0.54]) {
      b.box([x, y, z + 0.265], [1.09, 0.084, 0.038], '#b49a75');
    }
    for (let bucket = 0; bucket < 3; bucket++) {
      const bx = x + (bucket - 1) * 0.31;
      b.add(new THREE.CylinderGeometry(0.138, 0.1, 0.23, 10), [bx, 0.675, z], '#718982');
      for (let stem = 0; stem < 6; stem++) {
        const a = stem * 2.4;
        const px = bx + Math.sin(a) * 0.13,
          pz = z + Math.cos(a) * 0.11,
          py = 0.9 + (stem % 3) * 0.075;
        b.beam([bx, 0.74, z], [px, py, pz], 0.018, '#698162');
        b.add(
          new THREE.IcosahedronGeometry(0.077, 0).scale(1, 0.79, 1),
          [px, py, pz],
          ['#d09b9c', '#deb987', '#b2a3bd'][(bucket + (x > 0 ? 1 : 0)) % 3]!,
        );
      }
    }
  }
  // Catenary lanterns lead the eye along the waterfront at street height.
  const posts = [-7.3, -3.05, 2.55, 7.4];
  for (const x of posts) {
    b.add(new THREE.CylinderGeometry(0.06, 0.093, 2.5, 10), [x, 1.24, 2.48], '#536b69');
    b.add(new THREE.SphereGeometry(0.096, 10, 7), [x, 2.54, 2.48], '#b69b72');
  }
  for (let i = 1; i < posts.length; i++) {
    const left = posts[i - 1]!,
      right = posts[i]!;
    const line = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(left, 2.46, 2.48),
      new THREE.Vector3((left + right) / 2, 1.85, 2.48),
      new THREE.Vector3(right, 2.46, 2.48),
    );
    b.add(new THREE.TubeGeometry(line, 14, 0.019, 5, false), [0, 0, 0], '#6c7067');
    for (const t of [0.25, 0.5, 0.75]) {
      const p = line.getPoint(t);
      b.add(new THREE.CylinderGeometry(0.093, 0.077, 0.18, 8), [p.x, p.y - 0.13, p.z], '#eccb91');
      b.add(new THREE.ConeGeometry(0.113, 0.07, 8), [p.x, p.y - 0.024, p.z], '#81745f');
    }
  }
}

function portSurface() {
  const b = createIslandPropBuilder();
  basinAndStreet(b);
  flowerMarket(b);
  return b.finish();
}

function canalSurface() {
  const shape = new THREE.Shape();
  shape.moveTo(-7.96, -2.78);
  shape.lineTo(8.12, -2.78);
  shape.lineTo(7.82, -4.45);
  shape.quadraticCurveTo(6.74, -5.94, 3.2, -5.95);
  shape.quadraticCurveTo(1.7, -5.96, 0.2, -5.79);
  shape.lineTo(-3.76, -6.05);
  shape.lineTo(-6.87, -5.55);
  shape.lineTo(-8.13, -4.7);
  shape.closePath();
  const water = new THREE.ShapeGeometry(shape, 20).rotateX(-Math.PI / 2);
  const pos = water.attributes.position;
  const near = new THREE.Color('#83b6b0'),
    deep = new THREE.Color('#417b85'),
    tint = new THREE.Color();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++)
    tint
      .copy(deep)
      .lerp(near, THREE.MathUtils.clamp((pos.getZ(i) - 2.8) / 3.1, 0, 1))
      .toArray(colors, i * 3);
  water.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const surface = {
    position: pos.array as Float32Array,
    color: colors,
    normal: water.attributes.normal.array as Float32Array,
    index: water.index!.array as Uint16Array,
  };
  water.dispose();
  return surface;
}

function buildDispatch() {
  const b = createIslandPropBuilder();
  for (const x of [-0.46, 0.46])
    for (const z of [-0.22, 0.22]) b.box([x, 0.35, z], [0.085, 0.7, 0.085], '#6e7d71');
  b.box([0, 0.24, 0], [0.99, 0.055, 0.48], '#aa9272');
  b.box([0, 0.59, 0], [0.97, 0.16, 0.44], '#68847c');
  b.box([0, 0.72, 0], [1.13, 0.1, 0.56], '#bda680');
  b.box([0, 0.585, 0.227], [0.31, 0.081, 0.03], '#d5bd8d');
  b.add(new THREE.SphereGeometry(0.101, 10, 6).scale(1, 0.49, 1), [-0.32, 0.786, 0.07], '#bb9b5f');
  b.box([0.43, 1.07, -0.19], [0.032, 0.62, 0.032], '#797667');
  b.add(new THREE.SphereGeometry(0.04, 8, 5), [0.43, 1.4, -0.19], '#bb9b5f');
  return b.finish();
}

function HarborDispatch({
  snapshot,
  onActivate,
}: {
  snapshot?: ProjectSnapshot;
  onActivate: () => void;
}) {
  const surface = useMemo(buildDispatch, []);
  const artifacts =
    snapshot?.artifacts.filter((artifact) => artifact.validity === 'current').length ?? 0;
  const pending = snapshot?.commission.status === 'awaiting_acceptance';
  const status = artifacts ? `${artifacts} 项成果${pending ? '，待验收' : ''}` : '等待成果';
  return (
    <ToolStation
      position={[6.83, 0, 0.93]}
      labelPosition={[0, 1.54, 0.25]}
      label={`码头柜台 · ${status}`}
      onActivate={onActivate}
    >
      <mesh name="harbor-dispatch-counter">
        <IslandPropGeometry surface={surface} />
        <meshStandardMaterial vertexColors roughness={0.84} />
      </mesh>
      {artifacts > 0 && (
        <mesh name="harbor-dispatch-signal" position={[0.267, 1.277, -0.19]}>
          <boxGeometry args={[0.33, 0.19, 0.022]} />
          <meshStandardMaterial color={pending ? '#cb9870' : '#7da79a'} roughness={0.88} />
        </mesh>
      )}
    </ToolStation>
  );
}

export function HarborQuarter({
  snapshot,
  onPanel,
}: {
  snapshot?: ProjectSnapshot;
  onPanel: (panel: Panel) => void;
}) {
  const street = useMemo(portSurface, []);
  const water = useMemo(canalSurface, []);
  return (
    <group name="flower-harbor" position={harborOrigin} rotation={[0, harborYaw, 0]}>
      <mesh name="harbor-quay">
        <IslandPropGeometry surface={street} />
        <meshStandardMaterial roughness={0.85} vertexColors />
      </mesh>
      <mesh name="harbor-canal" position={[0, -0.48, 0]}>
        <IslandPropGeometry surface={water} />
        <meshStandardMaterial vertexColors roughness={0.27} metalness={0.12} />
      </mesh>
      <HarborHouses onOffice={() => onPanel('goal')} />
      <HarborDispatch snapshot={snapshot} onActivate={() => onPanel('artifacts')} />
      <HarborBoats />
    </group>
  );
}
