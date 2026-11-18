import { useMemo } from 'react';
import * as THREE from 'three';
import { FACILITIES } from './island-facilities';
import { createIslandPropBuilder, IslandPropGeometry, type PropPoint } from './IslandPropGeometry';

const timber = '#b08a62';
const darkWood = '#765b45';
const brass = '#b89861';
const ivory = '#e6ddc3';
const sage = '#8ea39b';

function sideboardSurface() {
  const { add, box, finish } = createIslandPropBuilder();
  const pottery = (position: PropPoint, profile: [number, number][], tint: string) =>
    add(
      new THREE.LatheGeometry(
        profile.map(([radius, height]) => new THREE.Vector2(radius, height)),
        12,
      ),
      position,
      tint,
    );

  for (const x of [-0.55, 0.55]) {
    for (const z of [-0.17, 0.17]) {
      pottery(
        [x, 0.015, z],
        [
          [0.027, 0],
          [0.033, 0.044],
          [0.027, 0.088],
          [0.024, 0.34],
          [0.034, 0.424],
          [0.034, 0.455],
          [0.024, 0.482],
          [0.031, 0.517],
          [0.034, 0.525],
          [0.034, 0.622],
        ],
        darkWood,
      );
      add(new THREE.CylinderGeometry(0.031, 0.029, 0.022, 9), [x, 0.008, z], brass);
    }
  }
  for (const z of [-0.17, 0.17]) {
    box([0, 0.56, z], [1.12, 0.083, 0.041], timber);
    box([0, 0.18, z], [1.12, 0.047, 0.034], darkWood);
  }
  for (let plank = 0; plank < 4; plank++) {
    const z = (plank - 1.5) * 0.111;
    box([0, 0.647, z], [1.24, 0.055, 0.107], plank % 2 ? '#c5a783' : '#bd9a73');
    box([0, 0.202, z * 0.82], [1.08, 0.034, 0.087], timber);
  }
  box([0, 0.627, 0.213], [1.24, 0.03, 0.012], '#9e7857');
  box([0, 0.755, -0.194], [1.22, 0.18, 0.039], timber);
  box([0, 0.747, -0.17], [1.04, 0.089, 0.011], '#bb9871');
  box([0, 0.843, -0.194], [1.255, 0.032, 0.055], '#c5a783');
  box([0, 0.831, -0.167], [1.208, 0.012, 0.009], '#927050');
  for (const x of [-0.5, 0.5]) {
    add(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 6), [x, 0.576, 0.193], brass, [
      Math.PI / 2,
      0,
      0,
    ]);
  }

  // Flush apron drawer with a brass pull and inset panel.
  box([0, 0.558, 0.193], [0.64, 0.071, 0.032], '#8f6c4c');
  box([0, 0.559, 0.21], [0.581, 0.049, 0.012], '#be9e77');
  for (const x of [-0.053, 0.053])
    add(new THREE.SphereGeometry(0.011, 7, 4), [x, 0.565, 0.224], brass);
  box([0, 0.552, 0.231], [0.109, 0.013, 0.013], brass);

  // Slatted bin with its contents visible through the gaps and from above.
  box([-0.315, 0.24, 0], [0.405, 0.055, 0.285], '#70604d');
  for (const x of [-0.51, -0.12]) {
    for (const z of [-0.13, 0.13]) box([x, 0.3, z], [0.028, 0.15, 0.028], timber);
  }
  for (const y of [0.277, 0.318, 0.359]) {
    for (const z of [-0.133, 0.133]) box([-0.315, y, z], [0.41, 0.032, 0.026], '#ae916d');
    for (const x of [-0.512, -0.118]) box([x, y, 0], [0.026, 0.032, 0.253], '#9f805e');
  }
  box([-0.32, 0.337, -0.012], [0.28, 0.16, 0.18], '#c9b797', [0.09, 0.08, -0.07]);

  // Spare cups have actual rims and interior surfaces.
  const cup: [number, number][] = [
    [0, 0],
    [0.032, 0],
    [0.044, 0.013],
    [0.054, 0.072],
    [0.051, 0.078],
    [0.046, 0.073],
    [0.035, 0.016],
    [0, 0.016],
  ];
  for (const [x, z, glaze, rim] of [
    [-0.114, 0.065, ivory, '#ac986e'],
    [0.061, 0.03, '#7f9c98', '#b8cec2'],
  ] as const) {
    add(new THREE.CylinderGeometry(0.07, 0.062, 0.012, 12), [x, 0.679, z], glaze);
    pottery([x, 0.684, z], cup, glaze);
    add(new THREE.TorusGeometry(0.0495, 0.003, 4, 16), [x, 0.761, z], rim, [Math.PI / 2, 0, 0]);
    add(new THREE.TorusGeometry(0.021, 0.005, 5, 12), [x + 0.056, 0.725, z], glaze);
  }
  box([-0.345, 0.69, 0.027], [0.29, 0.028, 0.185], '#c3c2a0', [0, 0.14, 0]);
  box([-0.348, 0.716, 0.018], [0.255, 0.024, 0.157], ivory, [0, 0.14, 0]);
  box([-0.35, 0.729, 0.064], [0.24, 0.003, 0.012], '#93a299', [0, 0.14, 0]);
  box([-0.349, 0.729, 0.052], [0.24, 0.003, 0.004], '#b5a785', [0, 0.14, 0]);

  pottery(
    [0.282, 0.22, 0.04],
    [
      [0, 0],
      [0.075, 0],
      [0.106, 0.06],
      [0.097, 0.12],
      [0.083, 0.147],
      [0.083, 0.164],
      [0.074, 0.164],
      [0.072, 0.149],
      [0.088, 0.12],
      [0.095, 0.061],
      [0, 0.018],
    ],
    '#ba8b71',
  );
  pottery(
    [0.33, 0.675, 0.041],
    [
      [0, 0],
      [0.069, 0],
      [0.092, 0.038],
      [0.087, 0.102],
      [0.058, 0.152],
      [0.048, 0.202],
      [0.055, 0.209],
      [0.046, 0.217],
      [0.038, 0.202],
      [0.04, 0.139],
      [0.062, 0.088],
      [0, 0.02],
    ],
    sage,
  );
  add(new THREE.TorusGeometry(0.08, 0.003, 5, 18), [0.33, 0.789, 0.041], '#abbbb0', [
    Math.PI / 2,
    0,
    0,
  ]);
  add(new THREE.TorusGeometry(0.085, 0.004, 5, 18), [0.33, 0.772, 0.041], '#718e84', [
    Math.PI / 2,
    0,
    0,
  ]);
  for (const [index, angle] of [-0.46, -0.12, 0.29, 0.48].entries()) {
    const base = new THREE.Vector3(0.33, 0.843, 0.041);
    const tip = new THREE.Vector3(
      0.33 + angle * 0.37,
      1.1 + (index % 2) * 0.08,
      0.01 + index * 0.025,
    );
    const stem = tip.clone().sub(base);
    const rotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        stem.clone().normalize(),
      ),
    );
    add(
      new THREE.CylinderGeometry(0.005, 0.007, stem.length(), 5),
      base.clone().lerp(tip, 0.5).toArray(),
      '#71856a',
      [rotation.x, rotation.y, rotation.z],
    );
    for (const [leaf, side] of [-1, 1, -1].entries()) {
      const position = base.clone().lerp(tip, 0.56 + leaf * 0.16);
      position.x += side * 0.027;
      add(
        new THREE.SphereGeometry(1, 7, 5).scale(0.024, 0.058, 0.012),
        position.toArray(),
        leaf === 1 ? '#9bab79' : '#778e6a',
        [0.2, 0, angle - side * 0.72],
      );
    }
    add(new THREE.SphereGeometry(0.024, 7, 5), tip.toArray(), index % 2 ? '#dfb790' : '#e1cf9f');
  }

  return finish();
}

export function TeaGardenDressing() {
  const { position: chair } = FACILITIES['tea-chair'];
  const surface = useMemo(sideboardSurface, []);
  return (
    // Behind the chair, within the overlap of its walking clearance and the island edge.
    <mesh name="garden-tea-sideboard" position={[chair[0], 0, chair[1] - 0.87]}>
      <IslandPropGeometry surface={surface} />
      <meshStandardMaterial vertexColors roughness={0.8} />
    </mesh>
  );
}
