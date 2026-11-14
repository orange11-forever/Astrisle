import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FACILITIES, SWING_PIVOT_HEIGHT, SWING_ROPE_LENGTH, TEA_TABLE } from './island-facilities';
import { swingAngle, type LeisureWorld } from './island-activities';

type V3 = [number, number, number];
type Surface = { position: Float32Array; normal: Float32Array; color: Float32Array };
const wood = '#bda17c',
  darkWood = '#82735d',
  brass = '#bda16a',
  teal = '#76958d';

function geometryBuilder() {
  const parts: THREE.BufferGeometry[] = [];
  const add = (
    source: THREE.BufferGeometry,
    color: string,
    p: V3 = [0, 0, 0],
    rotation: V3 = [0, 0, 0],
  ) => {
    const g = source.index ? source.toNonIndexed() : source;
    if (g !== source) source.dispose();
    g.deleteAttribute('uv');
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...p),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
        new THREE.Vector3(1, 1, 1),
      ),
    );
    const tint = new THREE.Color(color),
      colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) tint.toArray(colors, i);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  };
  return {
    add,
    box: (p: V3, size: V3, color = wood, rotation: V3 = [0, 0, 0]) =>
      add(new THREE.BoxGeometry(...size), color, p, rotation),
    cylinder: (p: V3, radius: number, height: number, color = darkWood, rotation: V3 = [0, 0, 0]) =>
      add(new THREE.CylinderGeometry(radius, radius, height, 12), color, p, rotation),
    finish: (): Surface => {
      const g = mergeGeometries(parts)!;
      const result = {
        position: g.attributes.position.array as Float32Array,
        normal: g.attributes.normal.array as Float32Array,
        color: g.attributes.color.array as Float32Array,
      };
      parts.forEach((p) => p.dispose());
      g.dispose();
      return result;
    },
  };
}
function SurfaceMesh({ surface, name }: { surface: Surface; name?: string }) {
  return (
    <mesh name={name}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[surface.position, 3]} />
        <bufferAttribute attach="attributes-normal" args={[surface.normal, 3]} />
        <bufferAttribute attach="attributes-color" args={[surface.color, 3]} />
      </bufferGeometry>
      <meshStandardMaterial vertexColors roughness={0.65} />
    </mesh>
  );
}
function seatSurface(width: number, cushion: string) {
  const b = geometryBuilder();
  for (const x of [-width * 0.37, width * 0.37]) {
    for (const z of [-0.22, 0.22]) b.box([x, 0.24, z], [0.07, 0.48, 0.07], darkWood);
    b.box([x, 0.74, -0.26], [0.07, 0.65, 0.07], darkWood);
    b.box([x, 0.71, 0.02], [0.08, 0.07, 0.62], wood);
    b.cylinder([x, 0.59, 0.25], 0.026, 0.24, brass);
  }
  for (let i = 0; i < 4; i++)
    b.box([0, 0.48, (i - 1.5) * 0.145], [width, 0.07, 0.13], i % 2 ? wood : '#cbb394');
  for (let i = 0; i < 3; i++) b.box([0, 0.69 + i * 0.14, -0.3], [width, 0.11, 0.065], wood);
  b.box([0, 0.535, 0.02], [width * 0.9, 0.06, 0.51], cushion);
  // Narrow piping reads as sewn upholstery even in a close orbit.
  for (const z of [-0.23, 0.27])
    b.cylinder([0, 0.55, z], 0.009, width * 0.88, '#e4ddc3', [0, 0, Math.PI / 2]);
  if (width > 1.2) {
    b.box([-0.6, 0.75, -0.16], [0.31, 0.36, 0.12], '#c6a078', [-0.15, 0, 0.13]);
    b.box([0.64, 0.67, 0.04], [0.28, 0.035, 0.33], '#e4dbc2', [0, -0.2, 0]);
    b.box([0.64, 0.69, 0.04], [0.27, 0.014, 0.33], '#537e79', [0, -0.2, 0]);
  }
  return b.finish();
}
function teaSurface() {
  const b = geometryBuilder();
  b.cylinder([0, 0.77, 0], 0.6, 0.09, wood);
  b.cylinder([0, 0.33, 0], 0.075, 0.72, darkWood);
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    b.box([Math.sin(a) * 0.22, 0.08, Math.cos(a) * 0.22], [0.08, 0.09, 0.6], darkWood, [0, a, 0]);
  }
  b.box([0, 0.823, 0], [0.56, 0.012, 0.84], '#d5d5b8');
  for (let i = 0; i < 7; i++) b.box([0, 0.831, (i - 3) * 0.09], [0.55, 0.004, 0.015], '#aab99f');
  b.cylinder([0.02, 0.85, 0], 0.3, 0.025, darkWood);
  b.add(new THREE.SphereGeometry(0.12, 16, 10).scale(1, 0.85, 1), '#e1e8d6', [0.05, 0.98, 0.03]);
  b.cylinder([0.05, 1.075, 0.03], 0.075, 0.018, '#ceddc9');
  b.add(new THREE.SphereGeometry(0.022, 8, 6), brass, [0.05, 1.1, 0.03]);
  b.add(new THREE.TorusGeometry(0.087, 0.016, 6, 16), '#ceddc9', [-0.08, 0.99, 0.03]);
  b.add(new THREE.ConeGeometry(0.038, 0.16, 12), '#e1e8d6', [0.2, 1.0, 0.03], [0, 0, -0.95]);
  for (const [x, z] of [
    [-0.22, -0.2],
    [0.22, -0.22],
  ]) {
    b.cylinder([x, 0.845, z], 0.095, 0.015, '#dce3ce');
    b.cylinder([x, 0.89, z], 0.05, 0.075, '#e9ede1');
    b.cylinder([x, 0.929, z], 0.041, 0.003, '#86643b');
  }
  b.cylinder([-0.3, 0.84, 0.19], 0.11, 0.012, '#e4dbc1');
  for (let i = 0; i < 3; i++)
    b.add(new THREE.SphereGeometry(0.04, 8, 5).scale(1, 0.3, 1), '#cba977', [
      -0.32 + i * 0.025,
      0.865 + i * 0.012,
      0.2,
    ]);
  return b.finish();
}
function swingFrameSurface() {
  const b = geometryBuilder();
  for (const x of [-0.94, 0.94]) {
    for (const side of [-1, 1]) {
      b.cylinder([x, 1.38, side * 0.34], 0.065, 2.87, wood, [side * -0.24, 0, 0]);
      b.cylinder([x, 0.06, side * 0.68], 0.12, 0.08, '#90968a');
    }
    b.box([x, 1.03, 0], [0.07, 0.07, 0.85], darkWood);
    b.add(new THREE.SphereGeometry(0.09, 10, 6), brass, [x, 2.84, 0]);
  }
  b.cylinder([0, SWING_PIVOT_HEIGHT, 0], 0.09, 2.24, darkWood, [0, 0, Math.PI / 2]);
  for (const x of [-0.56, 0.56])
    b.add(new THREE.TorusGeometry(0.07, 0.012, 5, 12), brass, [x, 2.79, 0], [0, Math.PI / 2, 0]);
  return b.finish();
}
function swingSeatSurface() {
  const b = geometryBuilder(),
    length = SWING_ROPE_LENGTH;
  for (const x of [-0.56, 0.56]) {
    b.cylinder([x, -length / 2, 0], 0.018, length, '#c5b993');
    for (const y of [-0.15, -length + 0.12])
      b.add(new THREE.TorusGeometry(0.025, 0.008, 4, 8), '#a89774', [x, y, 0], [Math.PI / 2, 0, 0]);
  }
  for (let i = 0; i < 4; i++)
    b.box([0, -length - 0.035, (i - 1.5) * 0.16], [1.32, 0.07, 0.145], wood);
  b.box([0, -length + 0.005, 0], [1.18, 0.03, 0.53], teal);
  for (const x of [-0.6, 0.6]) b.box([x, -length + 0.18, -0.27], [0.05, 0.4, 0.05], darkWood);
  for (let i = 0; i < 2; i++) b.box([0, -length + 0.18 + i * 0.14, -0.29], [1.28, 0.1, 0.05], wood);
  return b.finish();
}

