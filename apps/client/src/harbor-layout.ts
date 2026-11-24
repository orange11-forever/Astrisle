import type { GroundPoint } from './island-motion';

export const harborOrigin: [number, number, number] = [-5.75, 0, -12.7];
export const harborYaw = 0.25;
const sin = Math.sin(harborYaw);
const cos = Math.cos(harborYaw);
export const harborBridge = {
  x: 1,
  width: 1.37,
  quayEnd: 2.89,
  gardenEnd: 6.05,
  deckHeight: 0.0735,
};
export const harborStreetZ = 1.94;
export const harborStreetHeight = 0.026;
const landingZ = 6.55;
export const harborGardenLanding = harborToWorld([harborBridge.x, landingZ]);

export const harborStops = {
  market: {
    name: '看花市',
    point: harborToWorld([-4.87, harborStreetZ]),
    yaw: Math.PI + harborYaw,
  },
  mooring: { name: '看帆船', point: harborToWorld([3.84, harborStreetZ]), yaw: harborYaw },
};
export type HarborStop = keyof typeof harborStops;

export function harborToWorld([x, z]: GroundPoint): GroundPoint {
  return [harborOrigin[0] + x * cos + z * sin, harborOrigin[2] - x * sin + z * cos];
}

export function worldToHarbor([x, z]: GroundPoint): GroundPoint {
  const dx = x - harborOrigin[0];
  const dz = z - harborOrigin[2];
  return [dx * cos - dz * sin, dx * sin + dz * cos];
}

export function onHarborStreet([x, z]: GroundPoint) {
  return x >= -6.15 && x <= 6.45 && Math.abs(z - harborStreetZ) <= 0.13;
}

export function onHarborBridge([x, z]: GroundPoint) {
  return Math.abs(x - harborBridge.x) <= 0.21 && z >= harborStreetZ - 0.03 && z <= landingZ + 0.002;
}

const railHalfWidth = 0.91;
const railStart = 4.85;
const railEnd = harborBridge.gardenEnd + 0.23;

export function atHarborRail([x, z]: GroundPoint) {
  return Math.abs(x - harborBridge.x) < railHalfWidth && z >= railStart && z <= railEnd;
}

/** Clip the segment to the rail's Z range, then test its remaining X span. */
export function crossesHarborRail(a: GroundPoint, b: GroundPoint) {
  const [x, z] = worldToHarbor(a);
  const [endX, endZ] = worldToHarbor(b);
  if (Math.max(z, endZ) < railStart || Math.min(z, endZ) > railEnd) return false;
  const dz = endZ - z;
  const enter = dz ? Math.max(0, Math.min((railStart - z) / dz, (railEnd - z) / dz)) : 0;
  const exit = dz ? Math.min(1, Math.max((railStart - z) / dz, (railEnd - z) / dz)) : 1;
  const firstX = x + enter * (endX - x);
  const lastX = x + exit * (endX - x);
  return (
    Math.min(firstX, lastX) < harborBridge.x + railHalfWidth &&
    Math.max(firstX, lastX) > harborBridge.x - railHalfWidth
  );
}

export function harborWalkingHeight(point: GroundPoint) {
  const local = worldToHarbor(point);
  if (onHarborStreet(local)) return harborStreetHeight;
  if (!onHarborBridge(local)) return 0;
  const z = local[1];
  const quayRise = harborBridge.quayEnd + 0.02;
  if (z <= quayRise)
    return (
      harborStreetHeight +
      (harborBridge.deckHeight - harborStreetHeight) * clamp(1 + (z - quayRise) / 0.22)
    );
  return harborBridge.deckHeight * clamp((harborBridge.gardenEnd + 0.16 - z) / 0.22);
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}
