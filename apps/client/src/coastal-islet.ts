import type { GroundPoint } from './island-motion';

export const coastLanding: GroundPoint = [0, 7.45];

// The boardwalk runs out from the promenade, turns around the pools, then reaches the bluff.
export const coastBoardwalk = {
  width: 1.18,
  rise: 0.14,
  rampLength: 1.18,
  junctionZ: 5.92,
  lookoutX: 1.45,
  lookoutZ: 8.1,
};

const { width, rise, rampLength, junctionZ, lookoutX, lookoutZ } = coastBoardwalk;
const halfPath = 0.26;
const corners: GroundPoint[] = [
  [0, junctionZ],
  [lookoutX, junctionZ],
];

function coastToWorld([x, z]: GroundPoint): GroundPoint {
  return [coastLanding[0] + x, coastLanding[1] + z];
}

export const coastLookout = coastToWorld([lookoutX, lookoutZ]);
export const coastView = {
  target: [0, 0.46, 12.55],
  offset: [8.9, 8.2, 9.4],
} as const;

function coastSegment([worldX, worldZ]: GroundPoint) {
  const x = worldX - coastLanding[0];
  const z = worldZ - coastLanding[1];
  if (Math.abs(x) <= halfPath && z >= 0 && z <= junctionZ + halfPath) return 0;
  if (x >= -halfPath && x <= lookoutX + halfPath && Math.abs(z - junctionZ) <= halfPath) return 1;
  if (Math.abs(x - lookoutX) <= halfPath && z >= junctionZ - halfPath && z <= lookoutZ + halfPath)
    return 2;
  return -1;
}

export function onCoastPath(point: GroundPoint) {
  return coastSegment(point) >= 0;
}

export function nearCoastApproach(x: number, z: number, clearance = 0) {
  return (
    Math.abs(x - coastLanding[0]) < width / 2 + clearance &&
    z >= coastLanding[1] - 0.12 - clearance &&
    z <= coastLanding[1] + 2.2 + clearance
  );
}

export function coastDeckHeight(localZ: number) {
  return rise * Math.max(0, Math.min(1, localZ / rampLength));
}

export function coastWalkingHeight(point: GroundPoint) {
  return onCoastPath(point) ? coastDeckHeight(point[1] - coastLanding[1]) : 0;
}

export function coastRoute(start: GroundPoint, end: GroundPoint): GroundPoint[] {
  const from = coastSegment(start);
  const to = coastSegment(end);
  if (from < 0 || to < 0) return [];
  const turns = corners.slice(Math.min(from, to), Math.max(from, to));
  if (from > to) turns.reverse();
  const route = turns.map(coastToWorld).filter(([x, z]) => x !== start[0] || z !== start[1]);
  if (route.at(-1)?.[0] === end[0] && route.at(-1)?.[1] === end[1]) return route;
  return [...route, [...end]];
}
