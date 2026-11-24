import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from 'three';
import { expect, it } from 'vitest';
import { createCoastalSurfaces } from './CoastalIslet';
import {
  coastLanding,
  coastLookout,
  coastRoute,
  coastWalkingHeight,
  nearCoastApproach,
  onCoastPath,
} from './coastal-islet';
import type { GroundPoint } from './island-motion';
import type { IslandPropSurface } from './IslandPropGeometry';

function coastalMesh({ position, index }: IslandPropSurface) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  return new Mesh(geometry, new MeshBasicMaterial());
}

it('routes across the bridge and around the corners of the coastal boardwalk in both directions', () => {
  const bridgeEdge: GroundPoint = [-0.21, 10.1];
  const farSide: GroundPoint = [1.66, 15.23];
  for (const [start, end] of [
    [coastLanding, coastLookout],
    [coastLookout, coastLanding],
    [bridgeEdge, farSide],
    [farSide, bridgeEdge],
  ]) {
    const route = coastRoute(start, end);
    expect(route.length).toBeGreaterThan(1);
    expect(route.at(-1)).toEqual(end);
    let previous = start;
    for (const point of route) {
      for (let step = 0; step <= 24; step++) {
        const fraction = step / 24;
        const between: GroundPoint = [
          previous[0] + (point[0] - previous[0]) * fraction,
          previous[1] + (point[1] - previous[1]) * fraction,
        ];
        expect(onCoastPath(between), `${between} between ${previous} and ${point}`).toBe(true);
      }
      previous = point;
    }
  }
});

it('keeps the route away from open sky, the tidal pools and the far cliff edge', () => {
  for (const point of [
    [0.8, 10.12],
    [-1.54, 13.68],
    [1.45, 16.5],
    [NaN, 12],
  ] as GroundPoint[]) {
    expect(onCoastPath(point)).toBe(false);
    expect(coastRoute(coastLanding, point)).toEqual([]);
    expect(coastRoute(point, coastLookout)).toEqual([]);
  }
});

it('reserves both shoulders of the promenade approach for the bridge entrance', () => {
  expect(nearCoastApproach(0.62, 8.8, 0.1)).toBe(true);
  expect(nearCoastApproach(-1.2, 8.8, 0.1)).toBe(false);
  expect(nearCoastApproach(0, 13)).toBe(false);
});

it('places coastal feet on the rendered surface from the main island up to the lookout', () => {
  const { structure } = createCoastalSurfaces();
  const mesh = coastalMesh(structure);
  const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
  try {
    const points: GroundPoint[] = [
      [0, 7.65],
      [0.17, 8.15],
      [0, 9.9],
      [0, 12.9],
      [0.91, 13.37],
      coastLookout,
    ];
    expect(coastWalkingHeight(coastLanding)).toBe(0);
    expect(coastWalkingHeight(points[0]!)).toBeGreaterThan(0);
    expect(coastWalkingHeight(points[0]!)).toBeLessThan(coastWalkingHeight(coastLookout));
    for (const point of points) {
      ray.ray.origin.set(point[0], 4, point[1] - coastLanding[1]);
      const contact = ray.intersectObject(mesh)[0];
      expect(contact?.point.y, `deck at ${point}`).toBeCloseTo(coastWalkingHeight(point), 2);
    }
  } finally {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});

it('sets all three water surfaces above their basin floors and below the surrounding rock', () => {
  const surfaces = createCoastalSurfaces();
  const rock = coastalMesh(surfaces.structure);
  const water = coastalMesh(surfaces.water);
  const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
  try {
    for (const [x, z] of [
      [-1.37, 5.31],
      [-0.89, 7.16],
      [-2.2, 7.71],
    ]) {
      ray.ray.origin.set(x, 4, z);
      const surface = ray.intersectObject(water)[0];
      const floor = ray.intersectObject(rock)[0];
      expect(surface?.point.y).toBeCloseTo(-0.206, 2);
      expect(floor?.point.y).toBeLessThan(surface!.point.y);
    }
    ray.ray.origin.set(0.52, 4, 7.03);
    expect(ray.intersectObject(water)).toHaveLength(0);
    expect(ray.intersectObject(rock)[0]?.point.y).toBeGreaterThan(-0.1);
  } finally {
    for (const mesh of [rock, water]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
});
