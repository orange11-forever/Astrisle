import type { Artifact, ProjectSnapshot } from '../../contracts/src/index';

function reworkParentTasks(snapshot: ProjectSnapshot): Map<string, string> {
  const parents = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const event of snapshot.events) {
    if (event.type !== 'rework_created' || event.commissionId !== snapshot.commission.id) continue;
    // Automatic reworks saved the linked task IDs in this event before version links existed.
    const link = /^Linked (\S+) to (\S+)$/.exec(event.message);
    if (!link || link[1] !== event.taskId || link[1] === link[2]) continue;
    const [task, parent] = [link[1], link[2]];
    const existing = parents.get(task);
    if (existing && existing !== parent) ambiguous.add(task);
    parents.set(task, parent);
  }
  for (const task of ambiguous) parents.delete(task);
  for (const task of snapshot.tasks) {
    if (
      task.commissionId === snapshot.commission.id &&
      task.replacesTaskId &&
      task.replacesTaskId !== task.id
    ) {
      parents.set(task.id, task.replacesTaskId);
    }
  }
  return parents;
}

/** Groups versions by output slot in published order. Stale versions remain reviewable. */
export function artifactVersionFamilies(snapshot: ProjectSnapshot): Artifact[][] {
  const artifacts = snapshot.artifacts.filter(
    (artifact) => artifact.commissionId === snapshot.commission.id,
  );
  const versionCounts = new Map<string, number>();
  for (const { versionId } of artifacts) {
    versionCounts.set(versionId, (versionCounts.get(versionId) ?? 0) + 1);
  }
  const parents = reworkParentTasks(snapshot);
  const roots = new Map<string, string>();
  function originalTask(taskId: string): string {
    const visited = new Set<string>();
    let task = taskId;
    while (!roots.has(task) && parents.has(task)) {
      if (visited.has(task)) {
        // A malformed cycle cannot establish shared ancestry.
        for (const member of visited) roots.set(member, member);
        return taskId;
      }
      visited.add(task);
      task = parents.get(task)!;
    }
    const root = roots.get(task) ?? task;
    for (const member of visited) roots.set(member, root);
    return root;
  }

  const families: Artifact[][] = [];
  const bySlot = new Map<string, Artifact[]>();
  const byVersion = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    if (!artifact.versionId || versionCounts.get(artifact.versionId) !== 1) continue;
    // Publication stores a complete relative path with slash separators. Preserve its casing.
    const slot = JSON.stringify([originalTask(artifact.taskId), artifact.relativePath]);
    const existing = bySlot.get(slot);
    const previous = artifact.previousVersionId
      ? byVersion.get(artifact.previousVersionId)
      : undefined;
    // A slot is established by its first publication. New slots can inherit an earlier family.
    const family = existing ?? previous ?? [];
    if (!family.length) families.push(family);
    family.push(artifact);
    bySlot.set(slot, family);
    byVersion.set(artifact.versionId, family);
  }
  return families;
}

export function artifactVersionHistory(snapshot: ProjectSnapshot, versionId: string): Artifact[] {
  return (
    artifactVersionFamilies(snapshot).find((family) =>
      family.some((artifact) => artifact.versionId === versionId),
    ) ?? []
  );
}
