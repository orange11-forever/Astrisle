import { harborBridge, harborToWorld } from './harbor-layout';
import type { GroundPoint } from './island-motion';

export const glasshousePosition: [number, number, number] = [-8.8, 0, 6.6];
export const glasshouseYaw = Math.atan2(-glasshousePosition[0], -glasshousePosition[2]);

function glasshousePath(distance: number): GroundPoint {
  return [
    glasshousePosition[0] + Math.sin(glasshouseYaw) * distance,
    glasshousePosition[2] + Math.cos(glasshouseYaw) * distance,
  ];
}

export const gardenApproaches = [
  {
    start: harborToWorld([harborBridge.x, harborBridge.gardenEnd]),
    end: harborToWorld([harborBridge.x, harborBridge.gardenEnd + 0.72]),
    width: harborBridge.width,
  },
  { start: glasshousePath(2.52), end: glasshousePath(3.72), width: 1.16 },
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
