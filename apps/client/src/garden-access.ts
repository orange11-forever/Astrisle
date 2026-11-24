import { harborBridge, harborToWorld } from './harbor-layout';
import type { GroundPoint } from './island-motion';

export const glasshousePosition: [number, number, number] = [-8.8, 0, 6.6];
export const glasshouseYaw = Math.atan2(-glasshousePosition[0], -glasshousePosition[2]);
// Leave headroom for the 1.85-unit imported character above the raised floor.
export const glasshouseVerticalScale = 1.2;

const sin = Math.sin(glasshouseYaw);
const cos = Math.cos(glasshouseYaw);

export function nurseryToWorld(x: number, z: number): GroundPoint {
  return [glasshousePosition[0] + cos * x + sin * z, glasshousePosition[2] - sin * x + cos * z];
}

function nurseryLocal(point: GroundPoint): GroundPoint {
  const dx = point[0] - glasshousePosition[0];
  const dz = point[1] - glasshousePosition[2];
  return [cos * dx - sin * dz, sin * dx + cos * dz];
}

export const nurseryCrossingZ = 1.82;
export const nurseryDeck = {
  left: 0.47,
  right: 3.5,
  rear: nurseryCrossingZ - 0.96,
  front: nurseryCrossingZ + 0.84,
};
export function nearNurseryDeck(point: GroundPoint, clearance: number) {
  const [x, z] = nurseryLocal(point);
  return (
    x >= nurseryDeck.left - clearance &&
    x <= nurseryDeck.right + clearance &&
    z >= nurseryDeck.rear - clearance &&
    z <= nurseryDeck.front + clearance
  );
}
export const nurseryLanding = nurseryToWorld(0, 3.15);
export const nurseryBed = nurseryToWorld(2.08, nurseryCrossingZ);
export const glasshouseAisle = nurseryToWorld(0, -0.21);

export function onNurseryPath(point: GroundPoint) {
  const [x, z] = nurseryLocal(point);
  return (
    (Math.abs(x) <= 0.23 && z >= -0.43 && z < 3.74) ||
    (x >= -0.23 && x <= 2.45 && Math.abs(z - nurseryCrossingZ) <= 0.23)
  );
}

export function nurseryWalkingHeight(point: GroundPoint) {
  if (!onNurseryPath(point)) return 0;
  const [x, z] = nurseryLocal(point);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const stone = 0.06 * clamp((2.62 - z) / 0.32) + 0.1 * clamp((1.19 - z) / 0.32);
  return glasshouseVerticalScale * (stone + (0.12 - stone) * clamp((x - 0.18) / 0.55));
}

export function nurseryRoute(start: GroundPoint, end: GroundPoint): GroundPoint[] {
  const [sx] = nurseryLocal(start);
  const [ex] = nurseryLocal(end);
  const crossing = nurseryToWorld(0, nurseryCrossingZ);
  return sx > 0.23 === ex > 0.23 ? [[...end]] : [crossing, [...end]];
}

export const gardenApproaches = [
  {
    start: harborToWorld([harborBridge.x, harborBridge.gardenEnd]),
    end: harborToWorld([harborBridge.x, harborBridge.gardenEnd + 0.72]),
    width: harborBridge.width,
  },
  { start: nurseryToWorld(0, 2.52), end: nurseryToWorld(0, 3.72), width: 1.16 },
];

export function nearGardenApproach(x: number, z: number, clearance: number) {
  return gardenApproaches.some(({ start, end, width }) => {
    const dx = end[0] - start[0],
      dz = end[1] - start[1];
    const t = Math.max(
      0,
      Math.min(1, ((x - start[0]) * dx + (z - start[1]) * dz) / (dx * dx + dz * dz)),
    );
    return Math.hypot(x - start[0] - t * dx, z - start[1] - t * dz) < width / 2 + clearance;
  });
}
