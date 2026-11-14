import { describe, expect, it } from 'vitest';
import {
  advanceWalker,
  createWalker,
  findIslandRoute,
  isWalkable,
  segmentIsWalkable,
} from './island-motion';
import { FACILITIES, type FacilityId } from './island-facilities';
import { advanceLeisure, createLeisure, releaseLeisure, swingAngle } from './island-activities';

const homes = { mori: [-3.45, 1.2], luma: [3.45, 1.2], user: [0, 3.65] } as const;
function actor(id = 'mori') {
  const state = createLeisure(id);
  const walker = createWalker(id, [...homes[id as keyof typeof homes]]);
  const reservations = new Map<FacilityId, string>();
  const tick = (idle = true, active = true, reduced = false, capable = true) => {
    advanceLeisure(state, 0.05, {
      position: walker.position,
      idle,
      active,
      reduced,
      capable,
      reservations,
    });
    advanceWalker(walker, 0.05, {
      roaming: idle && !state.facility,
      target: state.facility
        ? FACILITIES[state.facility].approach
        : [...homes[id as keyof typeof homes]],
      active,
      reduced,
    });
  };
  const until = (condition: () => boolean, steps = 4000) => {
    for (let n = 0; n < steps && !condition(); n++) tick();
    expect(condition()).toBe(true);
  };
  return { state, walker, reservations, tick, until };
}

describe('automatic island leisure', () => {
  it('waits for its next activity instead of repeatedly choosing the same free seat', () => {
    const a = actor();
    a.until(() => a.state.stage === 'enjoying');
    a.until(() => a.state.stage === 'roaming');
    a.reservations.set('tea-chair', 'luma');
    for (let i = 0; i < 350; i++) a.tick();
    expect(a.state.facility).toBeUndefined();
    a.reservations.delete('tea-chair');
    a.until(() => a.state.stage === 'approaching');
    expect(a.state.facility).toBe('tea-chair');
  });
  it('has safe approaches reachable from every home and every other facility', () => {
    const starts = [...Object.values(homes), ...Object.values(FACILITIES).map((f) => f.approach)];
    for (const facility of Object.values(FACILITIES)) {
      expect(isWalkable(facility.approach)).toBe(true);
      for (const start of starts) {
        if (Math.hypot(start[0] - facility.approach[0], start[1] - facility.approach[1]) < 0.01)
          continue;
        const route = findIslandRoute([...start], facility.approach);
        expect(route.length).toBeGreaterThan(0);
        let previous: [number, number] = [...start];
        for (const point of route) {
          expect(segmentIsWalkable(previous, point)).toBe(true);
          previous = point;
        }
      }
    }
  });

  it('walks to a facility, sits smoothly, enjoys it, then stands and releases it', () => {
    const a = actor();
    a.until(() => a.state.stage === 'approaching');
    expect(a.state.blend).toBe(0);
    expect(a.reservations.get(a.state.facility!)).toBe('mori');
    a.until(() => a.state.stage === 'settling');
    expect(a.walker.position).toEqual(FACILITIES[a.state.facility!].approach);
    a.tick();
    expect(a.state.blend).toBeGreaterThan(0);
    expect(a.state.blend).toBeLessThan(1);
    a.until(() => a.state.stage === 'enjoying');
    expect(a.state.blend).toBe(1);
    a.until(() => a.state.stage === 'leaving');
    a.until(() => a.state.stage === 'roaming');
    expect(a.state.facility).toBeUndefined();
    expect(a.reservations.size).toBe(0);
    expect(a.state.blend).toBe(0);
  });

  it('reserves distinct facilities and never steals one another actor is using', () => {
    const reservations = new Map<FacilityId, string>();
    const states = ['mori', 'luma', 'user', 'guest'].map(createLeisure);
    for (let n = 0; n < 350; n++)
      for (const state of states)
        advanceLeisure(state, 0.05, {
          position: [0, 3.65],
          idle: true,
          active: true,
          reduced: false,
          capable: true,
          reservations,
        });
    const occupied = states.filter((s) => s.facility);
    expect(occupied).toHaveLength(3);
    expect(new Set(occupied.map((s) => s.facility)).size).toBe(3);
    for (const s of occupied) expect(reservations.get(s.facility!)).toBe(s.id);
    releaseLeisure(states[3], reservations);
    expect(reservations.size).toBe(3);
  });

  it('interrupts sitting for work, stands first, and returns without stranding the walker', () => {
    const a = actor();
    a.until(() => a.state.stage === 'enjoying');
    const at = [...a.walker.position];
    a.tick(false);
    expect(a.state.stage).toBe('leaving');
    expect(a.state.blend).toBeGreaterThan(0);
    expect(a.walker.position).toEqual(at);
    for (let i = 0; i < 1800; i++) a.tick(false);
    expect(a.state.facility).toBeUndefined();
    expect(a.reservations.size).toBe(0);
    expect(a.walker.position).toEqual([...homes.mori]);
  });

  it('pauses activity time in the background and cancels leisure for reduced motion or unsupported models', () => {
    const a = actor('user');
    a.until(() => a.state.stage === 'enjoying');
    const before = JSON.stringify(a.state);
    for (let i = 0; i < 300; i++) a.tick(true, false);
    expect(JSON.stringify(a.state)).toBe(before);
    expect(swingAngle(a.state)).toBe(swingAngle(JSON.parse(before)));
    a.tick(true, true, true);
    expect(a.state.facility).toBeUndefined();
    expect(a.reservations.size).toBe(0);
    for (let i = 0; i < 400; i++) a.tick(true, true, false, false);
    expect(a.state.stage).toBe('roaming');
    expect(a.state.facility).toBeUndefined();
  });

  it('cycles through sitting, tea and swing automatically and stops the empty swing', () => {
    const a = actor();
    const visited = new Set<string>();
    for (let i = 0; i < 7500 && visited.size < 3; i++) {
      a.tick();
      if (a.state.stage === 'enjoying') visited.add(FACILITIES[a.state.facility!].activity);
    }
    expect([...visited].sort()).toEqual(['sit', 'swing', 'tea']);
    releaseLeisure(a.state, a.reservations);
    expect(swingAngle(a.state)).toBe(0);
  });
});
