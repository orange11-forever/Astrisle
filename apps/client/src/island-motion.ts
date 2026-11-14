import { FACILITY_OBSTACLES } from './island-facilities';

export type GroundPoint = [number, number];
export const ISLAND_RADIUS = 9;
export const PROMENADE_RADIUS = 7.1;
export const STATION_POINTS: Record<string, GroundPoint> = {
  table: [-1.65, 1.4],
  compare: [0, -5.3],
  dock: [2.5, 2.7],
  mail: [-3, 3],
};
// Furniture footprints, expanded by a companion's clearance in isWalkable.
const obstacles: [number, number, number][] = [
  [0, -0.65, 1.72],
  [-3.6, -1.1, 1.08],
  [3.6, -1.1, 1.08],
  [-3.3, -3.55, 1.12],
  [0, -3.55, 0.95],
  [2.75, -3.75, 1.14],
  [-4.2, 2.7, 0.55],
  [4.2, 2.7, 1.0],
  [-5, 2, 0.34],
  [-5, -2, 0.34],
  [4.65, -2.7, 0.3],
  [1.2, -4.7, 0.3],
  [-1.7, -4.7, 0.3],
  [-5.5, -6.4, 0.65],
  [4.2, -6.9, 0.6],
  [-7.9, -0.7, 0.5],
  [6.75, 5, 0.85],
  ...FACILITY_OBSTACLES,
];
const distance = (a: GroundPoint, b: GroundPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function isWalkable([x, z]: GroundPoint) {
  return (
    Number.isFinite(x) &&
    Number.isFinite(z) &&
    Math.hypot(x, z) <= ISLAND_RADIUS - 0.65 &&
    obstacles.every(([ox, oz, r]) => Math.hypot(x - ox, z - oz) > r + 0.55)
  );
}
export function segmentIsWalkable(a: GroundPoint, b: GroundPoint) {
  const steps = Math.ceil(distance(a, b) / 0.12);
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0;
    if (!isWalkable([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
  }
  return true;
}
/** Small bounded visibility graph. Replanned only when a destination changes. */
export function findIslandRoute(start: GroundPoint, goal: GroundPoint): GroundPoint[] {
  if (!isWalkable(start) || !isWalkable(goal)) return [];
  if (segmentIsWalkable(start, goal)) return [[...goal]];
  const nodes: GroundPoint[] = [start, goal];
  for (const [x, z, radius] of obstacles) {
    const radiusWithClearance = radius + 0.75;
    for (let i = 0; i < 12; i++) {
      const angle = (i * Math.PI) / 6,
        point: GroundPoint = [
          x + Math.cos(angle) * radiusWithClearance,
          z + Math.sin(angle) * radiusWithClearance,
        ];
      if (isWalkable(point)) nodes.push(point);
    }
  }
  const scores = nodes.map(() => Infinity),
    previous = nodes.map(() => -1),
    visited = new Set<number>();
  scores[0] = 0;
  for (let pass = 0; pass < nodes.length; pass++) {
    let current = -1,
      best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const score = scores[i] + distance(nodes[i], goal);
      if (!visited.has(i) && score < best) {
        best = score;
        current = i;
      }
    }
    if (current < 0) return [];
    if (current === 1) {
      const route: GroundPoint[] = [];
      let index = 1;
      while (index > 0) {
        route.unshift([...nodes[index]]);
        index = previous[index];
      }
      return route;
    }
    visited.add(current);
    for (let i = 1; i < nodes.length; i++) {
      if (visited.has(i)) continue;
      const score = scores[current] + distance(nodes[current], nodes[i]);
      if (score < scores[i] && segmentIsWalkable(nodes[current], nodes[i])) {
        scores[i] = score;
        previous[i] = current;
      }
    }
  }
  return [];
}
export interface Walker {
  position: GroundPoint;
  yaw: number;
  speed: number;
  phase: number;
  strength: number;
  route: GroundPoint[];
  key: string;
  patrol: number;
  pause: number;
  personality: number;
}
export function createWalker(id: string, home: GroundPoint): Walker {
  const personality = id === 'mori' ? 0 : id === 'luma' ? 1 : 2;
  return {
    position: [...home],
    yaw: 0.28,
    speed: 0,
    phase: 0,
    strength: 0,
    route: [],
    key: '',
    patrol: Math.round((Math.atan2(home[1], home[0]) / (Math.PI * 2)) * 24),
    pause: 0,
    personality,
  };
}
export function advanceWalker(
  state: Walker,
  delta: number,
  options: {
    roaming: boolean;
    target?: GroundPoint;
    reduced?: boolean;
    active?: boolean;
    preview?: boolean;
  },
) {
  const dt = Math.min(Math.max(delta, 0), 0.05);
  if (options.active === false || options.preview || options.reduced) {
    state.speed = 0;
    state.strength = 0;
    if (options.reduced && options.target && !options.roaming) {
      if (isWalkable(options.target)) state.position = [...options.target];
      state.route = [];
      state.key = '';
    }
    return state;
  }
  const key = options.roaming ? 'roam' : (options.target?.join(',') ?? 'stay');
  if (key !== state.key) {
    state.key = key;
    state.pause = 0;
    state.route = options.roaming
      ? []
      : options.target
        ? findIslandRoute(state.position, options.target)
        : [];
  }
  if (options.roaming && !state.route.length) {
    state.pause = Math.max(0, state.pause - dt);
    if (state.pause === 0) {
      for (let attempts = 0; attempts < 24; attempts++) {
        const angle = ((state.patrol++ % 24) * Math.PI) / 12;
        const target: GroundPoint = [
          Math.cos(angle) * PROMENADE_RADIUS,
          Math.sin(angle) * PROMENADE_RADIUS,
        ];
        if (distance(state.position, target) > 0.2)
          state.route = findIslandRoute(state.position, target);
        if (state.route.length) break;
      }
    }
  }
  const next = state.route[0];
  if (!next) {
    state.speed = Math.max(0, state.speed - dt * 1.8);
    state.strength += (0 - state.strength) * (1 - Math.exp(-dt * 10));
    return state;
  }
  const remaining = distance(state.position, next);
  const desiredYaw = Math.atan2(next[0] - state.position[0], next[1] - state.position[1]);
  const angle = Math.atan2(Math.sin(desiredYaw - state.yaw), Math.cos(desiredYaw - state.yaw));
  state.yaw += Math.max(-dt * 4, Math.min(dt * 4, angle));
  const maximum = [0.72, 0.64, 0.58][state.personality];
  const stopAtGoal = !options.roaming || (state.patrol + state.personality) % 5 === 0;
  const stopping =
    state.route.length === 1 && stopAtGoal ? Math.sqrt(2 * 1.6 * remaining) : maximum;
  const targetSpeed = Math.min(maximum, stopping) * Math.max(0.08, Math.cos(angle));
  state.speed += Math.max(-dt * 1.6, Math.min(dt * 1.2, targetSpeed - state.speed));
  const step = Math.min(remaining, state.speed * dt);
  if (remaining > 1e-6) {
    state.position[0] += ((next[0] - state.position[0]) * step) / remaining;
    state.position[1] += ((next[1] - state.position[1]) * step) / remaining;
  }
  state.phase += (step / 0.48) * Math.PI * 2;
  state.strength += (Math.min(1, state.speed / 0.55) - state.strength) * (1 - Math.exp(-dt * 9));
  if (remaining - step < 0.012) {
    state.position = [...next];
    state.route.shift();
    if (!state.route.length) {
      if (stopAtGoal) state.speed = 0;
      if (options.roaming && stopAtGoal) state.pause = 2 + state.personality * 0.8;
    }
  }
  return state;
}
