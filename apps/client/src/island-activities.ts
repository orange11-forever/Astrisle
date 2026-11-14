import { FACILITIES, type FacilityId } from './island-facilities';
import type { GroundPoint } from './island-motion';

export interface LeisureState {
  id: string;
  stage: 'roaming' | 'approaching' | 'settling' | 'enjoying' | 'leaving';
  facility?: FacilityId;
  elapsed: number;
  time: number;
  blend: number;
  wait: number;
  cycle: number;
  leaveBlend: number;
}
export interface LeisureWorld {
  states: Map<string, LeisureState>;
  reservations: Map<FacilityId, string>;
}
export function createLeisure(id: string): LeisureState {
  const offset = id === 'mori' ? 0 : id === 'luma' ? 1 : 2;
  return {
    id,
    stage: 'roaming',
    elapsed: 0,
    time: 0,
    blend: 0,
    wait: 5 + offset * 2,
    cycle: offset,
    leaveBlend: 0,
  };
}
export function releaseLeisure(state: LeisureState, reservations: Map<FacilityId, string>) {
  if (state.facility && reservations.get(state.facility) === state.id)
    reservations.delete(state.facility);
  state.facility = undefined;
  state.stage = 'roaming';
  state.blend = 0;
  state.time = 0;
  state.elapsed = 0;
  state.wait = 7 + (state.cycle % 4);
}
const order: FacilityId[] = ['garden-bench', 'tea-chair', 'garden-swing'];
const ease = (value: number) => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};
export function advanceLeisure(
  state: LeisureState,
  delta: number,
  options: {
    position: GroundPoint;
    idle: boolean;
    active: boolean;
    reduced: boolean;
    capable: boolean;
    reservations: Map<FacilityId, string>;
  },
): LeisureState {
  const { reservations } = options;
  if (options.reduced || !options.capable) {
    releaseLeisure(state, reservations);
    return state;
  }
  if (!options.active) return state;
  const dt = Number.isFinite(delta) ? Math.min(0.05, Math.max(0, delta)) : 0;
  const leave = () => {
    state.stage = 'leaving';
    state.elapsed = 0;
    state.leaveBlend = state.blend;
  };
  if (!options.idle && state.stage !== 'leaving') {
    if (state.blend > 0) leave();
    else releaseLeisure(state, reservations);
  }
  state.elapsed += dt;
  if (state.stage === 'roaming') {
    if (!options.idle) return state;
    state.wait -= dt;
    if (state.wait > 0) return state;
    const index = state.cycle % order.length;
    const id = order[index];
    if (!reservations.has(id)) {
      reservations.set(id, state.id);
      state.facility = id;
      state.cycle = index + 1;
      state.stage = 'approaching';
      state.elapsed = 0;
      state.time = 0;
    }
    // Keep a place in the activity cycle instead of permanently skipping a busy seat.
    state.wait = 3;
  } else if (state.stage === 'approaching') {
    const facility = FACILITIES[state.facility!];
    if (
      Math.hypot(
        options.position[0] - facility.approach[0],
        options.position[1] - facility.approach[1],
      ) < 0.012
    ) {
      state.stage = 'settling';
      state.elapsed = 0;
    } else if (state.elapsed > 45) releaseLeisure(state, reservations);
  } else if (state.stage === 'settling') {
    state.blend = ease(state.elapsed / 1.2);
    if (state.blend === 1) {
      state.stage = 'enjoying';
      state.elapsed = 0;
    }
  } else if (state.stage === 'enjoying') {
    state.time += dt;
    if (state.elapsed >= FACILITIES[state.facility!].duration) leave();
  } else {
    state.blend = state.leaveBlend * (1 - ease(state.elapsed / 0.8));
    if (state.blend === 0) releaseLeisure(state, reservations);
  }
  return state;
}
export function swingAngle(state?: LeisureState) {
  return state?.facility && FACILITIES[state.facility].activity === 'swing'
    ? Math.sin(state.time * 1.65) * 0.23 * state.blend
    : 0;
}
