import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { PROMENADE_RADIUS } from './island-motion';
import {
  OBSERVATORY,
  observatoryApproachPose,
  observatoryTargetHeight,
  onObservatoryApproach,
} from './island-observatory';

describe('observatory visit', () => {
  it('links the promenade to the deck through the rail opening', () => {
    const { x, width, startZ, endZ } = OBSERVATORY.boardwalk;
    expect(Math.hypot(x, startZ)).toBeLessThan(PROMENADE_RADIUS + 0.2);
    expect(onObservatoryApproach(x, -Math.sqrt(7.73 ** 2 - x ** 2))).toBe(true);
    expect(onObservatoryApproach(x + width, startZ)).toBe(false);
    expect(endZ).toBeLessThanOrEqual(OBSERVATORY.deck.entryZ);
    expect(x - width / 2).toBeGreaterThan(OBSERVATORY.deck.left);
    expect(x + width / 2).toBeLessThan(OBSERVATORY.deck.right);
  });

  it.each([2.1, 1.4, 0.8, 0.5])('approaches the deck with sky overhead at aspect %s', (aspect) => {
    const start = observatoryApproachPose(aspect, 0);
    const midway = observatoryApproachPose(aspect, 0.5);
    const arrival = observatoryApproachPose(aspect, 1);
    expect(midway.position[2]).toBeLessThan(start.position[2]);
    expect(arrival.position[2]).toBeLessThan(midway.position[2]);
    expect(arrival.position[2]).toBeLessThan(OBSERVATORY.deck.entryZ);
    expect(arrival.position[1]).toBeGreaterThan(OBSERVATORY.deck.height);
    expect(arrival.target[2]).toBeLessThan(OBSERVATORY.deck.farZ);
    expect(arrival.target[1]).toBeGreaterThan(arrival.position[1]);

    const camera = new PerspectiveCamera(OBSERVATORY.fieldOfView, aspect);
    camera.position.set(...arrival.position);
    camera.lookAt(...arrival.target);
    camera.updateMatrixWorld();
    const tube = new Vector3(
      OBSERVATORY.telescope[0],
      OBSERVATORY.deck.height + 1.02,
      OBSERVATORY.telescope[1],
    ).project(camera);
    expect(Math.abs(tube.x)).toBeLessThan(0.95);
    expect(Math.abs(tube.y)).toBeLessThan(0.85);
    const eyepiece = new Vector3(
      OBSERVATORY.telescope[0] - 0.14,
      OBSERVATORY.deck.height + 0.64,
      OBSERVATORY.telescope[1] + 0.61,
    ).project(camera);
    expect(Math.abs(eyepiece.x)).toBeLessThan(0.9);

    const skyRay = new Vector3(arrival.target[0] - arrival.position[0], 0, -3).normalize();
    skyRay.y = Math.tan((26 * Math.PI) / 180);
    const sky = skyRay.multiplyScalar(100).add(camera.position).project(camera);
    expect(sky.y).toBeGreaterThan(0.55);
    expect(sky.y).toBeLessThan(0.93);
  });

  it('preserves skyward pitch when the orbit is raised above the ground', () => {
    const targetY = observatoryTargetHeight(0.4, 3, 1.24);
    expect(targetY - OBSERVATORY.eyeFloor).toBeCloseTo(3 - 0.4);
    expect(observatoryTargetHeight(3.7, targetY, 1.24)).toBe(1.24);
  });
});
