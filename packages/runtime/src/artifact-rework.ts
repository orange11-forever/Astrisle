import { randomUUID } from 'node:crypto';
import type { Artifact, ProjectSnapshot, Task } from '../../contracts/src/index';
import { artifactLineage } from '../../domain/src/index';

export function pathComparisonKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function directedReworkOutputs(snapshot: ProjectSnapshot, task: Task): Artifact[] {
  if (!task.artifactRework) return [];
  const expected = task.artifactRework;
  const versions = new Set([expected.versionId, ...(expected.renderedVersionIds ?? [])]);
  const outputs = snapshot.artifacts.filter((artifact) => versions.has(artifact.versionId));
  if (outputs.length !== versions.size) throw new Error('Previous rework versions are missing');
  return outputs;
}

export function previousTaskIds(snapshot: ProjectSnapshot, task: Task): Set<string> {
  const previous = new Set<string>();
  let ancestor = task.replacesTaskId;
  while (ancestor && ancestor !== task.id && !previous.has(ancestor)) {
    previous.add(ancestor);
    ancestor = snapshot.tasks.find((candidate) => candidate.id === ancestor)?.replacesTaskId;
  }
  return previous;
}

export function previousTaskOutputs(snapshot: ProjectSnapshot, task: Task): Artifact[] {
  for (const ancestor of previousTaskIds(snapshot, task)) {
    const outputs = snapshot.artifacts.filter(
      (artifact) => artifact.taskId === ancestor && artifact.validity === 'stale',
    );
    if (outputs.length) return outputs;
  }
  return [];
}

