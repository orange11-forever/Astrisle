import { harborStreetHeight, harborStreetZ, harborToWorld, worldToHarbor } from './harbor-layout';
import type { GroundPoint } from './island-motion';

export const laneCenterline = [
  [6.38, harborStreetZ],
  [9.2, harborStreetZ],
  [9.2, 0.34],
  [11.36, 0.34],
  [11.36, 4.25],
] satisfies [GroundPoint, GroundPoint, GroundPoint, GroundPoint, GroundPoint];
export const laneLanding = harborToWorld(laneCenterline[0]);
export const laneQuay = harborToWorld(laneCenterline[4]);

// The corridor holds the companion's center well inside the pavers and pier rails.
const clearance = 0.19 + 1e-7;
const laneSegments = laneCenterline.slice(1).map(([x, z], index) => {
  const [startX, startZ] = laneCenterline[index]!;
  return {
    left: Math.min(x, startX) - clearance,
    right: Math.max(x, startX) + clearance,
    back: Math.min(z, startZ) - clearance,
    front: Math.max(z, startZ) + clearance,
  };
});

function laneSegmentIndex(point: GroundPoint) {
  const [x, z] = worldToHarbor(point);
  return laneSegments.findIndex(
    ({ left, right, back, front }) => x >= left && x <= right && z >= back && z <= front,
  );
}

export function onLanePath(point: GroundPoint) {
  return laneSegmentIndex(point) >= 0;
}

export function laneWalkingHeight(point: GroundPoint) {
  return onLanePath(point) ? harborStreetHeight : 0;
}

/** Each corridor is convex and neighboring corridors meet at a centerline corner. */
export function laneRoute(start: GroundPoint, end: GroundPoint): GroundPoint[] {
  const from = laneSegmentIndex(start);
  const to = laneSegmentIndex(end);
  if (from < 0 || to < 0) return [];
  const corners = laneCenterline.slice(Math.min(from, to) + 1, Math.max(from, to) + 1);
  if (from > to) corners.reverse();
  const route = corners
    .map(harborToWorld)
    .filter((point) => !near(start, point) && !near(end, point));
  return [...route, [...end]];
}

function near(a: GroundPoint, b: GroundPoint) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
}

const [lookX, lookZ] = harborToWorld([10.76, 2.25]);
const [eyeX, eyeZ] = harborToWorld([15.53, 9.93]);
export const laneView = {
  target: [lookX, 0.82, lookZ],
  offset: [eyeX - lookX, 5.35, eyeZ - lookZ],
} satisfies { target: [number, number, number]; offset: [number, number, number] };
