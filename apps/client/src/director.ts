import type { ProjectSnapshot } from '@astrisle/contracts';

export type MotionKind =
  | 'handoff'
  | 'pickup'
  | 'findings'
  | 'return'
  | 'delivery'
  | 'question'
  | 'plan';
export interface SceneIntent {
  id: string;
  actorId: string;
  kind: MotionKind;
  anchor: string;
  versionId?: string;
  expiresAt: number;
  duration: number;
  stationary: boolean;
}
export interface DirectorState {
  projectId?: string;
  seen: string[];
  intents: SceneIntent[];
  lastSequence: number;
}
export const emptyDirector = (): DirectorState => ({ seen: [], intents: [], lastSequence: 0 });
/** Snapshot arrival only consumes facts. No command API enters this module. Rebuilds never replay history. */
export function directScene(
  previous: DirectorState,
  snapshot: ProjectSnapshot,
  now: number,
  reducedMotion = false,
): DirectorState {
  const projectId = snapshot.commission.id;
  if (previous.projectId !== projectId)
    return {
      projectId,
      seen: snapshot.events.map((e) => e.id),
      intents: [],
      lastSequence: snapshot.lastSequence,
    };
  const seen = new Set(previous.seen);
  const intents = previous.intents.filter((i) => i.expiresAt > now);
  const anchors: Record<MotionKind, string> = {
    handoff: 'table',
    pickup: 'table',
    findings: 'compare',
    return: 'table',
    delivery: 'dock',
    question: 'mail',
    plan: 'table',
  };
  for (const event of snapshot.events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.sequence <= previous.lastSequence || now - Date.parse(event.createdAt) > 15000)
      continue;
    const task = snapshot.tasks.find((t) => t.id === event.taskId);
    let kind: MotionKind | undefined;
    const type = event.type.replace(/[.:]/g, '_');
    if (
      /artifact_(saved|created|registered|available)/.test(type) &&
      snapshot.artifacts.some(
        (a) => a.versionId === event.artifactVersionId && a.validity === 'current',
      )
    )
      kind = 'handoff';
    else if (
      /(review_started|task_started|task_inputs)/.test(type) &&
      task?.kind === 'review' &&
      task.status === 'running' &&
      task.inputVersions.length
    )
      kind = 'pickup';
    else if (
      /(review_failed|finding|review_findings|review_submitted)/.test(type) &&
      snapshot.evidence.some(
        (e) => e.taskId === task?.id && e.kind === 'review' && e.status === 'failed',
      )
    )
      kind = 'findings';
    else if (
      /(rework|required_return)/.test(type) &&
      task &&
      ['rework_required', 'queued', 'running'].includes(task.status)
    )
      kind = 'return';
    else if (
      /(awaiting_acceptance|delivery_ready)/.test(type) &&
      snapshot.commission.status === 'awaiting_acceptance'
    )
      kind = 'delivery';
    else if (
      /(request_created|input_requested|approval_requested)/.test(type) &&
      snapshot.requests.some((r) => r.status === 'open' && (!task || r.taskId === task.id))
    )
      kind = 'question';
    else if (/plan_(saved|created)/.test(type)) kind = 'plan';
    if (!kind) continue;
    const actorId = event.agentId || task?.agentId || 'luma';
    const index = intents.findIndex((i) => i.actorId === actorId);
    if (index >= 0) intents.splice(index, 1); // interruption also disposes the previous visual prop
    intents.push({
      id: event.id,
      actorId,
      kind,
      anchor: anchors[kind],
      versionId: event.artifactVersionId,
      duration: reducedMotion ? 0.15 : 3,
      expiresAt: now + (reducedMotion ? 150 : 5500),
      stationary: reducedMotion,
    });
  }
  return { projectId, seen: [...seen].slice(-1000), intents, lastSequence: snapshot.lastSequence };
}
/** Reservations are visual only; an occupied station degrades to a gesture after 1.5 seconds. */
export function resolveStation(
  intent: SceneIntent,
  occupied: boolean,
  waitedMs: number,
): SceneIntent | null {
  if (!occupied) return intent;
  return waitedMs >= 1500 ? { ...intent, stationary: true } : null;
}
