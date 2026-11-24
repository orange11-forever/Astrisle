import { useMemo } from 'react';
import * as THREE from 'three';
import { createIslandPropBuilder, IslandPropGeometry, type PropPoint } from './IslandPropGeometry';

import {
  glasshousePosition as position,
  glasshouseYaw as yaw,
  glasshouseVerticalScale,
} from './garden-access';
import { buildNurseryTerrace } from './NurseryTerrace';
const fieldstone = '#8e9588';
const limestone = '#aba99b';
const floorWood = '#bc9f7c';
const darkWood = '#86765f';
const green = '#426c63';
const trim = '#81a59a';
const patina = '#5e8d80';
const brass = '#be9b61';
const darkBrass = '#856e50';
const wallX = 1.49;
const wallZ = 0.89;
const sill = 0.37;
const transom = 1.45;
const eave = 1.91;
const ridge = 2.62;

function curvedTrim(
  builder: ReturnType<typeof createIslandPropBuilder>,
  points: PropPoint[],
  radius: number,
  tint: string,
) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
  builder.add(new THREE.TubeGeometry(curve, 10, radius, 5, false), [0, 0, 0], tint);
}

function buildGlasshouse() {
  const structure = createIslandPropBuilder();
  const { add, box, beam, finish } = structure;
  const glass = createIslandPropBuilder();
  const stone = new THREE.CylinderGeometry(1, 0.84, 0.7, 14);
  add(stone.scale(2.22, 1, 1.53), [0, -0.39, 0], fieldstone, [0, 0.115, 0]);
  add(
    new THREE.CylinderGeometry(1, 0.94, 0.14, 14).scale(2.25, 1, 1.55),
    [0, -0.075, 0],
    '#9eaa8f',
    [0, 0.115, 0],
  );
  for (const [x, y, z, size] of [
    [-1.35, -0.73, -0.44, 0.76],
    [-0.58, -1.05, -0.52, 0.91],
    [0.52, -1.0, -0.62, 1.1],
    [1.43, -0.62, -0.3, 0.62],
    [0.28, -0.87, 0.61, 0.73],
  ] as const) {
    add(new THREE.DodecahedronGeometry(size).scale(1.0, 0.86, 0.87), [x, y, z], fieldstone, [
      0.2,
      0.35 * x,
      0.25 * z,
    ]);
  }
  for (const [x, z, size] of [
    [-1.61, 0.38, 0.18],
    [-1.79, 0.54, 0.12],
    [1.73, 0.51, 0.19],
    [1.63, -0.37, 0.16],
    [-1.49, -0.72, 0.19],
  ] as const) {
    add(new THREE.DodecahedronGeometry(size).scale(1, 0.55, 0.9), [x, 0.005, z], limestone);
  }
  // A low stone bridge reaches the main island before its slope begins.
  box([0, -0.09, 1.76], [1.11, 0.17, 1.52], fieldstone);
  for (let step = 0; step < 7; step++) {
    const z = 1.14 + step * 0.2;
    box([0, 0.012 + (6 - step) * 0.003, z], [1.18, 0.088, 0.195], step % 2 ? limestone : '#b6b29e');
  }
  for (const x of [-0.54, 0.54]) {
    if (x < 0) box([x, 0.091, 1.77], [0.105, 0.09, 1.42], fieldstone);
    else for (const z of [1.24, 2.33]) box([x, 0.091, z], [0.105, 0.09, 0.32], fieldstone);
    for (const z of [1.14, 2.42]) {
      box([x, 0.165, z], [0.15, 0.23, 0.15], limestone);
      box([x, 0.285, z], [0.185, 0.05, 0.185], '#c1bdab');
    }
  }

  box([0, 0.055, 0], [3.28, 0.17, 1.99], fieldstone);
  box([0, 0.008, 0], [3.31, 0.067, 2.015], '#7c8376');
  box([0, 0.121, 0], [3.31, 0.037, 2.013], '#b6b4a4');
  for (const z of [-1.002, 1.002]) {
    for (let stone = 0; stone < 9; stone++) {
      const x = (stone - 4) * 0.354;
      box([x, 0.062, z], [0.343, 0.083, 0.027], stone % 3 ? '#a19e8f' : limestone);
    }
  }
  for (let row = 0; row < 9; row++) {
    const z = (row - 4) * 0.211;
    box([0, 0.143, z], [3.025, 0.035, 0.206], row % 2 ? floorWood : '#c6ad8b');
  }
  box([0, 0.1, 0.97], [0.85, 0.105, 0.25], limestone);

  const panel = (width: number, height: number, position: PropPoint, tint: string, angle = 0) =>
    glass.add(new THREE.PlaneGeometry(width, height), position, tint, [0, angle, 0]);
  const windowCenter = (sill + transom) / 2;
  const glassHeight = transom - sill - 0.022;
  for (const z of [-wallZ, wallZ]) {
    box([0, eave, z], [3.1, 0.074, 0.087], green);
    box([0, eave + 0.024, z * 1.052], [3.13, 0.022, 0.023], trim);
    const bays =
      z > 0 ? [-wallX, -1.04, -0.61, 0.61, 1.04, wallX] : [-wallX, -0.75, 0, 0.75, wallX];
    for (const x of bays) {
      box([x, 0.53 * eave, z], [0.057, eave - 0.12, 0.073], green);
      box([x, 1.1, z * 1.033], [0.021, 1.36, 0.016], patina);
      box([x, 0.185, z], [0.088, 0.085, 0.105], darkBrass);
    }
    for (let i = 1; i < bays.length; i++) {
      const width = bays[i]! - bays[i - 1]!;
      const x = (bays[i]! + bays[i - 1]!) / 2;
      if (z > 0 && i === 3) {
        curvedTrim(
          structure,
          [
            [-0.61, 1.66, z],
            [-0.43, 1.784, z],
            [0, 1.855, z],
            [0.43, 1.784, z],
            [0.61, 1.66, z],
          ],
          0.032,
          green,
        );
        curvedTrim(
          structure,
          [
            [-0.616, 1.68, z + 0.024],
            [-0.43, 1.807, z + 0.024],
            [0, 1.88, z + 0.024],
            [0.43, 1.807, z + 0.024],
            [0.616, 1.68, z + 0.024],
          ],
          0.009,
          brass,
        );
        beam([0, 1.858, z], [0, eave, z], 0.023, trim);
        for (const side of [-1, 1]) {
          box([side * 0.602, 1.03, z + 0.046], [0.04, 0.16, 0.017], darkBrass);
          box([side * 0.603, 1.05, z + 0.06], [0.034, 0.074, 0.025], brass);
        }
        continue;
      }
      box([x, 0.258, z], [width, 0.196, 0.069], green);
      box([x, 0.259, z * 1.041], [width - 0.103, 0.102, 0.012], patina);
      box([x, 0.353, z], [width, 0.033, 0.09], trim);
      box([x, transom, z], [width, 0.03, 0.053], green);
      panel(width - 0.047, glassHeight, [x, windowCenter, z], i % 2 ? '#a9c8c4' : '#94b9c1');
      panel(width - 0.047, 0.423, [x, 1.677, z], i % 2 ? '#bad8c5' : '#b0cbd1');
    }
  }
  for (const x of [-wallX, wallX]) {
    box([x, 0.263, 0], [0.07, 0.202, 2 * wallZ], green);
    for (const y of [0.357, transom, eave])
      box([x, y, 0], [0.07, 0.044, 2 * wallZ], y === 0.357 ? trim : green);
    box([x, 0.53 * eave, 0], [0.057, eave - 0.12, 0.06], green);
    for (const z of [-wallZ / 2, wallZ / 2]) {
      box([x * 1.023, 0.264, z], [0.017, 0.102, 0.727], patina);
      panel(wallZ - 0.047, glassHeight, [x, windowCenter, z], '#a4c4c5', Math.PI / 2);
      panel(wallZ - 0.047, 0.423, [x, 1.677, z], '#bcd5cc', Math.PI / 2);
      const side = Math.sign(z);
      curvedTrim(
        structure,
        [
          [x, eave + 0.026, side * 0.69],
          [x, eave + 0.096, side * 0.47],
          [x, eave + 0.214, side * 0.31],
          [x, eave + 0.408, 0],
        ],
        0.013,
        patina,
      );
    }
    beam([x, eave, 0], [x, ridge, 0], 0.037, green);
    add(new THREE.TorusGeometry(0.105, 0.012, 5, 16), [x, eave + 0.167, 0], brass, [
      0,
      Math.PI / 2,
      0,
    ]);
    add(new THREE.SphereGeometry(0.028, 8, 5), [x, eave + 0.167, 0], patina);
    const gable = new THREE.Shape();
    gable.moveTo(-wallZ, eave);
    gable.lineTo(wallZ, eave);
    gable.lineTo(0, ridge);
    gable.closePath();
    glass.add(new THREE.ShapeGeometry(gable), [x, 0, 0], '#a5c5bd', [0, Math.PI / 2, 0]);
  }
  const roofDepth = 1.015;
  const roofEdge = eave - 0.055;
  const roofRise = ridge - roofEdge;
  const roofPitch = Math.atan2(roofRise, roofDepth);
  const roofLength = Math.hypot(roofRise, roofDepth);
  box([0, ridge, 0], [3.28, 0.065, 0.078], green);
  box([0, ridge + 0.036, 0], [3.33, 0.021, 0.037], patina);
  for (const side of [-1, 1]) {
    box([0, roofEdge, side * roofDepth], [3.28, 0.057, 0.063], green);
    box([0, roofEdge + 0.027, side * roofDepth], [3.29, 0.016, 0.049], brass);
    for (const x of [-1.6, -0.8, 0, 0.8, 1.6]) {
      beam([x, ridge, 0], [x, roofEdge, side * roofDepth], 0.047, green);
      beam([x, ridge + 0.025, 0], [x, roofEdge + 0.023, side * roofDepth], 0.017, trim);
    }
    for (const [index, x] of [-1.2, -0.4, 0.4, 1.2].entries()) {
      glass.add(
        new THREE.PlaneGeometry(0.785, roofLength),
        [x, (ridge + roofEdge) / 2, (side * roofDepth) / 2],
        index % 2 ? '#a8cdcc' : '#c2d7c8',
        [Math.PI / 2 + side * roofPitch, 0, 0],
      );
    }
  }

  // A low, glazed ridge ventilator sits along the long roof axis.
  box([0, ridge + 0.035, 0], [1.06, 0.07, 0.394], green);
  for (const z of [-0.16, 0.16]) {
    for (const x of [-0.49, -0.16, 0.16, 0.49])
      box([x, ridge + 0.125, z], [0.034, 0.17, 0.034], green);
    for (const x of [-0.327, 0, 0.327]) panel(0.285, 0.116, [x, ridge + 0.125, z], '#c4dccd');
    box([0, ridge + 0.194, z], [1.1, 0.043, 0.071], green);
    box([0, ridge + 0.221, z], [1.12, 0.016, 0.061], brass);
    const slope = Math.atan2(0.115, 0.205);
    box([0, ridge + 0.269, Math.sign(z) * 0.103], [1.16, 0.035, 0.237], patina, [
      Math.sign(z) * slope,
      0,
      0,
    ]);
  }
  box([0, ridge + 0.328, 0], [1.2, 0.037, 0.049], green);
  for (const x of [-1.48, 1.48]) {
    add(new THREE.CylinderGeometry(0.016, 0.037, 0.15, 7), [x, ridge + 0.086, 0], darkBrass);
    add(new THREE.SphereGeometry(0.032, 8, 6), [x, ridge + 0.182, 0], brass);
    add(new THREE.ConeGeometry(0.021, 0.081, 7), [x, ridge + 0.235, 0], brass);
  }

  // Two growing benches flank the central aisle.
  for (const x of [-0.99, 0.99]) {
    glass.add(new THREE.CircleGeometry(1, 24).scale(0.322, 0.77, 1), [x, 0.161, 0], '#514934', [
      -Math.PI / 2,
      0,
      0,
    ]);
    for (const corner of [-0.24, 0.24]) {
      for (const z of [-0.55, 0.55]) box([x + corner, 0.38, z], [0.057, 0.44, 0.059], darkWood);
      box([x + corner, 0.65, 0], [0.05, 0.2, 1.48], floorWood);
    }
    for (const z of [-0.719, 0.719]) box([x, 0.65, z], [0.47, 0.2, 0.041], darkWood);
    box([x, 0.676, 0], [0.442, 0.09, 1.39], '#706b53');
    box([x, 0.427, 0], [0.47, 0.045, 1.3], floorWood);
  }

  const flower = (x: number, y: number, z: number, size: number, tint: string) => {
    for (let petal = 0; petal < 5; petal++) {
      const angle = (petal * Math.PI * 2) / 5;
      add(
        new THREE.SphereGeometry(1, 6, 3).scale(size * 0.59, size * 0.35, size * 0.8),
        [x + Math.sin(angle) * size * 0.68, y + size * 0.17, z + Math.cos(angle) * size * 0.68],
        tint,
        [0.2, angle, 0.12],
      );
    }
    add(new THREE.SphereGeometry(size * 0.36, 6, 4), [x, y + size * 0.29, z], '#dcc280');
  };
  const plant = (x: number, y: number, z: number, height: number, lean: number, leaves: string) => {
    beam([x, y, z], [x + lean, y + height, z + lean * 0.68], 0.012, '#637b54');
    for (const [index, angle] of [0.2, 2.32, 4.41].entries()) {
      const fraction = 0.28 + index * 0.19;
      add(
        new THREE.SphereGeometry(1, 6, 4).scale(
          0.021 + height * 0.027,
          0.047 + height * 0.19,
          0.014,
        ),
        [
          x + lean * fraction + Math.sin(angle) * 0.053,
          y + height * fraction,
          z + lean * 0.57 + Math.cos(angle) * 0.053,
        ],
        index === 1 ? '#9eac72' : leaves,
        [Math.cos(angle) * 0.86, 0.18, -Math.sin(angle) * 0.86],
      );
    }
  };
  for (const side of [-1, 1]) {
    for (let seedling = 0; seedling < 8; seedling++) {
      const x = 0.99 * side + (seedling % 2 ? 0.089 : -0.089);
      const z = (Math.floor(seedling / 2) - 1.5) * 0.31;
      const height = [0.19, 0.36, 0.25, 0.46][seedling % 4]!;
      const lean = Math.sin(seedling * 2.17) * 0.078;
      plant(x, 0.719, z, height, lean, side > 0 ? '#72965f' : '#66815f');
      if (side > 0 && seedling % 2)
        flower(
          x + lean,
          0.718 + height,
          z + lean * 0.68,
          0.048,
          seedling > 3 ? '#e1b0a4' : '#e0c69c',
        );
      if (side < 0 && seedling % 2) {
        for (let bud = 0; bud < 3; bud++)
          add(
            new THREE.SphereGeometry(1, 6, 4).scale(0.021, 0.027, 0.021),
            [x + lean + (bud - 1) * 0.014, 0.736 + height + bud * 0.03, z + lean * 0.68],
            bud % 2 ? '#b293bf' : '#9779ad',
          );
      }
    }
    const x = side * 1.22;
    const z = 1.15;
    add(new THREE.CylinderGeometry(0.201, 0.138, 0.218, 12), [x, 0.111, z], '#b27e64');
    add(new THREE.CylinderGeometry(0.155, 0.174, 0.032, 12), [x, 0.007, z], '#88665a');
    add(new THREE.CylinderGeometry(0.187, 0.187, 0.009, 12), [x, 0.221, z], '#625944');
    add(new THREE.TorusGeometry(0.195, 0.021, 6, 16), [x, 0.228, z], '#cb9b7f', [
      Math.PI / 2,
      0,
      0,
    ]);
    for (const [index, offset] of [-0.059, 0.01, 0.065].entries()) {
      const height = [0.33, 0.49, 0.384][index]!;
      const lean = offset * 1.61;
      plant(x + offset, 0.225, z - offset, height, lean, '#6f8a62');
      flower(
        x + offset + lean,
        0.225 + height,
        z - offset + lean * 0.68,
        0.045,
        index === 1 ? '#e4c696' : '#dca292',
      );
    }
  }

  buildNurseryTerrace(structure);
  return { structure: finish(), panes: glass.finish() };
}

export function IslandGlasshouse() {
  const { structure, panes } = useMemo(buildGlasshouse, []);
  return (
    <group
      name="island-glasshouse"
      position={position}
      rotation={[0, yaw, 0]}
      scale={[1, glasshouseVerticalScale, 1]}
    >
      <mesh name="glasshouse-structure">
        <IslandPropGeometry surface={structure} />
        <meshStandardMaterial vertexColors roughness={0.78} />
      </mesh>
      <mesh name="glasshouse-panes">
        <IslandPropGeometry surface={panes} />
        <meshStandardMaterial
          vertexColors
          side={THREE.DoubleSide}
          transparent
          opacity={0.21}
          depthWrite={false}
          forceSinglePass
          roughness={0.28}
        />
      </mesh>
    </group>
  );
}
