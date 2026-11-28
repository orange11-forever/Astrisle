import { expect, it } from 'vitest';
import { agentsFromCharacters, validatePlan, ready } from '../../packages/domain/src/index';
import type { ProjectSnapshot, Task } from '../../packages/contracts/src/index';
const criteria = [{ id: 'c1', description: 'working files' }];
const valid = [
  {
    key: 'build',
    title: 'Build',
    description: 'Create project',
    kind: 'implement',
    agentId: 'mori',
    dependencies: [],
    criterionIds: ['c1'],
  },
  {
    key: 'check',
    title: 'Review',
    description: 'Verify actual files',
    kind: 'review',
    agentId: 'luma',
    dependencies: ['build'],
    dependencyKinds: { build: 'artifact_available' },
    criterionIds: ['c1'],
  },
];
it('validates a dynamic two-agent DAG and rejects self-review, cycles and uncovered criteria', () => {
  expect(validatePlan(valid, criteria)).toHaveLength(2);
  expect(() =>
    validatePlan(
      valid.map((t) => ({ ...t, agentId: 'mori' })),
      criteria,
    ),
  ).toThrow();
  expect(() =>
    validatePlan(
      valid.map((t) => (t.key === 'build' ? { ...t, dependencies: ['check'] } : t)),
      criteria,
    ),
  ).toThrow();
  expect(() => validatePlan(valid, [...criteria, { id: 'c2', description: 'missing' }])).toThrow();
});
it('restricts assignments to the commissioned partners and rejects any self-reviewed input', () => {
  const id = 'partner-30165261-f00f-4f96-9e13-88e46cf7cdd2';
  const roster = agentsFromCharacters([
    { id: 'mori', displayName: 'Renamed Mori' },
    { id: 'luma', displayName: 'Luma' },
    { id: 'user', displayName: 'Player' },
    { id, displayName: 'Nova' },
  ]);
  expect(roster).toEqual([
    { id: 'mori', name: 'Renamed Mori', temperament: 'explorer' },
    { id: 'luma', name: 'Luma', temperament: 'organizer' },
    { id, name: 'Nova', temperament: 'explorer' },
  ]);
  const newcomer = { ...valid[0], key: 'second', agentId: id };
  for (const agentId of ['user', 'partner-unknown'])
    expect(() =>
      validatePlan([{ ...newcomer, key: 'build', agentId }, valid[1]], criteria, roster),
    ).toThrow();
  const independent = { ...valid[1], dependencies: ['build', 'second'] };
  const mixed = { ...independent, key: 'mixed', agentId: id };
  expect(validatePlan([valid[0], newcomer, independent], criteria, roster)).toHaveLength(3);
  expect(() => validatePlan([valid[0], newcomer, independent, mixed], criteria, roster)).toThrow(
    /own work/,
  );
});
it('normalizes direct review dependencies so author review cannot deadlock on task_passed', () => {
  const plan = valid.map((t) => ({ ...t, dependencyKinds: undefined }));
  expect(validatePlan(plan, criteria)[1].dependencyKinds?.build).toBe('artifact_available');
  const explicit = valid.map((t) => ({
    ...t,
    dependencyKinds: t.kind === 'review' ? { build: 'task_passed' } : undefined,
  }));
  expect(validatePlan(explicit, criteria)[1].dependencyKinds?.build).toBe('artifact_available');
});
it('requires direct independent review of preparatory outputs instead of transitive coverage', () => {
  const research = { ...valid[0], key: 'research', title: 'Read inputs', kind: 'investigate' };
  const build = { ...valid[0], dependencies: ['research'] };
  expect(() => validatePlan([research, build, valid[1]], criteria)).toThrow(/direct/i);
});
it('rejects implicit review deadlocks and accepts a review before the next author', () => {
  const research = { ...valid[0], key: 'research', title: 'Read inputs', kind: 'investigate' };
  const build = { ...valid[0], dependencies: ['research'] };
  const lateReview = { ...valid[1], dependencies: ['research', 'build'] };
  expect(() => validatePlan([research, build, lateReview], criteria)).toThrow(/deadlock/i);
  const earlyReview = {
    ...valid[1],
    key: 'review-research',
    dependencies: ['research'],
    dependencyKinds: undefined,
  };
  expect(validatePlan([research, earlyReview, build, valid[1]], criteria)).toHaveLength(4);
  expect(
    validatePlan(
      [research, { ...build, dependencyKinds: { research: 'artifact_available' } }, lateReview],
      criteria,
    ),
  ).toHaveLength(3);
});
it('waits for a complete author handoff before starting review or downstream artifact_available tasks', () => {
  const author: Task = {
    id: 'build',
    kind: 'implement',
    status: 'running',
    outputArtifactIds: ['one-draft', 'one'],
    commissionId: 'c',
    agentId: 'mori',
    title: 'Build',
    description: 'Create files',
    dependencies: [],
    criterionIds: ['c1'],
    inputVersions: [],
    step: 'Working',
    attempts: 1,
    createdAt: '',
    updatedAt: '',
  };
  const reviewer: Task = {
    ...author,
    id: 'review',
    agentId: 'luma',
    kind: 'review',
    status: 'queued',
    dependencies: ['build'],
    dependencyKinds: { build: 'artifact_available' },
    outputArtifactIds: [],
  };
  const consumer: Task = {
    ...reviewer,
    id: 'render',
    agentId: 'nova',
    kind: 'implement',
  };
  const strictConsumer: Task = {
    ...consumer,
    id: 'strict-render',
    dependencyKinds: { build: 'task_passed' },
  };
  const snapshot = {
    tasks: [author, reviewer, consumer, strictConsumer],
    artifacts: [
      { id: 'one-draft', validity: 'stale' },
      { id: 'one', validity: 'current' },
    ],
  } as ProjectSnapshot;
  expect(ready(reviewer, snapshot)).toBe(false);
  expect(ready(consumer, snapshot)).toBe(false);
  expect(ready({ ...consumer, kind: 'investigate' }, snapshot)).toBe(false);
  expect(ready({ ...consumer, kind: 'integrate' }, snapshot)).toBe(false);
  author.outputArtifactIds.push('two');
  snapshot.artifacts.push({ id: 'two', validity: 'current' } as ProjectSnapshot['artifacts'][0]);
  expect(ready(consumer, snapshot)).toBe(false);
  author.status = 'awaiting_review';
  expect(ready(reviewer, snapshot)).toBe(true);
  expect(ready(consumer, snapshot)).toBe(true);
  expect(ready(strictConsumer, snapshot)).toBe(false);
  author.status = 'passed';
  expect(ready(strictConsumer, snapshot)).toBe(true);
  author.status = 'failed';
  expect(ready(reviewer, snapshot)).toBe(false);
  expect(ready(consumer, snapshot)).toBe(false);
});
