import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { createIslandPropBuilder, IslandPropGeometry } from './IslandPropGeometry';

type Builder = ReturnType<typeof createIslandPropBuilder>;

function skerry(builder: Builder, radius: number) {
  // Lathed shelves share an irregular outline from the turf down to the bedrock.
  const profile: [number, number][] = [
    [0, -radius * 0.89],
    [0.33, -radius * 0.71],
    [0.6, -radius * 0.43],
    [0.91, -radius * 0.27],
    [1, -0.52],
    [0.97, -0.18],
    [0.93, 0],
    [0, 0],
  ];
  const tints = ['#465260', '#555c69', '#696d78', '#797b83', '#92918a', '#82927f', '#8d9d85'];
  const segments = 13;
  function point(step: number, ring: number) {
    const angle = ((step % segments) * Math.PI * 2) / segments;
    const [width, y] = profile[ring]!;
    const r = radius * width * (1 + 0.07 * Math.sin(3 * angle) + 0.09 * Math.cos(5 * angle));
    return [Math.sin(angle) * r + 0.23 * y, y, Math.cos(angle) * r * 0.74];
  }
  for (let ring = 0; ring < profile.length - 1; ring++) {
    const positions: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = point(i, ring),
        b = point(i + 1, ring);
      const c = point(i, ring + 1),
        d = point(i + 1, ring + 1);
      if (ring > 0) positions.push(...a, ...b, ...c);
      if (ring < profile.length - 2) positions.push(...b, ...d, ...c);
    }
    const band = new THREE.BufferGeometry();
    band.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    band.computeVertexNormals();
    builder.add(band, [0, 0, 0], tints[ring]!);
  }
}

function observatory() {
  const b = createIslandPropBuilder();
  skerry(b, 4.3);
  b.add(new THREE.CylinderGeometry(1.98, 2.15, 0.24, 24), [0, 0.12, 0], '#aca696');
  b.add(new THREE.CylinderGeometry(1.48, 1.54, 1.56, 24), [0, 0.99, 0], '#b7afa2');
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    b.box([Math.sin(angle) * 1.5, 1.03, Math.cos(angle) * 1.5], [0.47, 0.75, 0.07], '#4a646c', [
      0,
      angle,
      0,
    ]);
  }
  b.add(new THREE.CylinderGeometry(1.62, 1.6, 0.17, 32), [0, 1.78, 0], '#8d795a');
  // Two patinated sliding shutters leave a narrow slot for the telescope.
  for (const start of [0.13, Math.PI + 0.13]) {
    b.add(
      new THREE.SphereGeometry(1.52, 18, 10, start, Math.PI - 0.26, 0, Math.PI / 2),
      [0, 1.86, 0],
      '#668a8e',
    );
  }
  b.add(
    new THREE.SphereGeometry(1.43, 22, 10, 0, 2 * Math.PI, 0, Math.PI / 2),
    [0, 1.86, 0],
    '#394752',
  );
  b.beam([-0.2, 2.45, 0], [-1.98, 3.24, 0], 0.26, '#8e7c61');
  b.box([2.15, 0.62, -0.21], [1.55, 1.24, 1.35], '#acaa9f');
  for (const side of [-1, 1]) {
    b.box([2.15, 1.45, -0.21 + side * 0.4], [1.83, 0.12, 0.99], '#617077', [side * 0.47, 0, 0]);
  }
  return b.finish();
}

function skyHarbor() {
  const b = createIslandPropBuilder();
  skerry(b, 3.65);
  b.box([0.35, 0.18, 0.2], [5.7, 0.36, 1.14], '#927f6d');
  for (const x of [-2.14, -0.3, 1.54, 2.97]) {
    for (const z of [-0.29, 0.69]) {
      b.box([x, 0.39, z], [0.14, 0.92, 0.14], '#6b6863');
      b.box([x, 0.86, z], [0.17, 0.06, 0.17], '#b8a17c');
    }
  }
  for (const x of [-0.86, 0.86]) {
    for (const z of [-0.38, 0.38]) {
      b.beam([x, 2.25, z], [x * 1.9, 3.72, z * 2.05], 0.046, '#8b8174');
    }
  }
  b.beam([-0.91, 1.7, 0.32], [-2.14, 0.77, 0.69], 0.042, '#a1967c');
  b.beam([0.91, 1.7, 0.32], [1.54, 0.77, 0.69], 0.042, '#a1967c');
  b.add(new THREE.SphereGeometry(1, 16, 8).scale(1.27, 0.43, 0.52), [0, 1.93, 0], '#7e6656');
  b.box([0, 2.22, 0], [2.05, 0.1, 0.84], '#b39a78');
  const panelCount = 12;
  for (let i = 0; i < panelCount; i++) {
    const skin = new THREE.SphereGeometry(
      1,
      3,
      14,
      (i * 2 * Math.PI) / panelCount,
      (2 * Math.PI) / panelCount,
    )
      .rotateZ(Math.PI / 2)
      .scale(3.18, 1.09, 1.09);
    b.add(skin, [0, 4.16, 0], ['#d0b495', '#bd9c79', '#709294'][i % 3]!);
  }
  // Fabric tailplanes meet at the stern and project past the envelope.
  for (const angle of [0, Math.PI * 0.65, -Math.PI * 0.65]) {
    const fin = new THREE.Shape();
    fin.moveTo(1.86, 0.32);
    fin.lineTo(3.58, 1.27);
    fin.lineTo(3.38, 0.18);
    fin.lineTo(2.5, 0.08);
    fin.closePath();
    const foil = new THREE.ExtrudeGeometry(fin, { depth: 0.065, bevelEnabled: false }).rotateX(
      angle,
    );
    b.add(foil, [0, 4.16, 0], '#69878a');
  }
  return b.finish();
}

