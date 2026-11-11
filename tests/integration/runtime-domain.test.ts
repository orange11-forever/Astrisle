import { expect, it } from 'vitest';
import { validatePlan } from '../../packages/domain/src/index';
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
it('normalizes direct review dependencies so author review cannot deadlock on task_passed', () => {
  const plan = valid.map((t) => ({ ...t, dependencyKinds: undefined }));
  expect(validatePlan(plan, criteria)[1].dependencyKinds?.build).toBe('artifact_available');
  const explicit = valid.map((t) => ({
    ...t,
    dependencyKinds: t.kind === 'review' ? { build: 'task_passed' } : undefined,
  }));
  expect(validatePlan(explicit, criteria)[1].dependencyKinds?.build).toBe('artifact_available');
});
