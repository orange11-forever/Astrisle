import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

type Point = [number, number, number];
type Geometry = THREE.BufferGeometry;
type Surface = (x: number, y: number) => number;

export interface BlueWhaleGirl {
  root: THREE.Group;
  joints: {
    head: THREE.Group;
    leftArm: THREE.Group;
    rightArm: THREE.Group;
    leftLeg: THREE.Group;
    rightLeg: THREE.Group;
    hair: THREE.Group;
    /** Reserved animation pivot; intentionally has no visible tail geometry. */
    tail: THREE.Group;
  };
  dispose(): void;
}

/** Closed, sculpted chibi surfaces, facing +Z, soles at y=0. No reference image planes. */
export function createBlueWhaleGirl(options: { accent?: string } = {}): BlueWhaleGirl {
  const root = new THREE.Group();
  root.name = 'DaFeiYu_BlueWhaleGirl';
  root.userData = {
    title: '大肥鱼 · Q版蓝鲸女仆',
    modelVersion: 2,
    forward: '+Z',
    ground: 0,
    tailOmittedByRequest: true,
    construction:
      'Closed flowing hair panels, draped cloth and shallow anime face meshes; no image planes',
    characterAttribution: 'ZipZipPipe, based on the whale-girl design by 上善无形',
    characterSource: 'https://www.pixiv.net/artworks/148186519',
    characterDesignLicense: 'CC BY-NC-SA 4.0',
    characterDesignLicenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    referenceNotes: 'docs/concepts/blue-whale-girl-references.md',
  };
  const materials: THREE.Material[] = [];
  const flat = (name: string, color: string, vertexColors = false) => {
    const value = new THREE.MeshBasicMaterial({ color, vertexColors, toneMapped: false });
    value.name = name;
    materials.push(value);
    return value;
  };
  const cloth = (name: string, color: string) => {
    const value = new THREE.MeshStandardMaterial({
      color,
      roughness: 1,
      metalness: 0,
      emissive: color,
      emissiveIntensity: 0.2,
    });
    value.name = name;
    materials.push(value);
    return value;
  };
  const skin = flat('Soft peach anime skin', '#fff0e8');
  const cream = cloth('Ivory cotton', '#fff7f1');
  const lavender = flat('Lavender lace folds', '#d9d1e4');
  const navy = cloth('Midnight indigo dress', '#30365f');
  const navyFlat = flat('Indigo ribbons', '#333c6d');
  const ink = flat('Indigo contour ink', '#1b1c36');
  const lashInk = flat('Warm black upper lashes', '#251b29');
  const blush = flat('Soft peach blush', '#f8d2ce');
  const lip = flat('Understated rose mouth', '#b2767c');
  const white = flat('Painted eye highlights', '#f8fcff');
  const gold = flat('Muted warm gold embroidery', '#d9b882');
  const ribbon = flat('Iconic cyan fin ribbon', '#68b8e6');
  const blue = flat('Blue ribbon and whale accents', '#3f79b6');
  const gem = flat('Companion brooch accent', options.accent ?? '#68b8e6');
  const hairMat = flat('Painted periwinkle hair', '#ffffff', true);
  const hairShine = flat('Soft painted hair shine', '#879bce');
  const hairStrand = flat('Subtle blue strand contours', '#3c508b');
  const irisMat = flat('Deep blue to cyan irises', '#ffffff', true);
  const pupil = flat('Small indigo pupils', '#1d315c');

  const geometry = (p: number[], indices?: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    if (indices) g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  };
  const outlineParts = new Map<THREE.Group, Geometry[]>();
  const add = (
    parent: THREE.Group,
    name: string,
    g: Geometry,
    mat: THREE.Material,
    outline = 0,
  ) => {
    const normal = g.getAttribute('normal');
    for (let i = 0; i < normal.count; i++)
      if (normal.getX(i) ** 2 + normal.getY(i) ** 2 + normal.getZ(i) ** 2 < 1e-10)
        normal.setXYZ(i, 0, 1, 0);
    const object = new THREE.Mesh(g, mat);
    object.name = name;
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    if (outline) {
      // Reverse the actual triangle winding so outlines survive a glTF round trip.
      const shell = g.index ? g.toNonIndexed() : g.clone();
      const p = shell.getAttribute('position'),
        n = shell.getAttribute('normal');
      for (let i = 0; i < p.count; i++)
        p.setXYZ(
          i,
          p.getX(i) + n.getX(i) * outline,
          p.getY(i) + n.getY(i) * outline,
          p.getZ(i) + n.getZ(i) * outline,
        );
      shell.deleteAttribute('color');
      shell.deleteAttribute('uv');
      for (let i = 0; i < p.count; i += 3) {
        const a = [p.getX(i), p.getY(i), p.getZ(i)];
        p.setXYZ(i, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
        p.setXYZ(i + 2, a[0], a[1], a[2]);
      }
      shell.computeVertexNormals();
      const parts = outlineParts.get(parent) ?? [];
      parts.push(shell);
      outlineParts.set(parent, parts);
    }
    return object;
  };
  const combine = (
    parent: THREE.Group,
    name: string,
    parts: Geometry[],
    mat: THREE.Material,
    outline = 0,
  ) => {
    const normalized = parts.map((part) => {
      const copy = part.index ? part.toNonIndexed() : part.clone();
      copy.deleteAttribute('uv');
      return copy;
    });
    const result = mergeGeometries(normalized)!;
    for (const part of [...parts, ...normalized]) part.dispose();
    return add(parent, name, result, mat, outline);
  };
  const group = (name: string, parent: THREE.Group, position: Point = [0, 0, 0]) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(...position);
    parent.add(g);
    return g;
  };
  const sphere = (p: Point, size: Point, segments = 20, rings = 12) =>
    new THREE.SphereGeometry(1, segments, rings).scale(...size).translate(...p);
  const stroke = (p: Point[], radius: number, segments = 16, sides = 4) =>
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(p.map((v) => new THREE.Vector3(...v))),
      segments,
      radius,
      sides,
      false,
    );
  const path = (draw: (s: THREE.Shape) => void) => {
    const s = new THREE.Shape();
    draw(s);
    s.closePath();
    return s;
  };
  const ellipse = (x: number, y: number, rx: number, ry: number) => {
    const s = new THREE.Shape();
    s.absellipse(x, y, rx, ry, 0, Math.PI * 2, false, 0);
    return s;
  };
  // Sample triangle interiors before bending: a perimeter-only fan cuts through
  // convex garments and makes holes in an apron even when its boundary is clear.
  const sheet = (s: THREE.Shape, surface: Surface, depth = 0.012, divisions = 1) => {
    const original = new THREE.ShapeGeometry(s, 8);
    const triangles = original.toNonIndexed();
    original.dispose();
    const source = triangles.getAttribute('position'),
      positions: number[] = [];
    const emit = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, level: number) => {
      if (level) {
        const ab = a.clone().add(b).multiplyScalar(0.5),
          bc = b.clone().add(c).multiplyScalar(0.5),
          ca = c.clone().add(a).multiplyScalar(0.5);
        emit(a, ab, ca, level - 1);
        emit(ab, b, bc, level - 1);
        emit(ca, bc, c, level - 1);
        emit(ab, bc, ca, level - 1);
        return;
      }
      for (const p of [a, b, c]) positions.push(p.x, p.y, surface(p.x, p.y));
      for (const p of [c, b, a]) positions.push(p.x, p.y, surface(p.x, p.y) - depth);
    };
    for (let i = 0; i < source.count; i += 3)
      emit(
        new THREE.Vector2(source.getX(i), source.getY(i)),
        new THREE.Vector2(source.getX(i + 1), source.getY(i + 1)),
        new THREE.Vector2(source.getX(i + 2), source.getY(i + 2)),
        divisions,
      );
    const edge = s.getPoints(8);
    if (THREE.ShapeUtils.isClockWise(edge)) edge.reverse();
    for (let i = 0; i < edge.length - 1; i++) {
      const a = edge[i],
        b = edge[i + 1],
        az = surface(a.x, a.y),
        bz = surface(b.x, b.y);
      positions.push(
        a.x,
        a.y,
        az,
        a.x,
        a.y,
        az - depth,
        b.x,
        b.y,
        bz,
        a.x,
        a.y,
        az - depth,
        b.x,
        b.y,
        bz - depth,
        b.x,
        b.y,
        bz,
      );
    }
    triangles.dispose();
    return geometry(positions);
  };
  const paint = (
    g: Geometry,
    low: string,
    high: string,
    bottom: number,
    top: number,
    shaded = false,
  ) => {
    const p = g.getAttribute('position'),
      n = g.getAttribute('normal'),
      colors: number[] = [];
    const a = new THREE.Color(low),
      b = new THREE.Color(high),
      c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      c.copy(a).lerp(b, THREE.MathUtils.smoothstep(p.getY(i), bottom, top));
      if (shaded) c.multiplyScalar(0.88 + 0.12 * Math.max(0, n.getZ(i)));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return g;
  };
  const hairPaint = (g: Geometry) => paint(g, '#6b91cf', '#4d5f9f', -0.88, 0.24, true);
  const flowingHair = (g: Geometry) => {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < -0.2) p.setY(i, -0.2 + (y + 0.2) * 1.27);
    }
    g.computeVertexNormals();
    return g;
  };
  const mirror = (s: THREE.Shape, side: number) =>
    path((value) => {
      const p = s.getPoints(8);
      value.moveTo(p[0].x * side, p[0].y);
      for (const v of p.slice(1)) value.lineTo(v.x * side, v.y);
    });
  const bowParts = (x: number, y: number, z: number, scale: number) => {
    const parts: Geometry[] = [];
    for (const side of [-1, 1]) {
      parts.push(
        sheet(
          path((s) => {
            s.moveTo(x, y);
            s.bezierCurveTo(
              x + side * scale * 0.04,
              y + scale * 0.025,
              x + side * scale * 0.1,
              y + scale * 0.075,
              x + side * scale * 0.108,
              y + scale * 0.044,
            );
            s.bezierCurveTo(
              x + side * scale * 0.125,
              y + scale * 0.012,
              x + side * scale * 0.108,
              y - scale * 0.054,
              x + side * scale * 0.087,
              y - scale * 0.044,
            );
            s.quadraticCurveTo(x + side * scale * 0.035, y - scale * 0.023, x, y);
          }),
          (px) => z + 0.02 * Math.sin((Math.abs(px - x) / scale) * 20),
          0.018,
          1,
        ),
      );
      parts.push(
        sheet(
          path((s) => {
            s.moveTo(x + side * scale * 0.014, y - scale * 0.008);
            s.lineTo(x + side * scale * 0.071, y - scale * 0.089);
            s.lineTo(x + side * scale * 0.036, y - scale * 0.078);
            s.lineTo(x + side * scale * 0.022, y - scale * 0.097);
            s.lineTo(x, y - scale * 0.012);
          }),
          () => z - 0.006,
          0.01,
          0,
        ),
      );
    }
    return parts;
  };

  const dress = group('Outfit', root);
  add(dress, 'Dress_bodice', sphere([0, 0.722, 0], [0.204, 0.183, 0.15], 28, 18), navy, 0.003);
  const skirtRadius = (t: number, angle = 0) =>
    0.185 + 0.263 * t + 0.008 * Math.cos(angle * 12) * t;
  const skirt = (petticoat = false) => {
    const positions: number[] = [],
      indices: number[] = [],
      rows = petticoat ? 5 : 14,
      cols = 96;
    for (let row = 0; row <= rows; row++) {
      const t = row / rows;
      for (let col = 0; col <= cols; col++) {
        const a = (col / cols) * Math.PI * 2;
        const r = petticoat ? 0.428 + t * 0.048 + Math.cos(a * 24) * t * 0.006 : skirtRadius(t, a);
        const y = petticoat ? 0.214 - t * 0.065 + Math.cos(a * 24) * 0.007 * t : 0.635 - 0.43 * t;
        positions.push(Math.sin(a) * r, y, Math.cos(a) * r * 0.67);
        if (row < rows && col < cols) {
          const n = row * (cols + 1) + col;
          indices.push(n, n + cols + 1, n + 1, n + 1, n + cols + 1, n + cols + 2);
        }
      }
    }
    return geometry(positions, indices);
  };
  add(dress, 'Twelve_pleat_bell_skirt', skirt(), navy, 0.003);
  cream.side = THREE.DoubleSide;
  add(dress, 'Thin_scalloped_petticoat', skirt(true), cream, 0.002);
  const embroidery: Geometry[] = [],
    petticoatFolds: Geometry[] = [];
  for (const [height, radius] of [
    [0.22, 0.44],
    [0.243, 0.427],
  ]) {
    const p: Point[] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      p.push([Math.sin(a) * radius, height, Math.cos(a) * radius * 0.67 + 0.003]);
    }
    embroidery.push(stroke(p, 0.0023, 96, 3));
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    petticoatFolds.push(
      sheet(
        path((s) => {
          s.moveTo(-0.008, 0.207);
          s.lineTo(0.008, 0.207);
          s.lineTo(0, 0.159);
        }),
        () => 0.309,
        0.001,
        0,
      ).rotateY(a),
    );
    const vine: Point[] = [];
    for (let j = 0; j <= 10; j++) {
      const angle = a + ((j / 10) * Math.PI) / 12;
      vine.push([
        Math.sin(angle) * 0.41,
        0.277 + 0.008 * Math.sin((j / 10) * Math.PI * 2),
        Math.cos(angle) * 0.41 * 0.67 + 0.004,
      ]);
    }
    embroidery.push(stroke(vine, 0.0017, 10, 3));
    for (const sign of [-1, 1])
      embroidery.push(
        sphere([0, 0, 0], [0.005, 0.014, 0.0014], 6, 3)
          .rotateZ(sign * 0.65)
          .translate(0, 0.29, 0.276)
          .rotateY(a + 0.06 * sign),
      );
  }
  combine(dress, 'Gold_hem_vine_embroidery', embroidery, gold);
  combine(dress, 'Petticoat_pressed_folds', petticoatFolds, lavender);
  const skirtGoldBows: Geometry[] = [],
    skirtRibbonEnds: Geometry[] = [];
  for (const side of [-1, 1]) {
    const pieces = bowParts(side * 0.287, 0.315, 0.221, 0.48);
    skirtGoldBows.push(
      pieces[0],
      pieces[2],
      sphere([side * 0.287, 0.315, 0.243], [0.009, 0.012, 0.005], 8, 5),
    );
    skirtRibbonEnds.push(pieces[1], pieces[3]);
  }
  combine(dress, 'Paired_gold_skirt_corner_bows', skirtGoldBows, gold);
  combine(dress, 'Skirt_bow_navy_streamers', skirtRibbonEnds, navyFlat);
  const frontOfSkirt: Surface = (x, y) => {
    const t = THREE.MathUtils.clamp((0.635 - y) / 0.43, 0, 1),
      r = skirtRadius(t);
    return Math.sqrt(Math.max(0.001, r * r - x * x)) * 0.67 + 0.021;
  };
  const apronShape = path((s) => {
    s.moveTo(-0.151, 0.623);
    s.quadraticCurveTo(0, 0.608, 0.151, 0.623);
    s.bezierCurveTo(0.174, 0.56, 0.212, 0.451, 0.206, 0.389);
    s.bezierCurveTo(0.201, 0.315, 0.095, 0.287, 0, 0.288);
    s.bezierCurveTo(-0.095, 0.287, -0.201, 0.315, -0.206, 0.389);
    s.bezierCurveTo(-0.212, 0.451, -0.174, 0.56, -0.151, 0.623);
  });
  add(dress, 'White_whale_apron', sheet(apronShape, frontOfSkirt, 0.008, 2), cream, 0.0015);
  const apronLace: Geometry[] = [],
    apronFolds: Geometry[] = [],
    apronEdge = apronShape.getSpacedPoints(40);
  for (let i = 4; i < 38; i++) {
    const p = apronEdge[i],
      q = apronEdge[i + 1],
      mid = p.clone().add(q).multiplyScalar(0.5);
    const out = new THREE.Vector2(mid.x, mid.y - 0.47).normalize();
    apronLace.push(
      sheet(
        path((s) => {
          s.moveTo(p.x, p.y);
          s.lineTo(q.x, q.y);
          s.quadraticCurveTo(
            q.x + out.x * 0.045,
            q.y + out.y * 0.045,
            mid.x + out.x * 0.033,
            mid.y + out.y * 0.033,
          );
          s.quadraticCurveTo(p.x + out.x * 0.044, p.y + out.y * 0.044, p.x, p.y);
        }),
        (x, y) => frontOfSkirt(x, y) + 0.002,
        0.005,
        0,
      ),
    );
    apronFolds.push(
      stroke(
        [
          [mid.x, mid.y, frontOfSkirt(mid.x, mid.y) + 0.005],
          [mid.x + out.x * 0.025, mid.y + out.y * 0.025, frontOfSkirt(mid.x, mid.y) + 0.008],
        ],
        0.0013,
        2,
        3,
      ),
    );
  }
  combine(dress, 'Apron_thin_scalloped_lace', apronLace, cream);
  combine(dress, 'Apron_lavender_folds', apronFolds, lavender);
  add(
    dress,
    'Apron_waist_band',
    sheet(
      path((s) => {
        s.moveTo(-0.184, 0.615);
        s.quadraticCurveTo(0, 0.589, 0.184, 0.615);
        s.lineTo(0.183, 0.645);
        s.quadraticCurveTo(0, 0.624, -0.183, 0.645);
      }),
      (x) => 0.158 - x * x * 0.5,
      0.012,
      2,
    ),
    cream,
  );
  add(
    dress,
    'White_buttoned_shirt_bib',
    sheet(
      path((s) => {
        s.moveTo(-0.096, 0.85);
        s.lineTo(0.096, 0.85);
        s.lineTo(0.098, 0.699);
        s.lineTo(-0.098, 0.699);
      }),
      () => 0.148,
      0.012,
      1,
    ),
    cream,
  );
  const straps: Geometry[] = [],
    strapFolds: Geometry[] = [],
    buttons: Geometry[] = [];
  for (const side of [-1, 1]) {
    straps.push(
      sheet(
        path((s) => {
          s.moveTo(side * 0.106, 0.625);
          s.lineTo(side * 0.137, 0.625);
          s.lineTo(side * 0.163, 0.852);
          s.lineTo(side * 0.122, 0.862);
        }),
        () => 0.162,
        0.01,
        1,
      ),
    );
    for (let i = 0; i < 6; i++) {
      const y = 0.65 + i * 0.034,
        x = side * (0.143 + i * 0.0035);
      straps.push(
        sheet(
          path((s) => {
            s.moveTo(x, y);
            s.lineTo(x, y + 0.035);
            s.bezierCurveTo(x + side * 0.048, y + 0.04, x + side * 0.039, y - 0.008, x, y);
          }),
          () => 0.157,
          0.006,
          0,
        ),
      );
      strapFolds.push(
        stroke(
          [
            [x + side * 0.007, y + 0.015, 0.164],
            [x + side * 0.024, y + 0.021, 0.165],
          ],
          0.0015,
          2,
          3,
        ),
      );
    }
    for (const y of [0.653, 0.684])
      buttons.push(sphere([side * 0.052, y, 0.151], [0.0045, 0.006, 0.003], 8, 5));
  }
  combine(dress, 'Cloth_ruffled_apron_straps', straps, cream);
  combine(dress, 'Strap_fold_accents', strapFolds, lavender);
  for (const y of [0.724, 0.761]) buttons.push(sphere([0, y, 0.163], [0.004, 0.006, 0.002], 8, 5));
  combine(dress, 'Bodice_gold_buttons', buttons, gold);
  combine(dress, 'Large_neck_bow', bowParts(0, 0.825, 0.18, 0.92), navyFlat, 0.0025);
  add(dress, 'Neck_brooch_gold_rim', sphere([0, 0.825, 0.205], [0.022, 0.028, 0.008], 16, 8), gold);
  add(dress, 'Neck_brooch_gem', sphere([0, 0.826, 0.214], [0.013, 0.019, 0.004], 12, 6), gem);
  combine(
    dress,
    'Back_apron_bow',
    bowParts(0, 0.627, 0.18, 1.3).map((g) => g.rotateY(Math.PI)),
    cream,
    0.002,
  );
  const whale = path((s) => {
    s.moveTo(-0.082, 0.399);
    s.bezierCurveTo(-0.087, 0.46, -0.023, 0.48, 0.019, 0.438);
    s.bezierCurveTo(0.049, 0.409, 0.068, 0.425, 0.067, 0.444);
    s.bezierCurveTo(0.045, 0.447, 0.045, 0.468, 0.055, 0.474);
    s.quadraticCurveTo(0.074, 0.463, 0.075, 0.452);
    s.quadraticCurveTo(0.091, 0.472, 0.109, 0.468);
    s.quadraticCurveTo(0.107, 0.44, 0.081, 0.439);
    s.bezierCurveTo(0.073, 0.38, 0.005, 0.368, -0.048, 0.381);
    s.quadraticCurveTo(-0.077, 0.386, -0.082, 0.399);
  });
  const whaleParts = [sheet(whale, (x, y) => frontOfSkirt(x, y) + 0.007, 0.002, 1)];
  for (const [x, y, angle] of [
    [-0.021, 0.493, -0.6],
    [-0.007, 0.506, 0],
    [0.009, 0.495, 0.6],
  ])
    whaleParts.push(
      sphere([0, 0, 0], [0.0045, 0.009, 0.001], 8, 5)
        .rotateZ(angle)
        .translate(x, y, frontOfSkirt(x, y) + 0.009),
    );
  combine(dress, 'Blue_whale_apron_emblem', whaleParts, blue);
  add(
    dress,
    'Whale_pale_belly',
    sheet(
      path((s) => {
        s.moveTo(-0.078, 0.415);
        s.quadraticCurveTo(-0.028, 0.412, 0.035, 0.382);
        s.quadraticCurveTo(-0.064, 0.371, -0.078, 0.415);
      }),
      (x, y) => frontOfSkirt(x, y) + 0.01,
      0.001,
      1,
    ),
    white,
  );
  const whaleLines: Geometry[] = [];
  for (let i = 0; i < 6; i++) {
    const x = -0.071 + i * 0.013;
    whaleLines.push(
      stroke(
        [
          [x, 0.409 - i * 0.004, frontOfSkirt(x, 0.409) + 0.013],
          [x + 0.011, 0.385, frontOfSkirt(x + 0.011, 0.385) + 0.013],
        ],
        0.001,
        4,
        3,
      ),
    );
  }
  combine(dress, 'Whale_belly_lines', whaleLines, blue);
  add(
    dress,
    'Whale_emblem_eye',
    sphere([-0.02, 0.433, frontOfSkirt(-0.02, 0.433) + 0.012], [0.0025, 0.0025, 0.001], 8, 4),
    ink,
  );

  const head = group('Head_pivot', root, [0, 1.25, 0]),
    hair = group('Long_hair_pivot', head);
  const faceShape = path((s) => {
    s.moveTo(0, 0.365);
    s.bezierCurveTo(-0.27, 0.37, -0.455, 0.235, -0.47, 0.015);
    s.bezierCurveTo(-0.482, -0.18, -0.423, -0.295, -0.315, -0.326);
    s.bezierCurveTo(-0.2, -0.372, 0.2, -0.372, 0.315, -0.326);
    s.bezierCurveTo(0.423, -0.295, 0.482, -0.18, 0.47, 0.015);
    s.bezierCurveTo(0.455, 0.235, 0.27, 0.37, 0, 0.365);
  });
  const faceZ: Surface = (x, y) =>
    0.272 - 0.067 * (x / 0.48) ** 6 - 0.037 * ((y + 0.015) / 0.39) ** 8;
  const edge = faceShape.getSpacedPoints(48).slice(0, 48),
    fp: number[] = [],
    fi: number[] = [],
    rings = 8,
    cols = edge.length;
  for (let layer = 0; layer < 2; layer++)
    for (let row = 0; row <= rings; row++) {
      const r = row / rings;
      for (const p of edge) {
        const x = p.x * r,
          y = -0.015 + (p.y + 0.015) * r;
        fp.push(
          x,
          y,
          layer === 0 ? faceZ(x, y) : -0.23 + (faceZ(p.x, p.y) + 0.23) * (1 - Math.sqrt(1 - r * r)),
        );
      }
    }
  const layerSize = (rings + 1) * cols;
  for (let layer = 0; layer < 2; layer++)
    for (let row = 0; row < rings; row++)
      for (let col = 0; col < cols; col++) {
        const a = layer * layerSize + row * cols + col,
          b = layer * layerSize + row * cols + ((col + 1) % cols),
          c = a + cols,
          d = b + cols;
        if (layer === 0) fi.push(a, c, b, b, c, d);
        else fi.push(a, b, c, b, d, c);
      }
  add(head, 'Round_cheeks_and_face', geometry(fp, fi), skin, 0.0035);
  const cp: number[] = [],
    ci: number[] = [];
  const capRows = 14,
    capColumns = 48;
  for (let row = 0; row <= capRows; row++)
    for (let col = 0; col <= capColumns; col++) {
      const a = (col / capColumns) * Math.PI * 2,
        t = (row / capRows) * (2.1 - 0.6 * Math.cos(a));
      cp.push(
        0.509 * Math.sin(t) * Math.sin(a),
        -0.004 + 0.454 * Math.cos(t),
        -0.02 +
          0.345 *
            Math.sin(t) ** (Math.cos(a) > 0 ? 0.45 : 1) *
            Math.sign(Math.cos(a)) *
            Math.abs(Math.cos(a)) ** (Math.cos(a) > 0 ? 0.18 : 0.35),
      );
      if (row < capRows && col < capColumns) {
        const n = row * (capColumns + 1) + col;
        ci.push(n, n + capColumns + 1, n + 1, n + 1, n + capColumns + 1, n + capColumns + 2);
      }
    }
  // A closed shell with a broad, flattened front wraps the whole skull. A
  // spherical cap would let the flatter anime forehead pierce its temples.
  const outerCap = geometry(cp, ci),
    capNormals = outerCap.getAttribute('normal');
  const capVertexCount = cp.length / 3,
    originalCapIndices = [...ci];
  for (let i = 0; i < capVertexCount; i++)
    cp.push(
      cp[i * 3] - capNormals.getX(i) * 0.012,
      cp[i * 3 + 1] - capNormals.getY(i) * 0.012,
      cp[i * 3 + 2] - capNormals.getZ(i) * 0.012,
    );
  for (let i = 0; i < originalCapIndices.length; i += 3)
    ci.push(
      originalCapIndices[i + 2] + capVertexCount,
      originalCapIndices[i + 1] + capVertexCount,
      originalCapIndices[i] + capVertexCount,
    );
  for (let col = 0; col < capColumns; col++) {
    const a = capRows * (capColumns + 1) + col,
      b = a + 1;
    ci.push(a, a + capVertexCount, b, b, a + capVertexCount, b + capVertexCount);
  }
  outerCap.dispose();
  add(head, 'Periwinkle_hair_crown', hairPaint(geometry(cp, ci)), hairMat);
  const rearSurface: Surface = (x, y) =>
    -0.2 -
    0.06 * Math.cos(x * 4) -
    0.015 * Math.cos(y * 8) -
    0.06 * THREE.MathUtils.smoothstep(-y, -0.05, 0.25);
  const centerBackLock = path((s) => {
    s.moveTo(-0.16, 0.18);
    s.bezierCurveTo(-0.23, -0.1, -0.13, -0.46, -0.21, -0.66);
    s.bezierCurveTo(-0.25, -0.79, -0.17, -0.94, -0.08, -0.96);
    s.quadraticCurveTo(-0.12, -0.9, -0.09, -0.84);
    s.bezierCurveTo(-0.05, -0.92, 0.018, -1.02, 0.08, -1.025);
    s.quadraticCurveTo(0.15, -0.99, 0.13, -0.9);
    s.bezierCurveTo(0.12, -0.8, 0.05, -0.74, 0.085, -0.63);
    s.bezierCurveTo(0.15, -0.45, 0.1, -0.2, 0.18, 0.18);
  });
  const middleBackLock = path((s) => {
    s.moveTo(0.13, 0.17);
    s.bezierCurveTo(0.34, 0.07, 0.39, -0.22, 0.35, -0.46);
    s.bezierCurveTo(0.31, -0.62, 0.4, -0.72, 0.32, -0.86);
    s.quadraticCurveTo(0.36, -0.93, 0.43, -0.86);
    s.bezierCurveTo(0.42, -1.02, 0.26, -1.045, 0.2, -0.95);
    s.bezierCurveTo(0.14, -0.84, 0.24, -0.77, 0.19, -0.67);
    s.bezierCurveTo(0.09, -0.49, 0.11, -0.2, 0.13, 0.17);
  });
  const outerBackLock = path((s) => {
    s.moveTo(0.32, 0.08);
    s.bezierCurveTo(0.47, -0.08, 0.44, -0.3, 0.49, -0.43);
    s.bezierCurveTo(0.59, -0.61, 0.49, -0.76, 0.54, -0.89);
    s.quadraticCurveTo(0.58, -0.93, 0.61, -0.87);
    s.bezierCurveTo(0.62, -1.01, 0.45, -1.03, 0.41, -0.93);
    s.bezierCurveTo(0.37, -0.84, 0.42, -0.7, 0.36, -0.6);
    s.bezierCurveTo(0.3, -0.41, 0.28, -0.14, 0.32, 0.08);
  });
  const backLocks: Geometry[] = [];
  for (const side of [-1, 1]) {
    backLocks.push(hairPaint(sheet(mirror(outerBackLock, side), rearSurface, 0.055, 0)));
    backLocks.push(
      hairPaint(sheet(mirror(middleBackLock, side), (x, y) => rearSurface(x, y) - 0.009, 0.055, 0)),
    );
  }
  backLocks.push(hairPaint(sheet(centerBackLock, (x, y) => rearSurface(x, y) - 0.019, 0.055, 0)));
  combine(hair, 'Five_overlapping_curled_back_locks', backLocks, hairMat, 0.002);
  const rearStrands: Geometry[] = [];
  for (const side of [-1, 1]) {
    for (const points of [
      [
        [0.18, -0.18],
        [0.21, -0.4],
        [0.19, -0.58],
        [0.25, -0.72],
      ],
      [
        [0.36, -0.37],
        [0.43, -0.55],
        [0.44, -0.72],
        [0.47, -0.84],
      ],
    ]) {
      const p: Point[] = points.map(([x, y]) => [x * side, y, rearSurface(x * side, y) - 0.068]);
      rearStrands.push(stroke(p, 0.0015, 14, 3));
    }
  }
  rearStrands.push(
    stroke(
      [
        [0.02, -0.12, rearSurface(0.02, -0.12) - 0.077],
        [0.03, -0.35, rearSurface(0.03, -0.35) - 0.077],
        [-0.025, -0.54, rearSurface(-0.025, -0.54) - 0.077],
      ],
      0.0015,
      18,
      3,
    ),
  );
  combine(hair, 'Subtle_flowing_back_strand_contours', rearStrands, hairStrand);
  const outer = path((s) => {
    s.moveTo(0.365, 0.23);
    s.bezierCurveTo(0.49, 0.05, 0.447, -0.2, 0.515, -0.37);
    s.bezierCurveTo(0.595, -0.55, 0.64, -0.61, 0.545, -0.72);
    s.quadraticCurveTo(0.568, -0.77, 0.613, -0.735);
    s.bezierCurveTo(0.628, -0.85, 0.47, -0.87, 0.437, -0.79);
    s.bezierCurveTo(0.478, -0.78, 0.458, -0.7, 0.408, -0.65);
    s.bezierCurveTo(0.337, -0.55, 0.37, -0.43, 0.316, -0.29);
    s.bezierCurveTo(0.28, -0.12, 0.3, 0.1, 0.365, 0.23);
  });
  const inner = path((s) => {
    s.moveTo(0.358, -0.17);
    s.bezierCurveTo(0.445, -0.28, 0.4, -0.36, 0.359, -0.44);
    s.bezierCurveTo(0.315, -0.51, 0.335, -0.57, 0.375, -0.55);
    s.bezierCurveTo(0.353, -0.65, 0.257, -0.61, 0.262, -0.54);
    s.bezierCurveTo(0.263, -0.48, 0.315, -0.44, 0.285, -0.34);
    s.quadraticCurveTo(0.266, -0.22, 0.358, -0.17);
  });
  const loose = path((s) => {
    s.moveTo(0.437, -0.12);
    s.bezierCurveTo(0.5, -0.37, 0.68, -0.42, 0.598, -0.6);
    s.bezierCurveTo(0.55, -0.67, 0.582, -0.7, 0.61, -0.67);
    s.bezierCurveTo(0.57, -0.77, 0.49, -0.66, 0.544, -0.58);
    s.bezierCurveTo(0.617, -0.46, 0.44, -0.4, 0.411, -0.25);
    s.lineTo(0.437, -0.12);
  });
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'Right' : 'Left';
    add(
      hair,
      name + '_broad_S_wave',
      hairPaint(
        flowingHair(
          sheet(
            mirror(outer, side),
            (x, y) => 0.02 + 0.05 * Math.sin((y + 0.3) * 7) - 0.08 * Math.abs(x),
            0.055,
            1,
          ),
        ),
      ),
      hairMat,
      0.0035,
    );
    add(
      hair,
      name + '_loose_tapered_wave',
      hairPaint(flowingHair(sheet(mirror(loose, side), () => -0.055, 0.027, 0))),
      hairMat,
      0.003,
    );
    add(
      hair,
      name + '_short_face_framing_wave',
      hairPaint(
        flowingHair(
          sheet(mirror(inner, side), (_x, y) => 0.22 + 0.018 * Math.sin(y * 9), 0.035, 1),
        ),
      ),
      hairMat,
      0.003,
    );
  }
  const fringeZ: Surface = (x, y) => 0.31 + 0.048 * Math.sin((y + 0.22) * 5) - 0.19 * x * x;
  const centralBang = path((s) => {
    s.moveTo(-0.116, 0.408);
    s.bezierCurveTo(0.028, 0.449, 0.147, 0.344, 0.126, 0.179);
    s.bezierCurveTo(0.124, 0.025, 0.066, -0.077, 0.104, -0.177);
    s.quadraticCurveTo(0.048, -0.18, 0.021, -0.155);
    s.lineTo(0.005, -0.177);
    s.bezierCurveTo(-0.075, -0.112, -0.124, -0.025, -0.12, 0.147);
    s.quadraticCurveTo(-0.124, 0.31, -0.116, 0.408);
  });
  const rightBang = path((s) => {
    s.moveTo(0.038, 0.414);
    s.bezierCurveTo(0.255, 0.454, 0.452, 0.285, 0.475, 0.094);
    s.bezierCurveTo(0.488, -0.07, 0.426, -0.265, 0.313, -0.322);
    s.quadraticCurveTo(0.324, -0.31, 0.359, -0.281);
    s.quadraticCurveTo(0.335, -0.337, 0.256, -0.335);
    s.quadraticCurveTo(0.208, -0.337, 0.188, -0.316);
    s.bezierCurveTo(0.27, -0.272, 0.291, -0.167, 0.26, -0.073);
    s.bezierCurveTo(0.1, 0.09, 0.105, 0.255, 0.06, 0.33);
    s.quadraticCurveTo(0.073, 0.352, 0.038, 0.414);
  });
  const leftBang = path((s) => {
    s.moveTo(-0.024, 0.415);
    s.bezierCurveTo(-0.238, 0.462, -0.445, 0.28, -0.487, 0.072);
    s.bezierCurveTo(-0.49, -0.14, -0.436, -0.292, -0.305, -0.327);
    s.quadraticCurveTo(-0.3, -0.281, -0.307, -0.248);
    s.quadraticCurveTo(-0.253, -0.308, -0.207, -0.285);
    s.bezierCurveTo(-0.304, -0.237, -0.23, -0.085, -0.18, 0.065);
    s.bezierCurveTo(-0.12, 0.166, -0.1, 0.302, -0.024, 0.415);
  });
  add(
    head,
    'Broad_right_swept_fringe',
    hairPaint(sheet(rightBang, fringeZ, 0.027, 1)),
    hairMat,
    0.0035,
  );
  add(
    head,
    'Broad_left_swept_fringe',
    hairPaint(sheet(leftBang, fringeZ, 0.027, 1)),
    hairMat,
    0.0035,
  );
  add(
    head,
    'Pointed_central_fringe',
    hairPaint(sheet(centralBang, (x, y) => fringeZ(x, y) + 0.015, 0.025, 1)),
    hairMat,
    0.0035,
  );
  const shine: Geometry[] = [];
  for (const [x, y, rx, ry, angle] of [
    [-0.29, 0.235, 0.021, 0.045, -0.5],
    [-0.219, 0.18, 0.008, 0.023, -0.3],
    [-0.074, 0.168, 0.019, 0.043, 0.12],
    [-0.034, 0.164, 0.009, 0.022, 0],
    [0.018, 0.17, 0.009, 0.021, 0],
    [0.271, 0.236, 0.01, 0.026, 0.5],
  ]) {
    const g = sheet(ellipse(0, 0, rx, ry), () => 0, 0.001, 0)
        .rotateZ(angle)
        .translate(x, y, 0),
      p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++)
      p.setZ(i, p.getZ(i) + fringeZ(p.getX(i), p.getY(i)) + (Math.abs(x) < 0.13 ? 0.018 : 0.003));
    g.computeVertexNormals();
    shine.push(g);
  }
  combine(head, 'Painted_periwinkle_hair_highlights', shine, hairShine);
  const ahoge = path((s) => {
    s.moveTo(0.018, 0.419);
    s.bezierCurveTo(0.083, 0.567, -0.043, 0.641, -0.177, 0.576);
    s.bezierCurveTo(-0.269, 0.534, -0.338, 0.424, -0.282, 0.426);
    s.bezierCurveTo(-0.278, 0.486, -0.18, 0.563, -0.092, 0.569);
    s.bezierCurveTo(-0.024, 0.575, 0.042, 0.539, 0.018, 0.419);
  });
  add(head, 'Single_arched_ahoge', hairPaint(sheet(ahoge, () => 0.005, 0.018, 1)), hairMat, 0.003);

  const eyeWhites: Geometry[] = [],
    irises: Geometry[] = [],
    pupils: Geometry[] = [],
    eyeShine: Geometry[] = [],
    lashes: Geometry[] = [],
    brows: Geometry[] = [],
    cheeks: Geometry[] = [];
  for (const side of [-1, 1]) {
    const cx = side * 0.181,
      cy = -0.18;
    const eye = path((s) => {
      s.moveTo(cx - 0.081, cy + 0.073);
      s.bezierCurveTo(cx - 0.04, cy + 0.086, cx + 0.047, cy + 0.084, cx + 0.083, cy + 0.067);
      s.bezierCurveTo(cx + 0.087, cy + 0.012, cx + 0.076, cy - 0.078, cx + 0.026, cy - 0.081);
      s.bezierCurveTo(cx - 0.041, cy - 0.088, cx - 0.08, cy - 0.071, cx - 0.081, cy + 0.073);
    });
    eyeWhites.push(sheet(eye, (x, y) => faceZ(x, y) + 0.0025, 0.001, 1));
    const iris = path((s) => {
      s.moveTo(cx - 0.062, cy + 0.078);
      s.quadraticCurveTo(cx, cy + 0.088, cx + 0.063, cy + 0.074);
      s.bezierCurveTo(cx + 0.072, cy + 0.024, cx + 0.069, cy - 0.066, cx + 0.026, cy - 0.079);
      s.bezierCurveTo(cx - 0.024, cy - 0.092, cx - 0.065, cy - 0.065, cx - 0.065, cy + 0.025);
      s.lineTo(cx - 0.062, cy + 0.078);
    });
    irises.push(
      paint(
        sheet(iris, (x, y) => faceZ(x, y) + 0.004, 0.001, 1),
        '#609fd5',
        '#2d427b',
        cy - 0.079,
        cy + 0.065,
      ),
    );
    pupils.push(
      sheet(ellipse(cx, cy + 0.006, 0.012, 0.027), (x, y) => faceZ(x, y) + 0.0055, 0.0005, 0),
    );
    for (const [x, y, rx, ry] of [
      [cx - 0.02, cy + 0.056, 0.012, 0.013],
      [cx + 0.012, cy + 0.049, 0.005, 0.006],
      [cx + 0.045, cy - 0.063, 0.006, 0.004],
    ])
      eyeShine.push(sheet(ellipse(x, y, rx, ry), (px, py) => faceZ(px, py) + 0.006, 0.0005, 0));
    cheeks.push(
      sheet(ellipse(cx, cy - 0.061, 0.012, 0.01), (x, y) => faceZ(x, y) + 0.0065, 0.0005, 0),
    );
    lashes.push(
      sheet(
        path((s) => {
          s.moveTo(cx - 0.091, cy + 0.065);
          s.quadraticCurveTo(cx - 0.067, cy + 0.104, cx + 0.02, cy + 0.102);
          s.quadraticCurveTo(cx + 0.07, cy + 0.1, cx + 0.091, cy + 0.078);
          s.lineTo(cx + 0.084, cy + 0.051);
          s.quadraticCurveTo(cx + 0.065, cy + 0.081, cx + 0.012, cy + 0.082);
          s.quadraticCurveTo(cx - 0.057, cy + 0.086, cx - 0.091, cy + 0.065);
        }),
        (x, y) => faceZ(x, y) + 0.0075,
        0.001,
        1,
      ),
    );
    const outer = cx + side * 0.076;
    lashes.push(
      sheet(
        path((s) => {
          s.moveTo(outer, cy + 0.073);
          s.lineTo(outer + side * 0.034, cy + 0.094);
          s.lineTo(outer + side * 0.017, cy + 0.06);
          s.lineTo(outer + side * 0.027, cy + 0.055);
          s.lineTo(outer, cy + 0.031);
        }),
        (x, y) => faceZ(x, y) + 0.008,
        0.001,
        1,
      ),
    );
    brows.push(
      stroke(
        [
          [cx - 0.054, cy + 0.135, faceZ(cx - 0.054, cy + 0.135) + 0.003],
          [cx, cy + 0.144, faceZ(cx, cy + 0.144) + 0.003],
          [cx + 0.053, cy + 0.133, faceZ(cx + 0.053, cy + 0.133) + 0.003],
        ],
        0.002,
        12,
        3,
      ),
    );
    cheeks.push(
      sheet(ellipse(side * 0.291, -0.263, 0.032, 0.013), (x, y) => faceZ(x, y) + 0.0025, 0.001, 0),
    );
  }
  combine(head, 'Shallow_anime_eye_whites', eyeWhites, white);
  combine(head, 'Large_sapphire_irises', irises, irisMat);
  combine(head, 'Small_gentle_eye_pupils', pupils, pupil);
  combine(head, 'Painted_eye_catchlights', eyeShine, white);
  combine(head, 'Heavy_nearly_flat_upper_eyelids', lashes, lashInk);
  combine(head, 'Subtle_eyebrows', brows, lip);
  combine(head, 'Soft_blush_patches', cheeks, blush);
  add(
    head,
    'Tiny_neutral_mouth',
    stroke(
      [
        [-0.008, -0.306, faceZ(-0.008, -0.306) + 0.003],
        [0, -0.302, faceZ(0, -0.302) + 0.003],
        [0.008, -0.306, faceZ(0.008, -0.306) + 0.003],
      ],
      0.0017,
      8,
      3,
    ),
    lip,
  );

  const laceParts: Geometry[] = [],
    laceFolds: Geometry[] = [],
    laceSeam: Geometry[] = [];
  laceParts.push(
    new THREE.TorusGeometry(0.513, 0.012, 6, 64, Math.PI)
      .scale(1, 0.91, 1)
      .translate(0, 0.002, -0.053),
  );
  for (let i = 0; i < 15; i++) {
    const a = (i / 14) * Math.PI,
      x = Math.cos(a) * 0.52,
      y = Math.sin(a) * 0.47;
    laceParts.push(
      sheet(
        path((s) => {
          s.moveTo(-0.059, 0);
          s.lineTo(0.059, 0);
          s.bezierCurveTo(0.069, 0.023, 0.049, 0.052, 0.029, 0.049);
          s.bezierCurveTo(0.014, 0.078, -0.018, 0.078, -0.03, 0.048);
          s.bezierCurveTo(-0.053, 0.052, -0.072, 0.022, -0.059, 0);
        }),
        (px) => -0.05 + 0.016 * Math.cos(px * 38),
        0.006,
        0,
      )
        .rotateZ(a - Math.PI / 2)
        .translate(x, y, 0),
    );
    laceFolds.push(
      sheet(
        path((s) => {
          s.moveTo(-0.012, 0.005);
          s.lineTo(0.01, 0.005);
          s.quadraticCurveTo(0.024, 0.046, 0.002, 0.05);
          s.quadraticCurveTo(-0.017, 0.048, -0.012, 0.005);
        }),
        () => -0.03,
        0.001,
        0,
      )
        .rotateZ(a - Math.PI / 2)
        .translate(x, y, 0),
    );
    laceSeam.push(
      stroke(
        [
          [-0.047, 0.019, -0.03],
          [-0.04, 0.037, -0.029],
          [-0.023, 0.035, -0.03],
          [-0.014, 0.059, -0.03],
          [0.012, 0.059, -0.03],
          [0.026, 0.035, -0.03],
          [0.043, 0.035, -0.03],
        ],
        0.0012,
        16,
        3,
      )
        .rotateZ(a - Math.PI / 2)
        .translate(x, y, 0),
    );
  }
  combine(head, 'Thin_scalloped_maid_headdress', laceParts, cream);
  combine(head, 'Headdress_lavender_folds', laceFolds, lavender);
  combine(head, 'Fine_lace_stitching', laceSeam, lavender);
  const fin = path((s) => {
    s.moveTo(0.427, -0.044);
    s.bezierCurveTo(0.496, -0.096, 0.55, -0.181, 0.665, -0.192);
    s.quadraticCurveTo(0.683, -0.225, 0.624, -0.234);
    s.quadraticCurveTo(0.58, -0.266, 0.538, -0.239);
    s.quadraticCurveTo(0.491, -0.264, 0.455, -0.218);
    s.quadraticCurveTo(0.421, -0.182, 0.427, -0.044);
  });
  const underside = path((s) => {
    s.moveTo(0.444, -0.18);
    s.quadraticCurveTo(0.536, -0.24, 0.667, -0.207);
    s.quadraticCurveTo(0.652, -0.258, 0.614, -0.254);
    s.quadraticCurveTo(0.586, -0.285, 0.546, -0.259);
    s.quadraticCurveTo(0.52, -0.289, 0.485, -0.255);
    s.quadraticCurveTo(0.452, -0.254, 0.444, -0.18);
  });
  for (const side of [-1, 1]) {
    add(
      head,
      (side < 0 ? 'Right' : 'Left') + '_dark_blue_side_fin',
      sheet(mirror(fin, side), () => 0.024, 0.031, 1),
      navyFlat,
      0.003,
    );
    add(
      head,
      (side < 0 ? 'Right' : 'Left') + '_thin_white_fin_underside',
      sheet(mirror(underside, side), () => 0.03, 0.006, 1),
      cream,
      0.002,
    );
  }
  combine(head, 'Large_cyan_fin_bow', bowParts(0.465, -0.035, 0.36, 0.75), ribbon, 0.0025);
  add(
    head,
    'Fin_bow_gold_center',
    sphere([0.465, -0.035, 0.389], [0.011, 0.016, 0.008], 10, 6),
    gold,
  );

  const arms: THREE.Group[] = [],
    legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'Right' : 'Left',
      arm = group(name + '_arm_pivot', root, [side * 0.188, 0.794, 0]);
    arms.push(arm);
    add(
      arm,
      name + '_soft_puffed_sleeve',
      sphere([side * 0.046, -0.095, 0.008], [0.093, 0.145, 0.091], 20, 14).rotateZ(side * 0.32),
      navy,
      0.003,
    );
    add(
      arm,
      name + '_navy_cuff',
      new THREE.CylinderGeometry(0.075, 0.08, 0.042, 20)
        .rotateZ(side * 0.36)
        .translate(side * 0.102, -0.21, 0.026),
      navy,
      0.002,
    );
    add(
      arm,
      name + '_cuff_gold_trim',
      new THREE.TorusGeometry(0.077, 0.002, 3, 24)
        .rotateX(Math.PI / 2)
        .rotateZ(side * 0.36)
        .translate(side * 0.102, -0.205, 0.026),
      gold,
    );
    const wrist: Geometry[] = [];
    for (let i = 0; i < 10; i++)
      wrist.push(
        sheet(
          path((s) => {
            s.moveTo(-0.026, 0.01);
            s.lineTo(0.026, 0.01);
            s.quadraticCurveTo(0.031, -0.021, 0, -0.025);
            s.quadraticCurveTo(-0.031, -0.021, -0.026, 0.01);
          }),
          () => 0.073,
          0.004,
          0,
        )
          .rotateY((i / 10) * Math.PI * 2)
          .rotateZ(side * 0.36)
          .translate(side * 0.108, -0.237, 0.026),
      );
    combine(arm, name + '_thin_cuff_lace', wrist, cream);
    const hand = add(
      arm,
      name + '_hand',
      sphere([side * 0.12, -0.269, 0.04], [0.051, 0.06, 0.05], 18, 12),
      skin,
      0.002,
    );
    hand.geometry.translate(-side * 0.12, 0.269, -0.04);
    hand.position.set(side * 0.12, -0.269, 0.04);
    add(
      arm,
      name + '_thumb',
      sphere([side * 0.084, -0.263, 0.069], [0.021, 0.032, 0.024], 12, 8),
      skin,
    );
    const leg = group(name + '_leg_pivot', root, [side * 0.115, 0.245, 0]);
    legs.push(leg);
    add(
      leg,
      name + '_short_stocking',
      sphere([0, -0.099, 0], [0.067, 0.118, 0.058], 20, 12),
      cream,
    );
    add(
      leg,
      name + '_Mary_Jane_shoe',
      sphere([0, -0.1885, 0.023], [0.078, 0.054, 0.108], 24, 14),
      navy,
      0.002,
    );
    add(
      leg,
      name + '_shoe_white_inset',
      sheet(ellipse(0, -0.157, 0.06, 0.026), () => 0.099, 0.002, 1),
      cream,
    );
    add(
      leg,
      name + '_Mary_Jane_strap',
      sheet(
        path((s) => {
          s.moveTo(-0.067, -0.148);
          s.quadraticCurveTo(0, -0.169, 0.067, -0.148);
          s.lineTo(0.067, -0.163);
          s.quadraticCurveTo(0, -0.184, -0.067, -0.163);
        }),
        () => 0.106,
        0.005,
        1,
      ),
      navyFlat,
      0.001,
    );
    add(
      leg,
      name + '_gold_shoe_button',
      sphere([side * 0.057, -0.159, 0.112], [0.006, 0.008, 0.002], 10, 6),
      gold,
    );
  }
  const tail = group('Tail_pivot_omitted_by_request', root, [0, 0.4, -0.2]);
  for (const [parent, parts] of outlineParts)
    combine(parent, parent.name + '_drawn_contour', parts, ink);
  root.updateMatrixWorld(true);
  let disposed = false;
  return {
    root,
    joints: {
      head,
      hair,
      leftArm: arms[1],
      rightArm: arms[0],
      leftLeg: legs[1],
      rightLeg: legs[0],
      tail,
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      for (const material of materials) material.dispose();
    },
  };
}
