import { useMemo } from 'react';
import * as THREE from 'three';
import { createIslandPropBuilder, IslandPropGeometry } from './IslandPropGeometry';
import { ToolStation } from './ToolStation';

const houses = [
  {
    x: -5.8,
    width: 2.89,
    depth: 2.83,
    wall: 2.73,
    peak: 0.98,
    plaster: '#d6ad88',
    roof: ['#9b6353', '#aa7463', '#b57d6b'],
    door: '#7b5c4e',
    trim: '#e2cbb0',
  },
  {
    x: -2.2,
    width: 3.04,
    depth: 3.12,
    wall: 3.79,
    peak: 1.33,
    plaster: '#ddd0a8',
    roof: ['#837264', '#9a796b', '#936957'],
    door: '#6d6250',
    trim: '#f0dbc0',
  },
  {
    x: 1.4,
    width: 2.89,
    depth: 2.94,
    wall: 3.19,
    peak: 1.13,
    plaster: '#a4b2a0',
    roof: ['#617c7d', '#6b8e89', '#789591'],
    door: '#54776e',
    trim: '#d9dbb9',
  },
  {
    x: 5.4,
    width: 3.12,
    depth: 3.02,
    wall: 3.95,
    peak: 1.29,
    plaster: '#bec0bd',
    roof: ['#676d7c', '#79828f', '#808b96'],
    door: '#596f79',
    trim: '#ddd8c6',
  },
];

