import { describe, expect, it } from 'vitest';
import { directScene, emptyDirector, placeSceneActors, resolveStation } from './director';
import type { ProjectSnapshot, Task } from '@astrisle/contracts';
import { findIslandRoute, getIslandCharacterHomes, STATION_POINTS } from './island-motion';
const now = Date.now();
function snapshot(id = 'c'): ProjectSnapshot {
  return {
    commission: { id, status: 'active' },
    tasks: [],
    artifacts: [],
    evidence: [],
    requests: [],
    events: [],
    lastSequence: 0,
  } as unknown as ProjectSnapshot;
}
function saved(s: ProjectSnapshot, age = 0) {
  s.artifacts = [{ versionId: 'v', validity: 'current' }] as ProjectSnapshot['artifacts'];
  s.events.push({
    id: 'e',
    commissionId: s.commission.id,
    sequence: 1,
    type: 'artifact.saved',
    artifactVersionId: 'v',
    agentId: 'mori',
    message: 'saved',
    createdAt: new Date(now - age).toISOString(),
  });
  s.lastSequence = 1;
  return s;
}
describe('scene facts', () => {
  it('does not replay a rebuilt snapshot', () =>
    expect(directScene(emptyDirector(), saved(snapshot()), now).intents).toHaveLength(0));
  it('deduplicates saved versions and removes interrupted props', () => {
    const s = snapshot();
    const initial = directScene(emptyDirector(), s, now);
    saved(s);
    const next = directScene(initial, s, now);
    expect(next.intents[0]?.kind).toBe('handoff');
    expect(directScene(next, s, now).intents).toHaveLength(1);
    expect(directScene(next, s, now + 6000).intents).toHaveLength(0);
  });
  it('drops stale and invalid artifact events', () => {
    const s = snapshot();
    const initial = directScene(emptyDirector(), s, now);
    saved(s, 16000);
    expect(directScene(initial, s, now).intents).toHaveLength(0);
    s.events[0]!.createdAt = new Date(now).toISOString();
    s.artifacts[0]!.validity = 'stale';
    expect(directScene(initial, s, now).intents).toHaveLength(0);
  });
  it('clears queues on project switch', () => {
    const s = snapshot();
    let state = directScene(emptyDirector(), s, now);
    state = directScene(state, saved(s), now);
    expect(directScene(state, snapshot('other'), now).intents).toHaveLength(0);
  });
  it('uses static poses with reduced motion and occupied station fallback', () => {
    const s = snapshot();
    const initial = directScene(emptyDirector(), s, now);
    const intent = directScene(initial, saved(s), now, true).intents[0]!;
    expect(intent.stationary).toBe(true);
    expect(intent.duration).toBeLessThanOrEqual(0.15);
    expect(resolveStation(intent, true, 1000)).toBeNull();
    expect(resolveStation(intent, true, 1500)?.stationary).toBe(true);
  });
  it('never presents delivery before awaiting acceptance', () => {
    const s = snapshot();
    const initial = directScene(emptyDirector(), s, now);
    s.events = [
      {
        id: 'd',
        commissionId: 'c',
        sequence: 1,
        type: 'delivery_ready',
        message: 'ready',
        createdAt: new Date(now).toISOString(),
      },
    ];
    s.lastSequence = 1;
    expect(directScene(initial, s, now).intents).toHaveLength(0);
    s.commission.status = 'awaiting_acceptance';
    expect(directScene(initial, s, now).intents[0]?.kind).toBe('delivery');
  });
});

describe('shared island stations', () => {
  const ids = ['partner-first', 'partner-second'] as const;
  const homes = getIslandCharacterHomes(ids);
  const actors = (kind: Task['kind']) =>
    ids.map((id) => ({
      id,
      home: homes.get(id)!,
      task: { kind, status: 'running' as Task['status'] },
    }));

  it.each([
    ['implement', 'table'],
    ['review', 'compare'],
  ] as const)('keeps two running %s partners at distinct reachable targets', (kind, station) => {
    const workers = actors(kind);
    const placements = placeSceneActors(workers, []);
    expect(placements.get(ids[0])?.target).toEqual(STATION_POINTS[station]);
    expect(placements.get(ids[1])?.target).toEqual(homes.get(ids[1]));
    for (const worker of workers) {
      const target = placements.get(worker.id)!.target;
      expect(findIslandRoute(worker.home, target).at(-1)).toEqual(target);
    }
    workers[0].task.status = 'passed';
    expect(placeSceneActors(workers, []).get(ids[1])?.target).toEqual(STATION_POINTS[station]);
  });

  it('reserves a moving intent station before assigning a running task fallback', () => {
    const workers = actors('implement');
    workers[1].task.kind = 'review';
    const pickup = {
      id: 'pickup',
      actorId: ids[1],
      kind: 'pickup',
      anchor: 'table',
      expiresAt: now + 5500,
      duration: 3,
      stationary: false,
    } as const;
    const placements = placeSceneActors(workers, [pickup]);
    expect(placements.get(ids[0])?.target).toEqual(homes.get(ids[0]));
    expect(placements.get(ids[1])).toEqual({ intent: pickup, target: STATION_POINTS.table });
    expect(placeSceneActors(workers, []).get(ids[0])?.target).toEqual(STATION_POINTS.table);
    const stationary = placeSceneActors(workers, [{ ...pickup, stationary: true }]);
    expect(stationary.get(ids[0])?.target).toEqual(STATION_POINTS.table);
    expect(stationary.get(ids[1])?.target).toEqual(homes.get(ids[1]));
  });
});