export function IslandLeisure({ life }: { life: LeisureWorld }) {
  const bench = useMemo(() => seatSurface(1.8, '#849b8f'), []);
  const chair = useMemo(() => seatSurface(0.86, '#aab6a0'), []);
  const tea = useMemo(teaSurface, []);
  const frame = useMemo(swingFrameSurface, []);
  const seat = useMemo(swingSeatSurface, []);
  const pendulum = useRef<THREE.Group>(null);
  useFrame(() => {
    const id = life.reservations.get('garden-swing');
    if (pendulum.current)
      pendulum.current.rotation.x = swingAngle(id ? life.states.get(id) : undefined);
  });
  const b = FACILITIES['garden-bench'],
    t = FACILITIES['tea-chair'],
    s = FACILITIES['garden-swing'];
  return (
    <group name="island-leisure">
      <group
        name="facility-garden-bench"
        position={[b.position[0], 0, b.position[1]]}
        rotation={[0, b.yaw, 0]}
      >
        <SurfaceMesh surface={bench} />
      </group>
      <group
        name="facility-tea-chair"
        position={[t.position[0], 0, t.position[1]]}
        rotation={[0, t.yaw, 0]}
      >
        <SurfaceMesh surface={chair} />
      </group>
      <group position={[TEA_TABLE[0], 0, TEA_TABLE[1]]}>
        <SurfaceMesh surface={tea} name="garden-tea-table" />
      </group>
      <group
        name="facility-garden-swing"
        position={[s.position[0], 0, s.position[1]]}
        rotation={[0, s.yaw, 0]}
      >
        <SurfaceMesh surface={frame} />
        <group ref={pendulum} name="swing-pendulum" position={[0, SWING_PIVOT_HEIGHT, 0]}>
          <SurfaceMesh surface={seat} />
        </group>
      </group>
    </group>
  );
}