function buildHarborHouses() {
  const street = createIslandPropBuilder();
  const office = createIslandPropBuilder();
  const glass = '#e8b96e';
  const dark = '#55534a';

  for (const [houseIndex, house] of houses.entries()) {
    const isOffice = houseIndex === houses.length - 1;
    const { add, box, beam } = isOffice ? office : street;
    const { x, width, depth, wall, peak, plaster, roof, door, trim } = house;
    const z = -1.55;
    const front = z + depth / 2;
    const stone = '#959487';
    box([x, wall / 2, z], [width, wall, depth], plaster);
    box([x, 0.146, z], [width + 0.11, 0.292, depth + 0.1], stone);
    box([x, 0.303, z], [width + 0.14, 0.046, depth + 0.108], trim);
    box([x, wall - 0.105, z], [width + 0.18, 0.107, depth + 0.15], door);
    box([x, wall - 0.045, z], [width + 0.21, 0.036, depth + 0.172], trim);
    for (const side of [-1, 1]) {
      for (let tier = 0; tier < 6; tier++) {
        const y = 0.44 + tier * 0.23;
        box(
          [x + side * (width / 2 - 0.085), y, front + 0.019],
          [tier % 2 ? 0.162 : 0.225, 0.14, 0.044],
          trim,
        );
      }
      for (let row = 0; row < 8; row++) {
        const dx = ((row - 3.5) * (width - 0.14)) / 8;
        box(
          [x + dx, 0.146, z + side * (depth / 2 + 0.052)],
          [0.296, 0.161, 0.022],
          row % 2 ? stone : '#a7a596',
        );
      }
    }

    const horizontalRidge = houseIndex === 2;
    const roofSpan = horizontalRidge ? depth : width;
    const roofLength = horizontalRidge ? width : depth;
    const bearing = horizontalRidge ? Math.PI / 2 : 0;
    const roofPoint = (across: number, y: number, along: number): [number, number, number] => [
      x + across * Math.cos(bearing) + along * Math.sin(bearing),
      y,
      z - across * Math.sin(bearing) + along * Math.cos(bearing),
    ];
    const roofHalf = roofSpan / 2 + 0.12;
    const angle = Math.atan2(peak, roofHalf);
    const slopeLength = Math.hypot(peak, roofHalf);
    const edgeRise = peak * (1 - roofSpan / (2 * roofHalf));
    const gable = new THREE.Shape();
    gable.moveTo(-roofSpan / 2, -0.07);
    gable.lineTo(roofSpan / 2, -0.07);
    gable.lineTo(roofSpan / 2, edgeRise);
    gable.lineTo(0, peak);
    gable.lineTo(-roofSpan / 2, edgeRise);
    gable.closePath();
    for (const side of [-1, 1]) {
      add(
        new THREE.ShapeGeometry(gable),
        roofPoint(0, wall - 0.011, side * (roofLength / 2 + 0.002)),
        plaster,
        [0, bearing + (side > 0 ? 0 : Math.PI), 0],
      );
      const roofRotation: [number, number, number] = [0, bearing, -side * angle];
      box(
        roofPoint((side * roofHalf) / 2, wall + peak / 2, 0),
        [slopeLength, 0.097, roofLength + 0.22],
        roof[0]!,
        roofRotation,
      );
      for (let row = 0; row < 6; row++) {
        const fraction = (row + 0.5) / 6;
        const across = side * fraction * roofHalf;
        const y = wall + (1 - fraction) * peak + 0.059;
        for (let col = 0; col < 9; col++) {
          const length = (roofLength + 0.18) / 9;
          const along = (col - 4 + (row % 2 ? 0.11 : -0.11)) * length;
          const tint = roof[(col * 11 + row * 7 + (side > 0 ? 3 : 0)) % roof.length]!;
          box(
            roofPoint(across, y, along),
            [slopeLength / 6 - 0.009, 0.035, length - 0.009],
            tint,
            roofRotation,
          );
        }
      }
      box(roofPoint(side * roofHalf, wall, 0), [0.102, 0.106, roofLength + 0.26], trim, [
        0,
        bearing,
        0,
      ]);
      for (const end of [-1, 1])
        beam(
          roofPoint(0, wall + peak + 0.028, end * (roofLength / 2 + 0.112)),
          roofPoint(side * roofHalf, wall + 0.022, end * (roofLength / 2 + 0.112)),
          0.094,
          roof[0]!,
        );
    }
    add(
      new THREE.CylinderGeometry(0.065, 0.078, roofLength + 0.25, 8),
      roofPoint(0, wall + peak + 0.075, 0),
      roof[2]!,
      [Math.PI / 2, 0, bearing],
    );

    const chimneyX = x + (houseIndex % 2 ? 0.92 : -0.84);
    const chimneyZ = z - 0.67;
    const chimneyTop = wall + peak + (houseIndex % 2 ? 0.26 : 0.46);
    box([chimneyX, chimneyTop - 0.57, chimneyZ], [0.35, 1.14, 0.38], '#a88570');
    for (const y of [chimneyTop - 0.32, chimneyTop - 0.22, chimneyTop - 0.12])
      box([chimneyX, y, chimneyZ + 0.191], [0.342, 0.013, 0.009], '#beaa93');
    box([chimneyX, chimneyTop, chimneyZ], [0.429, 0.082, 0.456], stone);
    add(
      new THREE.CylinderGeometry(0.095, 0.09, 0.153, 8),
      [chimneyX, chimneyTop + 0.102, chimneyZ],
      '#90675a',
    );
    add(
      new THREE.CylinderGeometry(0.063, 0.063, 0.012, 8),
      [chimneyX, chimneyTop + 0.177, chimneyZ],
      dark,
    );

    const window = (dx: number, y: number, w: number, h: number, shutters: boolean) => {
      const windowX = x + dx;
      box([windowX, y, front + 0.015], [w + 0.115, h + 0.115, 0.071], trim);
      box([windowX, y, front + 0.055], [w, h, 0.035], dark);
      for (const col of [-1, 1]) {
        for (const row of [-1, 1])
          box(
            [windowX + (col * w) / 4, y + (row * h) / 4, front + 0.076],
            [w / 2 - 0.035, h / 2 - 0.036, 0.016],
            row === 1 ? '#f0c788' : glass,
          );
      }
      box([windowX, y - h / 2 - 0.042, front + 0.085], [w + 0.2, 0.082, 0.22], trim);
      if (shutters) {
        for (const side of [-1, 1]) {
          const shutter = windowX + side * (w / 2 + 0.137);
          box([shutter, y, front + 0.066], [0.216, h - 0.045, 0.039], door);
          for (let slat = 0; slat < 4; slat++)
            box(
              [shutter, y + ((slat - 1.5) * h) / 6, front + 0.09],
              [0.171, 0.018, 0.014],
              roof[2]!,
            );
        }
      }
    };

    const storefrontX = houseIndex === 0 ? -0.51 : 0.63;
    const entryX = houseIndex === 0 ? 0.92 : houseIndex === 2 ? -0.75 : -0.56;
    const entry = x + entryX;
    box([entry, 0.097, front + 0.115], [0.94, 0.19, 0.31], trim);
    box([entry, 0.912, front + 0.024], [0.89, 1.74, 0.086], trim);
    box([entry, 0.91, front + 0.066], [0.737, 1.593, 0.075], door);
    for (const offset of [-0.175, 0.175]) {
      box([entry + offset, 1.312, front + 0.115], [0.263, 0.45, 0.02], glass);
      box([entry + offset, 0.539, front + 0.109], [0.243, 0.486, 0.019], roof[1]!);
    }
    add(new THREE.SphereGeometry(0.033, 7, 5), [entry + 0.256, 0.898, front + 0.128], '#bca06b');
    window(storefrontX, 1.02, houseIndex === 0 ? 1.23 : 0.86, 1.035, false);

    if (houseIndex === 0 || houseIndex === 2) {
      const awning = x + storefrontX;
      for (let strip = 0; strip < 9; strip++) {
        const offset = (strip - 4) * 0.163;
        const stripe = strip % 2 ? trim : houseIndex === 0 ? '#a66e59' : '#789d88';
        box([awning + offset, 1.968, front + 0.25], [0.164, 0.032, 0.522], stripe, [0.39, 0, 0]);
        box([awning + offset, 1.819, front + 0.494], [0.165, 0.092, 0.033], stripe);
      }
      beam([awning - 0.68, 1.94, front], [awning - 0.68, 1.864, front + 0.48], 0.033, door);
      beam([awning + 0.68, 1.94, front], [awning + 0.68, 1.864, front + 0.48], 0.033, door);
    }

    const upperY = houseIndex === 0 ? 2.31 : 2.67;
    window(-0.71, upperY, 0.5, 0.66, true);
    window(0.71, upperY, 0.5, 0.66, true);

    // The side and rear elevations stay legible when orbiting above the canal.
    for (const bearing of [-Math.PI / 2, Math.PI / 2, Math.PI]) {
      const normalX = Math.sin(bearing);
      const normalZ = Math.cos(bearing);
      const halfSpan = bearing === Math.PI ? depth / 2 : width / 2;
      const sideTrim = (
        offset: number,
        y: number,
        projection: number,
        w: number,
        h: number,
        d: number,
        tint: string,
      ) =>
        box(
          [
            x + offset * normalZ + (halfSpan + projection) * normalX,
            y,
            z - offset * normalX + (halfSpan + projection) * normalZ,
          ],
          [w, h, d],
          tint,
          [0, bearing, 0],
        );
      const sideWindow = (offset: number, y: number, w: number, h: number) => {
        sideTrim(offset, y, 0.02, w + 0.11, h + 0.13, 0.061, trim);
        sideTrim(offset, y, 0.053, w, h, 0.024, dark);
        for (const mullion of [-1, 1])
          sideTrim(offset + (mullion * w) / 4, y, 0.07, w / 2 - 0.031, h - 0.028, 0.018, glass);
        sideTrim(offset, y - h / 2 - 0.056, 0.047, w + 0.14, 0.054, 0.121, trim);
      };
      for (const offset of [-0.68, 0.68]) sideWindow(offset, upperY, 0.39, 0.613);
      sideWindow(0.39, 1.153, 0.43, 0.57);
      if (houseIndex === 1 || houseIndex === 3) sideWindow(-0.49, wall - 0.411, 0.34, 0.31);
    }
    if (!horizontalRidge) {
      const attic = wall + peak * 0.42;
      add(new THREE.CylinderGeometry(0.237, 0.237, 0.056, 14), [x, attic, front + 0.025], trim, [
        Math.PI / 2,
        0,
        0,
      ]);
      add(new THREE.CylinderGeometry(0.173, 0.173, 0.021, 14), [x, attic, front + 0.064], glass, [
        Math.PI / 2,
        0,
        0,
      ]);
      box([x, attic, front + 0.082], [0.028, 0.34, 0.012], door);
      box([x, attic, front + 0.082], [0.34, 0.027, 0.012], door);
    } else {
      // The botanist's street-facing dormer punctuates its transverse roof.
      const dormerY = wall + 0.42;
      box([x, dormerY, front - 0.29], [0.86, 0.79, 0.63], plaster);
      box([x, dormerY + 0.402, front - 0.26], [0.96, 0.096, 0.73], roof[1]!, [0.19, 0, 0]);
      window(0, dormerY, 0.46, 0.49, false);
    }

    for (const dx of [-0.71, 0.71]) {
      if (houseIndex === 1) continue;
      const flowerY = upperY - 0.4;
      box([x + dx, flowerY, front + 0.167], [0.68, 0.142, 0.214], '#a17a60');
      box([x + dx, flowerY + 0.075, front + 0.167], [0.667, 0.025, 0.196], '#74674c');
      for (let i = 0; i < 5; i++) {
        const stemX = x + dx + (i - 2) * 0.12;
        const stemY = flowerY + 0.146 + (i % 3) * 0.037;
        add(
          new THREE.SphereGeometry(1, 6, 4).scale(0.073, 0.073, 0.074),
          [stemX, stemY - 0.037, front + 0.171],
          i % 2 ? '#809364' : '#6d865f',
        );
        add(
          new THREE.SphereGeometry(0.042, 6, 4),
          [stemX, stemY + 0.035, front + 0.17],
          i % 2 ? '#e0bd82' : '#d7a398',
        );
      }
    }
    if (houseIndex === 1 || houseIndex === 3) {
      // Tall inn and harbor office receive an upper balcony or clerestory.
      const balconyZ = front + 0.2;
      const balconyY = upperY - 0.365;
      box([x, balconyY - 0.036, balconyZ], [2.27, 0.093, 0.33], trim);
      box([x, balconyY + 0.352, balconyZ + 0.144], [2.28, 0.057, 0.064], door);
      for (let rail = 0; rail < 12; rail++)
        box(
          [x + (rail - 5.5) * 0.193, balconyY + 0.175, balconyZ + 0.143],
          [0.028, 0.35, 0.036],
          door,
        );
      for (const side of [-1, 1]) {
        box([x + side * 1.09, balconyY + 0.352, front + 0.169], [0.057, 0.057, 0.36], door);
        beam(
          [x + side * 0.81, balconyY - 0.31, front + 0.029],
          [x + side * 0.81, balconyY - 0.056, balconyZ + 0.076],
          0.073,
          stone,
        );
      }
      window(0, wall - 0.41, 0.66, 0.39, false);
    }
    if (isOffice) {
      box([x + 0.82, 1.89, front + 0.042], [0.52, 0.24, 0.064], door);
      add(
        new THREE.CylinderGeometry(0.087, 0.087, 0.027, 10),
        [x + 0.82, 1.89, front + 0.083],
        '#bca275',
        [Math.PI / 2, 0, 0],
      );
    }
  }
  return { street: street.finish(), office: office.finish() };
}

export function HarborHouses({ onOffice }: { onOffice: () => void }) {
  const { street, office } = useMemo(buildHarborHouses, []);
  return (
    <>
      <mesh name="harbor-houses">
        <IslandPropGeometry surface={street} />
        <meshStandardMaterial vertexColors roughness={0.82} />
      </mesh>
      <ToolStation
        label="港务处 · 目标与计划"
        labelPosition={[5.4, 4.35, 0.11]}
        onActivate={onOffice}
      >
        <mesh name="harbor-office">
          <IslandPropGeometry surface={office} />
          <meshStandardMaterial vertexColors roughness={0.82} />
        </mesh>
      </ToolStation>
    </>
  );
}
