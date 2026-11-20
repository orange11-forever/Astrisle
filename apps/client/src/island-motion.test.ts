import { expect, it } from 'vitest';
import type { CharacterId } from '@astrisle/contracts';
import {
  harborBridge,
  harborGardenLanding,
  harborStops,
  harborStreetZ,
  harborToWorld,
  worldToHarbor,
} from './harbor-layout';
import {
  STATION_POINTS,
  findIslandRoute,
  isWalkable,
  segmentIsWalkable,
  createWalker,
  advanceWalker,
  getIslandCharacterHomes,
} from './island-motion';
import { FACILITIES } from './island-facilities';

it('keeps saved homes stable when more partners arrive and connects them to island activities', () => {
  const ids: CharacterId[] = ['mori', 'luma', 'user'];
  const partners = Array.from({ length: 24 }, (_, i): CharacterId => `partner-${i}`);
  const first = getIslandCharacterHomes([...ids, ...partners.slice(0, 4)]);
  const homes = getIslandCharacterHomes([...ids, ...partners]);
  expect([...first]).toEqual([...homes].slice(0, first.size));
  expect(homes.get(partners[2])).toBe(first.get(partners[2]));
  expect(homes.get('mori')).toEqual([-3.45, 1.2]);
  expect(homes.get('luma')).toEqual([3.45, 1.2]);
  expect(homes.get('user')).toEqual([0, 3.65]);
  expect(new Set([...homes.values()].map((point) => point.join(','))).size).toBe(27);
  for (const id of partners) {
    const home = homes.get(id)!;
    expect(isWalkable(home), id).toBe(true);
    for (const target of [
      ...Object.values(STATION_POINTS),
      ...Object.values(FACILITIES).map((f) => f.approach),
    ]) {
      expect(findIslandRoute(home, target).at(-1), `${id} to ${target}`).toEqual(target);
    }
  }
});
it('keeps every real collaboration station reachable from both companion homes', () => {
  for (const target of Object.values(STATION_POINTS))
    for (const home of [
      [-3.45, 1.2],
      [3.45, 1.2],
    ] as [number, number][]) {
      expect(isWalkable(target), `unwalkable station ${target}`).toBe(true);
      const route = findIslandRoute(home, target);
      expect(route.length, `unreachable station ${target}`).toBeGreaterThan(0);
    }
});
it('drops the old path when reduced motion snaps to a station before resuming', () => {
  const state = createWalker('mori', [7.1, 0]),
    target: [number, number] = [2.5, 2.7];
  advanceWalker(state, 1 / 30, { roaming: false, target });
  advanceWalker(state, 1 / 30, { roaming: false, target, reduced: true });
  for (let i = 0; i < 120; i++) {
    advanceWalker(state, 1 / 30, { roaming: false, target });
    expect(isWalkable(state.position)).toBe(true);
  }
  expect(state.position).toEqual(target);
});

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

it('crosses the bridge and turns along the quay to reach both stops in either direction', () => {
  const home: [number, number] = [-3.45, 1.2];
  for (const stop of Object.values(harborStops)) {
    for (const [from, to] of [
      [home, stop.point],
      [stop.point, home],
    ] as const) {
      const route = findIslandRoute(from, to);
      expect(route.at(-1)).toEqual(to);
      expect(
        route.some((point) => {
          const [x, z] = worldToHarbor(point);
          return Math.abs(x - harborBridge.x) < 0.001 && Math.abs(z - harborStreetZ) < 0.001;
        }),
      ).toBe(true);
      let previous = from;
      for (const point of route) {
        expect(segmentIsWalkable(previous, point)).toBe(true);
        previous = point;
      }
    }
  }
  expect(isWalkable(harborToWorld([3.8, 4.25]))).toBe(false);
  expect(isWalkable(harborToWorld([-4.9, 0.9]))).toBe(false);
  expect(isWalkable(harborToWorld([0.38, 6.0]))).toBe(false);
  expect(segmentIsWalkable(harborGardenLanding, harborStops.mooring.point)).toBe(false);
});

it('visits the quayside while idle and follows the bridge back for work', () => {
  const home: [number, number] = [-3.45, 1.2];
  const state = createWalker('mori', harborGardenLanding);
  const travel = (roaming: boolean, reduced = false) => {
    const before = [...state.position];
    advanceWalker(state, 0.05, { roaming, target: home, reduced });
    expect(Math.hypot(state.position[0] - before[0]!, state.position[1] - before[1]!)).toBeLessThan(
      0.06,
    );
    expect(isWalkable(state.position)).toBe(true);
  };
  for (let step = 0; step < 1100 && state.harborVisit?.stage !== 'watching'; step++) travel(true);
  expect(state.harborVisit).toMatchObject({ stage: 'watching', stop: 'market' });
  expect(state.position).toEqual(harborStops.market.point);
  travel(true, true);
  expect(state.harborVisit?.stage).toBe('watching');
  expect(state.position).toEqual(harborStops.market.point);
  travel(false);
  expect(state.harborVisit).toBeUndefined();
  let crossed = false;
  for (let step = 0; step < 1350 && state.route.length; step++) {
    travel(false);
    const [x, z] = worldToHarbor(state.position);
    crossed ||= Math.abs(x - harborBridge.x) < 0.02 && z > 3.0 && z < 5.5;
  }
  expect(crossed).toBe(true);
  expect(state.position).toEqual(home);
});
