import type { GroundPoint } from './island-motion';

export const OBSERVATORY = {
  boardwalk: { x: 4.92, width: 1.38, startZ: -4.97, endZ: -6.12 },
  deck: { left: 3.42, right: 6.42, entryZ: -6.1, farZ: -9.38, height: 0.14 },
  telescope: [4.2, -8.23] as GroundPoint,
  fieldOfView: 56,
  eyeFloor: 0.79,
};

export function onObservatoryApproach(x: number, z: number, margin = 0) {
  const { x: centerX, width, startZ, endZ } = OBSERVATORY.boardwalk;
  return Math.abs(x - centerX) <= width / 2 + margin && z <= startZ + margin && z >= endZ - margin;
}

export function observatoryApproachPose(aspect: number, progress: number) {
  const narrow = Math.max(0, Math.min(1, (1.48 - aspect) / 0.98));
  const travel = progress * progress * (3 - 2 * progress);
  return {
    position: [4.98 - 0.62 * narrow, 1.29 - 0.47 * travel, -4.76 - 1.46 * travel],
    target: [4.42 - 0.07 * narrow, 0.95 + 0.29 * travel, -10.14],
  } as const;
}

export function observatoryTargetHeight(eyeY: number, targetY: number, restY: number) {
  // Lift the target and camera together so the camera can pitch toward the sky from ground level.
  return Math.max(restY, targetY + OBSERVATORY.eyeFloor - eyeY);
}
