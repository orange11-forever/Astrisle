import { describe, expect, it } from 'vitest';
import { directScene, emptyDirector, resolveStation } from './director';
import type { ProjectSnapshot } from '@astrisle/contracts';
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
