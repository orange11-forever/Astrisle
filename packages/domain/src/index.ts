import type {
  AgentIdentity,
  CharacterProfile,
  Criterion,
  ModelTaskProposal,
  ProjectSnapshot,
  Task,
} from '../../contracts/src/index';
import { DEFAULT_CHARACTERS } from '../../contracts/src/index';

export function agentsFromCharacters(profiles: readonly CharacterProfile[]): AgentIdentity[] {
  return profiles
    .filter((profile) => profile.id !== 'user')
    .map(({ id, displayName, skills }) => ({
      id,
      name: displayName,
      temperament: id === 'luma' ? 'organizer' : 'explorer',
      ...(skills ? { skills: structuredClone(skills) } : {}),
    }));
}

export const agents = agentsFromCharacters(DEFAULT_CHARACTERS);
const kinds = new Set(['investigate', 'implement', 'review', 'integrate']);
export function validatePlan(
  value: unknown,
  criteria: Criterion[],
  roster: readonly AgentIdentity[] = agents,
): ModelTaskProposal[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 48)
    throw new Error('Plan must contain 2–48 tasks');
  const tasks = structuredClone(value) as ModelTaskProposal[],
    ids = new Set<string>();
  const partnerIds = new Set(roster.map((agent) => agent.id));
  for (const t of tasks) {
    if (
      !t ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(t.key) ||
      ids.has(t.key) ||
      !partnerIds.has(t.agentId) ||
      t.agentId === 'user' ||
      !kinds.has(t.kind) ||
      typeof t.title !== 'string' ||
      !t.title.trim() ||
      typeof t.description !== 'string' ||
      !t.description.trim() ||
      !Array.isArray(t.dependencies) ||
      !Array.isArray(t.criterionIds) ||
      !t.criterionIds.length ||
      t.criterionIds.some((c) => !criteria.some((k) => k.id === c))
    )
      throw new Error('Invalid task proposal');
    ids.add(t.key);
  }
  const visiting = new Set<string>(),
    seen = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw new Error('Plan contains a cycle');
    if (seen.has(key)) return;
    const t = tasks.find((t) => t.key === key);
    if (!t) throw new Error('Unknown dependency');
    visiting.add(key);
    for (const dep of t.dependencies) visit(dep);
    visiting.delete(key);
    seen.add(key);
  }
  tasks.forEach((t) => visit(t.key));
  for (const criterion of criteria) {
    const authors = tasks.filter(
      (t) => t.kind !== 'review' && t.criterionIds.includes(criterion.id),
    );
    const reviews = tasks.filter(
      (t) => t.kind === 'review' && t.criterionIds.includes(criterion.id),
    );
    if (
      !authors.length ||
      !reviews.length ||
      authors.some(
        (a) => !reviews.some((r) => r.agentId !== a.agentId && r.dependencies.includes(a.key)),
      )
    )
      throw new Error(
        'Every author, including investigation tasks, requires a direct independent reviewer for its published outputs and criteria',
      );
  }
  for (const t of tasks)
    for (const [key, kind] of Object.entries(t.dependencyKinds ?? {}))
      if (!t.dependencies.includes(key) || !['artifact_available', 'task_passed'].includes(kind))
        throw new Error('Invalid dependency condition');
  // A direct reviewer must be runnable while its author awaits review.
  for (const task of tasks) {
    if (task.kind !== 'review') continue;
    task.dependencyKinds = { ...task.dependencyKinds };
    for (const dependency of task.dependencies) {
      const author = tasks.find((t) => t.key === dependency)!;
      if (author.kind !== 'review') {
        if (author.agentId === task.agentId)
          throw new Error('An author cannot review their own work');
        task.dependencyKinds[dependency] = 'artifact_available';
      }
    }
  }
  // A DAG can still deadlock when an author waits for a reviewed predecessor
  // whose only reviewer in turn waits for this author. Simulate handoff/pass
  // boundaries without inventing successful tool results or bypassing reviews.
  const handedOff = new Set<string>();
  const passed = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const task of tasks) {
      if (handedOff.has(task.key) || passed.has(task.key)) continue;
      if (
        !task.dependencies.every((key) =>
          task.dependencyKinds?.[key] === 'artifact_available'
            ? handedOff.has(key)
            : passed.has(key),
        )
      )
        continue;
      progress = true;
      if (task.kind === 'review') {
        passed.add(task.key);
        for (const key of task.dependencies)
          if (tasks.find((candidate) => candidate.key === key)?.kind !== 'review') passed.add(key);
      } else {
        handedOff.add(task.key);
        if (
          !tasks.some(
            (candidate) => candidate.kind === 'review' && candidate.dependencies.includes(task.key),
          )
        )
          passed.add(task.key);
      }
    }
  }
  if (tasks.some((task) => !passed.has(task.key)))
    throw new Error(
      'Plan has a review dependency deadlock; review a prerequisite before the next author, or use artifact_available for its consumer',
    );
  return tasks;
}
export function ready(task: Task, snapshot: ProjectSnapshot): boolean {
  return (
    ['queued', 'waiting_dependency'].includes(task.status) &&
    task.dependencies.every((id) => {
      const dep = snapshot.tasks.find((t) => t.id === id);
      return task.dependencyKinds?.[id] === 'artifact_available'
        ? (task.kind !== 'review' ||
            dep?.kind === 'review' ||
            ['awaiting_review', 'passed'].includes(dep?.status ?? '')) &&
            dep?.outputArtifactIds.some((id) =>
              snapshot.artifacts.some((a) => a.id === id && a.validity === 'current'),
            )
        : dep?.status === 'passed';
    })
  );
}
export function artifactLineage(snapshot: ProjectSnapshot, versions: string[]): Set<string> {
  const stale = new Set(versions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of snapshot.artifacts)
      if (
        a.validity === 'current' &&
        !stale.has(a.versionId) &&
        a.inputVersions.some((v) => stale.has(v))
      ) {
        stale.add(a.versionId);
        changed = true;
      }
  }
  return stale;
}
export function invalidateLineage(snapshot: ProjectSnapshot, versions: string[]): void {
  const stale = artifactLineage(snapshot, versions);
  for (const a of snapshot.artifacts)
    if (a.validity === 'current' && stale.has(a.versionId)) a.validity = 'stale';
  for (const t of snapshot.tasks)
    if (t.inputVersions.some((v) => stale.has(v)) && t.status === 'passed') {
      t.status = 'queued';
      t.step = 'Input version changed; verification required';
    }
}
