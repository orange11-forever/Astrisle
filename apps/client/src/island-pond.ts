import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  IcosahedronGeometry,
  PlaneGeometry,
} from 'three';

type Point = [number, number, number];

export const POND_CENTER: Point = [6.65, 0, 4.88];
export const POND_BEARING = Math.atan2(POND_CENTER[0], POND_CENTER[2]);
export const POND_WATER_LEVEL = -0.112;
export const POND_WATER_RADIUS = 0.815;
const perimeterSegments = 44;

export function pondPoint(angle: number, scale: number, height: number): Point {
  const outline = 1 + Math.sin(angle * 3 + 0.32) * 0.067 + Math.cos(angle * 5 + 0.44) * 0.038;
  const x = Math.cos(angle) * 1.35 * outline;
  const z = Math.sin(angle) * 0.393 * outline + Math.cos(angle * 2) * 0.047;
  return [x * scale, height, z * scale];
}

export function pondWorldRing(scale: number, height: number): Point[] {
  const cos = Math.cos(POND_BEARING);
  const sin = Math.sin(POND_BEARING);
  return Array.from({ length: perimeterSegments }, (_, i) => {
    const [x, y, z] = pondPoint((i * Math.PI * 2) / perimeterSegments, scale, height);
    return [POND_CENTER[0] + cos * x + sin * z, y, POND_CENTER[2] - sin * x + cos * z];
  });
}

export function createPondLeaf(length: number, width: number, bend: number) {
  const geometry = new PlaneGeometry(1, 1, 2, 5);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const side = positions.getX(i);
    const growth = positions.getY(i) + 0.5;
    const span = (0.13 * (1 - growth) + Math.sin(Math.PI * growth) * 0.87 + 0.005) * width;
    positions.setXYZ(
      i,
      side * span,
      growth * length * (1 - bend * growth * 0.31),
      bend * length * growth ** 2 - Math.abs(side) * span * 0.22,
    );
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function createPondPetal(length: number, width: number, cup: number) {
  const geometry = new PlaneGeometry(1, 1, 2, 5);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const side = positions.getX(i);
    const growth = positions.getY(i) + 0.5;
    const span = Math.sin(Math.PI * growth) ** 0.72 + 0.015;
    positions.setXYZ(
      i,
      side * width * span,
      Math.sin(Math.PI * growth) * 0.021 + growth ** 2 * cup + Math.abs(side) * span * 0.008,
      -growth * length,
    );
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function createPondStone(phase: number) {
  const geometry = new IcosahedronGeometry(1, 1);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const surface = 1 + Math.sin(x * 4.1 + z * 3.4 + phase) * 0.12;
    positions.setXYZ(i, x * surface, Math.min(0.72, y) * surface, z * surface);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function coloredGeometry(vertices: number[], colors: number[], indices: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function createPondWater(tint: string) {
  const deep = new Color('#183b4a').lerp(new Color(tint), 0.17);
  const shallow = new Color('#579986').lerp(new Color(tint), 0.36);
  const color = new Color();
  const vertices = [0, POND_WATER_LEVEL, 0];
  const colors = [deep.r, deep.g, deep.b, 0.96];
  const indices: number[] = [];
  const waterRings = [0.27, 0.48, 0.66, POND_WATER_RADIUS + 0.007];
  waterRings.forEach((scale, ring) => {
    const first = 1 + ring * perimeterSegments;
    for (let i = 0; i < perimeterSegments; i++) {
      const angle = (i * Math.PI * 2) / perimeterSegments;
      const edge = (scale / POND_WATER_RADIUS) ** 2;
      color
        .copy(deep)
        .lerp(shallow, edge * 0.91)
        .multiplyScalar(1 + Math.sin(angle * 3 + scale * 4) * edge * 0.093);
      vertices.push(...pondPoint(angle, scale, POND_WATER_LEVEL));
      colors.push(color.r, color.g, color.b, 0.96 - edge * 0.2);
      const current = first + i;
      const next = first + ((i + 1) % perimeterSegments);
      if (ring === 0) indices.push(0, next, current);
      else {
        const inner = current - perimeterSegments;
        const innerNext = next - perimeterSegments;
        indices.push(inner, innerNext, current, innerNext, next, current);
      }
    }
  });
  return coloredGeometry(vertices, colors, indices);
}

export function createPondRipples() {
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new Color('#b9e0df');
  const segments = 25;
  // Incomplete reflection arcs with feathered edges and a narrower crest.
  const ripples = [
    { x: -0.26, z: -0.045, radius: 0.29, start: 0.28, sweep: 2.38, width: 0.027, opacity: 0.48 },
    { x: -0.26, z: -0.045, radius: 0.38, start: 0.32, sweep: 2.04, width: 0.025, opacity: 0.33 },
    { x: 0.26, z: -0.092, radius: 0.33, start: 3.45, sweep: 1.8, width: 0.016, opacity: 0.38 },
    { x: 0.58, z: 0.009, radius: 0.24, start: 0.05, sweep: 2.39, width: 0.017, opacity: 0.37 },
  ];
  for (const { x, z, radius, start, sweep, width, opacity } of ripples) {
    const first = vertices.length / 3;
    for (let i = 0; i <= segments; i++) {
      const progress = i / segments;
      const angle = start + progress * sweep;
      const taper = Math.sin(progress * Math.PI);
      for (const offset of [-1, 0, 1]) {
        const distance = radius + offset * width * (0.24 + taper * 0.76);
        vertices.push(
          x + Math.cos(angle) * distance,
          POND_WATER_LEVEL + 0.002,
          z + Math.sin(angle) * distance * 0.42,
        );
        colors.push(color.r, color.g, color.b, offset === 0 ? opacity * taper ** 0.55 : 0);
      }
      if (i === 0) continue;
      const a = first + (i - 1) * 3;
      indices.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
    }
  }
  return coloredGeometry(vertices, colors, indices);
}
