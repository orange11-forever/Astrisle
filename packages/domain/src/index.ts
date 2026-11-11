import type {
  Criterion,
  ModelTaskProposal,
  ProjectSnapshot,
  Task,
} from '../../contracts/src/index';
export const agents = [
  {
    id: 'mori',
    name: 'Mori',
    temperament: 'explorer' as const,
  },
  {
    id: 'luma',
    name: 'Luma',
    temperament: 'organizer' as const,
  },
];
const kinds = new Set(['investigate', 'implement', 'office', 'review', 'integrate']);
export function validatePlan(value: unknown, criteria: Criterion[]): ModelTaskProposal[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 48)
    throw new Error('Plan must contain 2–48 tasks');
  const tasks = structuredClone(value) as ModelTaskProposal[],
    ids = new Set<string>();
  for (const t of tasks) {
    if (
      !t ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(t.key) ||
      ids.has(t.key) ||
      !['mori', 'luma'].includes(t.agentId) ||
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
        (a) => !reviews.some((r) => r.agentId !== a.agentId && reaches(r, a.key, new Set())),
      )
    )
      throw new Error('Every criterion requires a separate author and dependent reviewer');
  }
  function reaches(t: ModelTaskProposal, key: string, seen: Set<string>): boolean {
    if (seen.has(t.key)) return false;
    seen.add(t.key);
    return (
      t.dependencies.includes(key) ||
      t.dependencies.some((dep) => reaches(tasks.find((x) => x.key === dep)!, key, seen))
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
      if (tasks.find((t) => t.key === dependency)?.kind !== 'review')
        task.dependencyKinds[dependency] = 'artifact_available';
    }
  }
  return tasks;
}
export function ready(task: Task, snapshot: ProjectSnapshot): boolean {
  return (
    ['queued', 'waiting_dependency'].includes(task.status) &&
    task.dependencies.every((id) => {
      const dep = snapshot.tasks.find((t) => t.id === id);
      return task.dependencyKinds?.[id] === 'artifact_available'
        ? dep?.outputArtifactIds.some((id) =>
            snapshot.artifacts.some((a) => a.id === id && a.validity === 'current'),
          )
        : dep?.status === 'passed';
    })
  );
}
export function invalidateLineage(snapshot: ProjectSnapshot, versions: string[]): void {
  const stale = new Set(versions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of snapshot.artifacts)
      if (
        a.validity === 'current' &&
        (stale.has(a.versionId) || a.inputVersions.some((v) => stale.has(v)))
      ) {
        a.validity = 'stale';
        stale.add(a.versionId);
        changed = true;
      }
  }
  for (const t of snapshot.tasks)
    if (t.inputVersions.some((v) => stale.has(v)) && t.status === 'passed') {
      t.status = 'queued';
      t.step = 'Input version changed; verification required';
    }
}
