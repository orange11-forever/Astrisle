import { expect, it } from 'vitest';
import {
  findIslandRoute,
  isWalkable,
  segmentIsWalkable,
  createWalker,
  advanceWalker,
} from './island-motion';

it('routes around the central table and desks while remaining on the island', () => {
  const from: [number, number] = [-3.45, 1.2],
    to: [number, number] = [3.45, 1.2];
  const route = findIslandRoute(from, to);
  expect(route.length).toBeGreaterThan(0);
  let previous = from;
  for (const point of route) {
    expect(isWalkable(point)).toBe(true);
    expect(segmentIsWalkable(previous, point)).toBe(true);
    previous = point;
  }
  expect(previous).toEqual(to);
  expect(findIslandRoute(from, [30, 30])).toEqual([]);
});
it('roams when idle and blends turns without teleporting when a task arrives', () => {
  const state = createWalker('mori', [-3.45, 1.2]);
  const start = [...state.position];
  for (let i = 0; i < 300; i++) advanceWalker(state, 1 / 30, { roaming: true });
  expect(Math.hypot(state.position[0] - start[0], state.position[1] - start[1])).toBeGreaterThan(1);
  const before = [...state.position],
    yaw = state.yaw;
  advanceWalker(state, 1 / 30, { roaming: false, target: [-3.45, 1.2] });
  expect(Math.hypot(state.position[0] - before[0], state.position[1] - before[1])).toBeLessThan(
    0.04,
  );
  expect(Math.abs(state.yaw - yaw)).toBeLessThan(0.16);
  for (let i = 0; i < 1800; i++)
    advanceWalker(state, 1 / 30, { roaming: false, target: [-3.45, 1.2] });
  expect(Math.hypot(state.position[0] + 3.45, state.position[1] - 1.2)).toBeLessThan(0.03);
  expect(state.speed).toBeLessThan(0.01);
});
it('keeps reduced, inactive and closeup motion stationary', () => {
  for (const blocked of [{ reduced: true }, { active: false }, { preview: true }]) {
    const state = createWalker('luma', [3.45, 1.2]);
    for (let i = 0; i < 120; i++) advanceWalker(state, 1 / 30, { roaming: true, ...blocked });
    expect(state.position).toEqual([3.45, 1.2]);
    expect(state.phase).toBe(0);
  }
});
it('keeps the approach to the promenade clear of the existing potted plants', () => {
  expect(isWalkable([-5, 2])).toBe(false);
  const route = findIslandRoute([-3.45, 1.2], [-6.8, 2]);
  expect(route.length).toBeGreaterThan(0);
  for (const point of route) expect(Math.hypot(point[0] + 5, point[1] - 2)).toBeGreaterThan(0.7);
});
it('keeps a continuous pace through promenade waypoints that are not rest stops', () => {
  const state = createWalker('mori', [7.1, 0]);
  state.key = 'roam';
  state.patrol = 1;
  state.speed = 0.5;
  state.route = [[7.1, 0.004]];
  advanceWalker(state, 1 / 30, { roaming: true });
  expect(state.route).toHaveLength(0);
  expect(state.pause).toBe(0);
  expect(state.speed).toBeGreaterThan(0.2);
});
