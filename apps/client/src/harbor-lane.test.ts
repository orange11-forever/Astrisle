import { describe, expect, it } from 'vitest';
import { laneLanding, laneQuay, laneRoute, laneWalkingHeight, onLanePath } from './harbor-lane';
import { harborStreetHeight, harborToWorld, onHarborStreet, worldToHarbor } from './harbor-layout';
import type { GroundPoint } from './island-motion';

function expectContinuousRoute(start: GroundPoint, end: GroundPoint) {
  const route = laneRoute(start, end);
  expect(route.at(-1)).toEqual(end);
  for (const [index, target] of route.entries()) {
    const from = index ? route[index - 1]! : start;
    const steps = Math.ceil(Math.hypot(target[0] - from[0], target[1] - from[1]) / 0.04);
    expect(steps).toBeGreaterThan(0);
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const sample: GroundPoint = [
        from[0] + (target[0] - from[0]) * t,
        from[1] + (target[1] - from[1]) * t,
      ];
      expect(onLanePath(sample)).toBe(true);
      expect(laneWalkingHeight(sample)).toBe(harborStreetHeight);
    }
  }
}

describe('sailmaker lane and work quay', () => {
  it('meets the existing street and follows the dry lane onto the dock in both directions', () => {
    expect(onHarborStreet(worldToHarbor(laneLanding))).toBe(true);
    expect(onHarborStreet(worldToHarbor(laneQuay))).toBe(false);
    expect(laneRoute(laneLanding, laneQuay)).toHaveLength(4);
    expectContinuousRoute(laneLanding, laneQuay);
    expectContinuousRoute(laneQuay, laneLanding);
  });

  it('joins the lane from off-centre points and handles interrupted turns', () => {
    expectContinuousRoute(harborToWorld([9.06, 1.71]), harborToWorld([11.48, 3.31]));
    expectContinuousRoute(harborToWorld([11.49, 0.48]), harborToWorld([10.11, 0.21]));
    expectContinuousRoute(harborToWorld([11.52, 4.32]), harborToWorld([11.3, 3.12]));
    expect(laneRoute(laneLanding, laneLanding)).toEqual([laneLanding]);
  });

  it('excludes the dispatch counter, work yard, side of the dock and open water', () => {
    for (const point of [
      harborToWorld([6.83, 0.93]),
      harborToWorld([10.25, 1.79]),
      harborToWorld([10.65, 4.25]),
      harborToWorld([11.36, 4.95]),
      [NaN, Infinity] satisfies GroundPoint,
    ]) {
      expect(onLanePath(point)).toBe(false);
      expect(laneWalkingHeight(point)).toBe(0);
      expect(laneRoute(laneLanding, point)).toEqual([]);
      expect(laneRoute(point, laneQuay)).toEqual([]);
    }
  });
});