export function scheduleArtifactRework(
  snapshot: ProjectSnapshot,
  target: Artifact,
  originalAuthor: Task,
  reviewerAgentId: string,
  instruction: string,
  requestId: string,
  now: string,
): { task: Task } | { code: 'path_conflict'; path: string } | { code: 'request_pending' } {
  const renders = snapshot.artifacts.filter(
    (artifact) =>
      artifact.taskId === originalAuthor.id &&
      artifact.validity === 'current' &&
      artifact.renderedFromVersionId === target.versionId,
  );
  let stale = artifactLineage(snapshot, [target.versionId, ...renders.map((a) => a.versionId)]);
  const keepAuthor = snapshot.artifacts.some(
    (artifact) =>
      artifact.taskId === originalAuthor.id &&
      artifact.validity === 'current' &&
      !stale.has(artifact.versionId),
  );
  const author = freshTask(originalAuthor, now);
  author.title = `Rework ${target.name}`;
  const rendering = renders.length
    ? ` After publishing that source, regenerate and publish these outputs with render_source: ${renders.map((a) => a.relativePath).join(', ')}.`
    : '';
  author.description = `Read and revise the pinned previous file at ${target.relativePath}, retain applicable original requirements, and publish the changed file.${rendering}\nApply the user's instruction below.\n${instruction}\nUse the following prior task scope for the selected file.\n${originalAuthor.description.slice(0, 3000)}`;
  author.artifactRework = {
    artifactId: target.id,
    versionId: target.versionId,
    instruction,
    requestId,
    ...(renders.length ? { renderedVersionIds: renders.map((a) => a.versionId) } : {}),
  };
  const reviewer: Task = {
    ...freshTask(originalAuthor, now),
    kind: 'review',
    agentId: reviewerAgentId,
    title: `Review the replacement for ${target.name}`,
    description: `Independently verify ${target.relativePath}${renders.length ? ' and its regenerated outputs' : ''} against the original criteria and this user instruction.\n${instruction}`,
    dependencies: [author.id],
    dependencyKinds: { [author.id]: 'artifact_available' },
  };
  delete reviewer.replacesTaskId;

  const active = snapshot.tasks.filter(
    (task) =>
      task.id !== originalAuthor.id && !['rework_required', 'cancelled'].includes(task.status),
  );
  const replacements = new Map<string, Task>();
  const retainedReviews = new Set<string>();
  const downstream: Task[] = [];
  let added: boolean;
  do {
    added = false;
    for (const task of active) {
      if (replacements.has(task.id)) continue;
      const directConsumer = task.dependencies.includes(originalAuthor.id);
      if (
        !snapshot.artifacts.some(
          (a) => a.taskId === task.id && a.validity === 'current' && stale.has(a.versionId),
        ) &&
        !task.inputVersions.some((version) => stale.has(version)) &&
        !(directConsumer && (!task.inputVersions.length || !keepAuthor)) &&
        !task.dependencies.some((dependency) => replacements.has(dependency))
      )
        continue;
      if (
        task.kind === 'review' &&
        directConsumer &&
        task.dependencies.length === 1 &&
        (!keepAuthor || task.status === 'passed')
      ) {
        replacements.set(task.id, reviewer);
        reviewer.replacesTaskId ??= task.id;
        if (keepAuthor && task.status === 'passed') retainedReviews.add(task.id);
        reviewer.criterionIds = [...new Set([...reviewer.criterionIds, ...task.criterionIds])];
      } else {
        const fresh = freshTask(task, now);
        replacements.set(task.id, fresh);
        downstream.push(fresh);
        const outputs = snapshot.artifacts
          .filter((a) => a.taskId === task.id && a.validity === 'current')
          .map((a) => a.versionId);
        if (outputs.some((version) => !stale.has(version)))
          stale = artifactLineage(snapshot, [...stale, ...outputs]);
      }
      added = true;
    }
  } while (added);

  const replacedTasks = new Set(replacements.keys());
  if (!keepAuthor) replacedTasks.add(originalAuthor.id);
  const blockers = snapshot.requests.filter(
    (request) => request.status === 'open' && request.taskId && replacedTasks.has(request.taskId),
  );
  if (blockers.length) return { code: 'request_pending' };
  const current = snapshot.artifacts.filter((a) => a.validity === 'current');
  const replacedPaths = new Set(
    current.filter((a) => stale.has(a.versionId)).map((a) => pathComparisonKey(a.relativePath)),
  );
  const conflict = current.find(
    (a) => !stale.has(a.versionId) && replacedPaths.has(pathComparisonKey(a.relativePath)),
  );
  if (conflict) return { code: 'path_conflict', path: conflict.relativePath };

  for (const task of active) {
    const fresh = replacements.get(task.id);
    if (!fresh || fresh === reviewer) continue;
    fresh.dependencies = [];
    fresh.dependencyKinds = {};
    for (const dependency of task.dependencies) {
      const kind = task.dependencyKinds?.[dependency] ?? 'task_passed';
      if (dependency === originalAuthor.id) {
        // The original producer may still own sibling deliverables used by this consumer.
        if (keepAuthor) {
          fresh.dependencies.push(dependency);
          fresh.dependencyKinds[dependency] = kind;
        }
        if (!fresh.dependencies.includes(author.id)) fresh.dependencies.push(author.id);
        fresh.dependencyKinds[author.id] = 'task_passed';
      } else {
        const replacement = replacements.get(dependency)?.id ?? dependency;
        if (fresh.dependencies.includes(replacement)) continue;
        fresh.dependencies.push(replacement);
        fresh.dependencyKinds[replacement] =
          replacement !== dependency && task.kind !== 'review' ? 'task_passed' : kind;
        if (
          replacement === reviewer.id &&
          task.kind !== 'review' &&
          !fresh.dependencies.includes(author.id)
        ) {
          fresh.dependencies.push(author.id);
          fresh.dependencyKinds[author.id] = 'task_passed';
        }
      }
    }
  }

  for (const task of snapshot.tasks) {
    if (!replacedTasks.has(task.id) || retainedReviews.has(task.id)) continue;
    task.status = 'rework_required';
    task.updatedAt = now;
    task.step = 'Superseded by artifact rework';
  }
  for (const artifact of snapshot.artifacts)
    if (stale.has(artifact.versionId) && artifact.validity === 'current')
      artifact.validity = 'stale';
  const currentIds = new Set(
    snapshot.artifacts.filter((artifact) => artifact.validity === 'current').map((a) => a.id),
  );
  snapshot.commission.acceptedArtifactIds = snapshot.commission.acceptedArtifactIds.filter((id) =>
    currentIds.has(id),
  );
  snapshot.tasks.push(author, reviewer, ...downstream);
  return { task: author };
}

function freshTask(task: Task, now: string): Task {
  const { error: _error, artifactRework: _rework, ...copy } = structuredClone(task);
  return {
    ...copy,
    id: randomUUID(),
    replacesTaskId: task.id,
    kind: task.kind === 'office' ? 'implement' : task.kind,
    status: 'queued',
    inputVersions: [],
    outputArtifactIds: [],
    attempts: 0,
    step: 'Queued after artifact rework',
    createdAt: now,
    updatedAt: now,
  };
}