function aqueduct() {
  const b = createIslandPropBuilder();
  skerry(b, 3.35);
  // Cut the two open arches into the stone face; their reveals are visible from either bank.
  const wall = new THREE.Shape();
  wall.moveTo(-3.1, -0.08);
  for (const center of [-1.46, 1.46]) {
    wall.lineTo(center - 1.05, -0.08);
    wall.lineTo(center - 1.05, 0.81);
    wall.absarc(center, 0.81, 1.05, Math.PI, 0, true);
    wall.lineTo(center + 1.05, -0.08);
  }
  wall.lineTo(3.1, -0.08);
  wall.lineTo(3.1, 2.25);
  wall.lineTo(-3.1, 2.25);
  wall.closePath();
  b.add(
    new THREE.ExtrudeGeometry(wall, { depth: 0.8, bevelEnabled: false }),
    [0, 0, -0.4],
    '#9e9687',
  );
  for (const z of [-0.42, 0.42]) {
    b.box([0.59, 2.32, z], [7.38, 0.23, 0.16], '#b4aa96');
    for (const center of [-1.46, 1.46]) {
      for (let i = 0; i < 9; i++) {
        const a = ((i + 0.5) * Math.PI) / 9;
        b.box(
          [center + Math.cos(a) * 1.13, 0.81 + Math.sin(a) * 1.13, z],
          [0.18, 0.37, 0.09],
          i % 2 ? '#c1b9a6' : '#b0a895',
          [0, 0, a],
        );
      }
    }
  }
  b.box([0.59, 2.19, 0], [7.38, 0.15, 0.8], '#817e77');
  b.box([0.62, 2.29, 0], [7.33, 0.035, 0.67], '#6ea6ad');
  for (let i = 0; i < 5; i++) {
    const z = (i - 2) * 0.126;
    const h = 4.6 + Math.cos(i * 1.7) * 0.48;
    const stream = new THREE.CatmullRomCurve3([
      new THREE.Vector3(4.22, 2.29, z),
      new THREE.Vector3(4.53, 2.12, z),
      new THREE.Vector3(4.76, 1.32, z),
      new THREE.Vector3(4.92, -h, z * 1.2),
    ]);
    b.add(
      new THREE.TubeGeometry(stream, 12, 0.072, 5, false),
      [0, 0, 0],
      i % 2 ? '#87bdc0' : '#70a7ae',
    );
  }
  return b.finish();
}

function FallingSpray() {
  const spray = useRef<THREE.InstancedMesh>(null);
  const transform = useMemo(() => new THREE.Object3D(), []);
  const bounds = useMemo(() => new THREE.Sphere(new THREE.Vector3(4.95, -5.6, 0), 1.65), []);
  useFrame(({ clock }) => {
    if (!spray.current) return;
    for (let i = 0; i < 9; i++) {
      const phase = (clock.elapsedTime * 0.62 + i * 0.393) % 1;
      const size = 0.055 * Math.sin(phase * Math.PI);
      transform.position.set(4.92 + phase * 0.06, -4.2 - phase * phase * 2.8, ((i % 5) - 2) * 0.14);
      transform.scale.set(size, size * 2.35, size);
      transform.updateMatrix();
      spray.current.setMatrixAt(i, transform.matrix);
    }
    spray.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={spray} args={[undefined, undefined, 9]} boundingSphere={bounds}>
      <octahedronGeometry args={[1, 0]} />
      <meshStandardMaterial color="#abd2cf" />
    </instancedMesh>
  );
}

export function OuterIslets({ reduced }: { reduced: boolean }) {
  const dome = useMemo(observatory, []);
  const harbor = useMemo(skyHarbor, []);
  const canal = useMemo(aqueduct, []);
  return (
    <group name="outer-islets">
      <mesh name="outer-observatory" position={[-27, -7, -10]} rotation={[0, -0.32, 0]}>
        <IslandPropGeometry surface={dome} />
        <meshStandardMaterial vertexColors roughness={0.9} />
      </mesh>
      <mesh name="airship-mooring" position={[6, -10, -29]} rotation={[0, -0.42, 0]}>
        <IslandPropGeometry surface={harbor} />
        <meshStandardMaterial vertexColors roughness={0.88} />
      </mesh>
      <group name="hanging-aqueduct" position={[19, -9, 24]} rotation={[0, 0.72, 0]}>
        <mesh>
          <IslandPropGeometry surface={canal} />
          <meshStandardMaterial vertexColors roughness={0.83} />
        </mesh>
        {!reduced && <FallingSpray />}
      </group>
    </group>
  );
}
