import { useMemo } from 'react';
import * as THREE from 'three';
import { createIslandPropBuilder, IslandPropGeometry } from './IslandPropGeometry';

const deckRadius = 5.97;

function parquetCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  const unit = canvas.width / (2 * deckRadius);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(unit, unit);
  ctx.fillStyle = '#957958';
  ctx.fillRect(-6, -6, 12, 12);

  let seed = 0x41535452;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const veneers = ['#b38f6c', '#bb9874', '#ad8d6d', '#c3a480', '#b5997a', '#b89975'];
  const width = 1.04;
  const pitch = 0.29;
  for (let col = -6; col < 6; col++) {
    const fall = col % 2 === 0 ? 0.61 : -0.61;
    for (let row = -25; row <= 22; row++) {
      ctx.save();
      ctx.translate(col * width, row * pitch + (fall < 0 ? 0.61 : 0));
      ctx.transform(1, fall / width, 0, 1, 0, 0);
      ctx.fillStyle = veneers[Math.floor(random() * veneers.length)]!;
      ctx.fillRect(0, 0, width - 0.009, pitch - 0.008);
      for (let grain = 0; grain < 5; grain++) {
        const y = 0.022 + random() * (pitch - 0.046);
        const drift = random() * 0.05 - 0.025;
        ctx.beginPath();
        ctx.moveTo(0.02 + random() * 0.15, y);
        ctx.bezierCurveTo(0.34, y - drift, 0.67, y + drift, width - 0.02, y);
        ctx.strokeStyle = grain % 2 ? 'rgba(86,62,44,0.18)' : 'rgba(247,217,175,0.30)';
        ctx.lineWidth = 0.006;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function band(radius: number, thickness: number, color: string) {
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.stroke();
  }
  band(5.78, 0.34, '#816751');
  band(5.93, 0.016, '#dbc99b');
  band(5.62, 0.022, '#dac596');
  band(5.54, 0.025, '#836c53');
  for (let i = 0; i < 32; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 16);
    ctx.fillStyle = i % 4 === 0 ? '#e1c99a' : '#bd9e76';
    ctx.beginPath();
    ctx.moveTo(0, -5.88);
    ctx.lineTo(0.026, -5.77);
    ctx.lineTo(0, i % 4 === 0 ? -5.5 : -5.7);
    ctx.lineTo(-0.026, -5.77);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // Contact darkening stays under fixed furniture. Characters keep their own moving shadows.
  for (const [x, z, rx, rz] of [
    [-3.6, -1.1, 1.48, 1.18],
    [3.6, -1.1, 1.48, 1.18],
    [0, -0.65, 1.57, 1.52],
    [-3.3, -3.55, 1.4, 0.65],
    [0, -3.55, 1.35, 0.55],
    [2.75, -3.75, 1.37, 0.65],
    [-4.2, 2.7, 0.81, 0.72],
    [4.2, 2.7, 1.35, 0.99],
  ] as const) {
    ctx.save();
    ctx.translate(x + 0.08, z - 0.04);
    ctx.scale(rx, rz);
    const shadow = ctx.createRadialGradient(0, 0, 0.15, 0, 0, 1);
    shadow.addColorStop(0, 'rgba(48,40,45,0.46)');
    shadow.addColorStop(0.55, 'rgba(48,40,45,0.24)');
    shadow.addColorStop(1, 'rgba(48,40,45,0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  return canvas;
}

export function StudioDeck() {
  const canvas = useMemo(parquetCanvas, []);
  return (
    <group name="marquetry-deck">
      <mesh position={[0, -0.38, 0]}>
        <cylinderGeometry args={[6.1, 5.4, 0.55, 80]} />
        <meshStandardMaterial color="#93a1a0" />
      </mesh>
      <mesh position={[0, -0.08, 0]}>
        <cylinderGeometry args={[deckRadius, 5.92, 0.13, 96, 1, true]} />
        <meshStandardMaterial color="#967858" roughness={0.78} />
      </mesh>
      <mesh position={[0, -0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[deckRadius, 96]} />
        <meshStandardMaterial roughness={0.79}>
          <canvasTexture
            attach="map"
            args={[canvas]}
            colorSpace={THREE.SRGBColorSpace}
            anisotropy={4}
          />
        </meshStandardMaterial>
      </mesh>
    </group>
  );
}

function armillaryStand() {
  const b = createIslandPropBuilder();
  const brass = '#ad8b55';
  const enamel = '#426d70';
  const spindle = new THREE.LatheGeometry(
    [
      [0, 0],
      [0.77, 0],
      [0.8, 0.07],
      [0.76, 0.14],
      [0.48, 0.2],
      [0.35, 0.36],
      [0.3, 0.65],
      [0.4, 0.92],
      [0.56, 1.04],
      [0, 1.07],
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    36,
  );
  b.add(spindle, [0, 0, 0], enamel);
  for (const [y, radius] of [
    [0.14, 0.69],
    [0.31, 0.4],
    [0.9, 0.41],
  ] as const) {
    b.add(new THREE.TorusGeometry(radius, 0.028, 7, 48), [0, y, 0], brass, [Math.PI / 2, 0, 0]);
  }
  b.add(new THREE.CylinderGeometry(0.52, 0.58, 0.09, 48), [0, 1.29, 0], '#806849');
  b.add(new THREE.CylinderGeometry(0.45, 0.5, 0.08, 48), [0, 1.37, 0], enamel);
  b.add(new THREE.SphereGeometry(0.16, 20, 12), [0, 1.87, 0], '#719ea0');
  for (const [radius, tilt, bearing] of [
    [0.45, 0.34, 0.13],
    [0.52, 1.22, 0.19],
    [0.43, -0.53, 1.55],
  ] as const) {
    b.add(new THREE.TorusGeometry(radius, 0.027, 8, 60), [0, 1.87, 0], brass, [
      tilt,
      bearing,
      0.36,
    ]);
  }
  b.beam([-0.13, 1.39, -0.08], [0.13, 2.39, 0.08], 0.035, '#bd9f62');
  b.add(new THREE.SphereGeometry(0.047, 12, 8), [0.13, 2.39, 0.08], '#dfc696');
  const charts = [
    [
      [-0.33, 1.04],
      [-0.06, 1.26],
      [0.28, 1.18],
      [0.12, 1.65],
    ],
    [
      [-0.28, 1.43],
      [-0.08, 1.1],
      [0.21, 1.37],
      [0.08, 1.76],
    ],
    [
      [-0.21, 1.06],
      [-0.22, 1.49],
      [0.12, 1.63],
      [0.29, 1.33],
    ],
  ] as const;
  charts.forEach((chart, leaf) => {
    const a = (leaf * Math.PI * 2) / 3;
    let previous: [number, number, number] | undefined;
    for (const [x, depth] of chart) {
      const star: [number, number, number] = [
        x * Math.cos(a) - depth * Math.sin(a),
        1.262,
        -x * Math.sin(a) - depth * Math.cos(a),
      ];
      b.add(new THREE.CylinderGeometry(0.036, 0.036, 0.01, 12), star, '#e4d3a6');
      if (previous) b.beam(previous, star, 0.013, '#c2b394');
      previous = star;
    }
  });
  return b.finish();
}

export function ArmillaryStand() {
  const surface = useMemo(armillaryStand, []);
  return (
    <mesh name="armillary-sphere">
      <IslandPropGeometry surface={surface} />
      <meshStandardMaterial vertexColors metalness={0.32} roughness={0.41} />
    </mesh>
  );
}

function bindVolumes() {
  const b = createIslandPropBuilder();
  const spines = ['#416761', '#ab895e', '#696f8b', '#9a6156', '#c3ae8c'];
  spines.forEach((leather, i) => {
    const x = (i - 2) * 0.137;
    const height = [0.41, 0.53, 0.46, 0.38, 0.48][i]!;
    const z = 0.022 * Math.sin(i * 2);
    b.box([x, height / 2, z], [0.1, height - 0.025, 0.276], '#dccbb1');
    for (const edge of [-0.055, 0.055]) {
      b.box([x + edge, height / 2, z], [0.013, height, 0.295], leather);
    }
    b.box([x, height / 2, z + 0.145], [0.121, height, 0.026], leather);
    for (const y of [0.052, height - 0.063, height - 0.085]) {
      b.box([x, y, z + 0.16], [0.102, 0.008, 0.006], '#c9ae7c');
    }
    b.box([x, height * 0.59, z + 0.16], [0.069, 0.057, 0.006], i % 2 ? '#6c5547' : '#506766');
  });
  return b.finish();
}

export function BoundBooks({
  position,
  side = false,
}: {
  position: [number, number, number];
  side?: boolean;
}) {
  const surface = useMemo(bindVolumes, []);
  return (
    <mesh position={position} rotation={[0, side ? Math.PI / 2 : 0, 0]}>
      <IslandPropGeometry surface={surface} />
      <meshStandardMaterial vertexColors roughness={0.83} />
    </mesh>
  );
}

function writingSet() {
  const b = createIslandPropBuilder();
  b.box([0, 0.013, 0.15], [1.14, 0.024, 0.66], '#466d67');
  for (const side of [-1, 1]) {
    b.box([0, 0.028, 0.15 + side * 0.3], [1.08, 0.003, 0.011], '#b49a71');
    b.box([side * 0.204, 0.05, 0.17], [0.409, 0.043, 0.43], '#947459', [0, 0, -side * 0.055]);
    b.box([side * 0.201, 0.081, 0.17], [0.392, 0.021, 0.409], '#e2d2b3', [0, 0, -side * 0.055]);
    for (let line = 0; line < 4; line++) {
      const len = line === 3 ? 0.14 : 0.25;
      b.box([side * 0.21, 0.094, 0.12 + line * 0.048], [len, 0.002, 0.009], '#ae9e85', [
        0,
        0,
        -side * 0.055,
      ]);
    }
  }
  b.beam([0.5, 0.058, -0.02], [0.44, 0.058, 0.31], 0.026, '#584c48');
  b.beam([0.44, 0.058, 0.31], [0.43, 0.052, 0.36], 0.017, '#c8a46a');
  b.add(new THREE.CylinderGeometry(0.083, 0.095, 0.12, 8), [0.31, 0.065, -0.36], '#48626c');
  b.add(new THREE.CylinderGeometry(0.063, 0.068, 0.035, 12), [0.31, 0.14, -0.36], '#aa8859');
  return b.finish();
}

export function WritingSet() {
  const surface = useMemo(writingSet, []);
  return (
    <mesh position={[0, 1.19, 0]}>
      <IslandPropGeometry surface={surface} />
      <meshStandardMaterial vertexColors roughness={0.7} />
    </mesh>
  );
}

function atlasPaper() {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#637b76';
  ctx.fillRect(0, 0, 768, 512);
  ctx.fillStyle = '#415d61';
  ctx.fillRect(12, 12, 342, 488);
  ctx.strokeStyle = '#b3a783';
  ctx.lineWidth = 2;
  ctx.strokeRect(22, 23, 322, 464);
  const cx = 183,
    cy = 239;
  for (const r of [40, 72, 105, 130, 138]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    const angle = (i * Math.PI) / 20;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * 130, cy + Math.sin(angle) * 130);
    const r = i % 5 ? 134 : 142;
    ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    ctx.stroke();
  }
  const stars = [
    [88, 216],
    [143, 177],
    [182, 251],
    [257, 216],
    [219, 304],
    [166, 291],
  ] as const;
  ctx.beginPath();
  for (const [i, [x, y]] of stars.entries()) {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  for (const [x, y] of stars) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#efe1b7';
    ctx.fill();
  }
  ctx.fillStyle = '#e4d9bd';
  ctx.fillRect(373, 12, 383, 488);
  ctx.strokeStyle = '#ac9878';
  ctx.strokeRect(387, 24, 355, 465);
  // A botanical study on the facing leaf of the atelier's atlas.
  ctx.save();
  ctx.translate(544, 397);
  ctx.rotate(0.16);
  ctx.strokeStyle = '#758372';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 12);
  ctx.quadraticCurveTo(9, -112, -8, -264);
  ctx.stroke();
  for (let i = 0; i < 9; i++) {
    const side = i % 2 ? 1 : -1;
    const y = -28 - i * 25;
    const span = (67 - i * 4) * side;
    ctx.beginPath();
    ctx.moveTo(1, y);
    ctx.bezierCurveTo(span * 0.25, y - 42, span * 0.76, y - 24, span, y - 48);
    ctx.bezierCurveTo(span * 0.89, y - 16, span * 0.47, y + 2, 1, y);
    ctx.fillStyle = i % 3 ? '#859882' : '#9ba489';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(1, y);
    ctx.lineTo(span * 0.85, y - 36);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
  return canvas;
}

export function AtlasSheets() {
  const paper = useMemo(atlasPaper, []);
  return (
    <mesh position={[0, 1.52, 0.082]}>
      <planeGeometry args={[2.04, 1.53]} />
      <meshStandardMaterial roughness={0.92}>
        <canvasTexture
          attach="map"
          args={[paper]}
          colorSpace={THREE.SRGBColorSpace}
          anisotropy={4}
        />
      </meshStandardMaterial>
    </mesh>
  );
}

function galleryFrame() {
  const b = createIslandPropBuilder();
  const iron = '#486c65',
    bronze = '#a58b68';
  // Supports stand within the footprints of the reading shelf, folio stand and sofa.
  const posts = [-4.08, -1.2, 1.2, 3.66];
  const z = -3.98;
  for (const x of posts) {
    b.add(new THREE.CylinderGeometry(0.075, 0.09, 2.72, 12), [x, 1.36, z], iron);
    b.add(new THREE.CylinderGeometry(0.16, 0.19, 0.19, 12), [x, 0.095, z], bronze);
    for (const y of [0.26, 2.4, 2.67]) {
      b.add(new THREE.CylinderGeometry(0.109, 0.109, 0.068, 12), [x, y, z], bronze);
    }
    b.add(new THREE.SphereGeometry(0.096, 12, 8), [x, 2.78, z], bronze);
  }
  for (let i = 1; i < posts.length; i++) {
    const left = posts[i - 1]!,
      right = posts[i]!,
      middle = (left + right) / 2;
    const crest = i === 2 ? 3.54 : 3.25;
    for (const offset of [0, 0.11]) {
      const rail = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(left, 2.45 + offset, z),
        new THREE.Vector3(middle, 2 * crest - 2.45 + offset, z),
        new THREE.Vector3(right, 2.45 + offset, z),
      );
      b.add(
        new THREE.TubeGeometry(rail, 24, offset ? 0.027 : 0.046, 7, false),
        [0, 0, 0],
        offset ? bronze : iron,
      );
    }
    b.beam([middle, crest - 0.17, z], [middle, crest, z], 0.028, bronze);
    b.add(
      new THREE.SphereGeometry(0.102, 12, 10).scale(1, 1.32, 1),
      [middle, crest - 0.28, z],
      '#e2cc9b',
    );
    b.add(new THREE.ConeGeometry(0.14, 0.09, 12), [middle, crest - 0.165, z], bronze);
    b.add(new THREE.CylinderGeometry(0.093, 0.035, 0.06, 12), [middle, crest - 0.41, z], iron);
  }
  return b.finish();
}

export function ReadingGallery() {
  const frame = useMemo(galleryFrame, []);
  return (
    <mesh name="reading-gallery">
      <IslandPropGeometry surface={frame} />
      <meshStandardMaterial vertexColors roughness={0.65} />
    </mesh>
  );
}
