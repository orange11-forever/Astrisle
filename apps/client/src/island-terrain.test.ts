import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { ISLAND_RADIUS, PROMENADE_RADIUS, isWalkable } from './island-motion';
import { POND_CENTER, POND_WATER_LEVEL, pondWorldRing } from './island-pond';
import { createIslandTerrain, shoreRadius } from './island-terrain';
import { islandAppearance } from './islands';

describe('island terrain', () => {
  const palette = islandAppearance('working-island');

  it('preserves level ground across the full navigation area', () => {
    const geometry = createIslandTerrain(palette);
    const material = new MeshBasicMaterial();
    const terrain = new Mesh(geometry, material);
    const ray = new Raycaster();
    for (let index = 0; index < 32; index++) {
      const angle = (index * Math.PI) / 16;
      const radius = ISLAND_RADIUS - 0.65;
      const point: [number, number] = [Math.cos(angle) * radius, Math.sin(angle) * radius];
      if (!isWalkable(point)) continue;
      ray.set(new Vector3(point[0], 3, point[1]), new Vector3(0, -1, 0));
      expect(ray.intersectObject(terrain)[0]?.point.y).toBeCloseTo(-0.025);
    }
    material.dispose();
    geometry.dispose();
  });

  it('recesses the pond floor under the water and preserves the promenade clearance', () => {
    const geometry = createIslandTerrain(palette);
    const material = new MeshBasicMaterial();
    const terrain = new Mesh(geometry, material);
    const ray = new Raycaster(
      new Vector3(POND_CENTER[0], 2, POND_CENTER[2]),
      new Vector3(0, -1, 0),
    );
    expect(ray.intersectObject(terrain)[0]!.point.y).toBeLessThan(POND_WATER_LEVEL - 0.16);
    for (const [x, , z] of pondWorldRing(1, 0)) {
      expect(Math.hypot(x, z)).toBeGreaterThan(PROMENADE_RADIUS + 0.64);
      expect(isWalkable([x, z])).toBe(false);
    }
    material.dispose();
    geometry.dispose();
  });

  it('joins the turf, cliff, and underside into one closed outward-facing surface', () => {
    const geometry = createIslandTerrain(palette);
    const position = geometry.getAttribute('position');
    const edges = new Map<string, { count: number; direction: number }>();
    const corners = [new Vector3(), new Vector3(), new Vector3()] as const;
    const firstSide = new Vector3();
    const secondSide = new Vector3();
    let signedVolume = 0;
    for (let index = 0; index < position.count; index += 3) {
      corners.forEach((corner, offset) => corner.fromBufferAttribute(position, index + offset));
      const [first, second, third] = corners;
      firstSide.subVectors(second, first).cross(secondSide.subVectors(third, first));
      expect(firstSide.lengthSq()).toBeGreaterThan(0);
      signedVolume += first.dot(firstSide) / 6;

      const keys = corners.map((corner) => corner.toArray().join(','));
      for (let corner = 0; corner < 3; corner++) {
        const a = keys[corner]!;
        const b = keys[(corner + 1) % 3]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const edge = edges.get(key) ?? { count: 0, direction: 0 };
        edge.count++;
        edge.direction += a < b ? 1 : -1;
        edges.set(key, edge);
      }
    }
    expect(
      [...edges.values()].every(({ count, direction }) => count === 2 && direction === 0),
    ).toBe(true);
    expect(signedVolume).toBeGreaterThan(0);
    expect(geometry.getAttribute('color').count).toBe(position.count);
    expect(position.count).toBeLessThan(8300);
    geometry.dispose();
  });

  it('keeps a variable shore outside the paths in every workspace orientation', () => {
    for (let orientation = 0; orientation < 16; orientation++) {
      const rotation = (orientation * Math.PI) / 8;
      const radii = Array.from({ length: 96 }, (_, index) =>
        shoreRadius((index * Math.PI) / 48, rotation),
      );
      expect(Math.min(...radii)).toBeGreaterThan(8.75);
      expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.4);
    }
  });
});
