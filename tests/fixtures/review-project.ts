import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishArtifact } from '../../packages/artifacts/src/index';
import type { ProjectSnapshot, Task } from '../../packages/contracts/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { createWorkspaceStorage } from '../../packages/workspace/src/index';

const commissionId = 'desktop-artifact-review';
const authorId = 'initial-author';
const reviewId = 'initial-review';
const file = 'draft.md';
const originalText = '# Original title\n\nOriginal draft marker.\n';
const initialText = '# Reviewed title\n\nReviewed draft marker.\n';

export const reviewProject = { commissionId, authorId, reviewId, file, originalText };

export async function seedReview(dataRoot: string) {
  const workspace = await createWorkspaceStorage({ name: '成果验收岛' }, dataRoot);
  const source = join(workspace.workPath, file);
  const publish = async (text: string) => {
    await writeFile(source, text);
    return publishArtifact(dataRoot, workspace.workPath, file, {
      commissionId,
      taskId: authorId,
      name: file,
      mediaType: 'text/markdown',
      inputVersions: [],
    });
  };
  const original = await publish(originalText);
  original.validity = 'stale';
  const current = await publish(initialText);
  current.previousVersionId = original.versionId;
  const now = new Date().toISOString();
  const author: Task = {
    id: authorId,
    commissionId,
    agentId: 'mori',
    kind: 'implement',
    title: '起草项目说明',
    description: '更新源稿并提交',
    status: 'passed',
    dependencies: [],
    criterionIds: ['c1'],
    inputVersions: [],
    outputArtifactIds: [current.id],
    step: '已提交源稿',
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  };
  const reviewer: Task = {
    ...author,
    id: reviewId,
    agentId: 'luma',
    kind: 'review',
    title: '复核项目说明',
    description: '读取并核对源稿',
    dependencies: [author.id],
    inputVersions: [current.versionId],
    outputArtifactIds: [],
    step: '已复核源稿',
  };
  const snapshot: ProjectSnapshot = {
    workspace,
    agents: [],
    tasks: [author, reviewer],
    artifacts: [original, current],
    evidence: [
      {
        id: 'initial-review-evidence',
        taskId: reviewer.id,
        kind: 'review',
        summary: '初稿已经过复核',
        detail: JSON.stringify({ verdict: 'pass' }),
        status: 'passed',
        artifactVersionIds: [current.versionId],
        createdAt: now,
      },
    ],
    requests: [],
    events: [],
    lastSequence: 0,
    commission: {
      id: commissionId,
      workspaceId: workspace.id,
      title: '项目说明验收',
      goal: '提交经过复核的项目说明',
      criteria: [{ id: 'c1', description: '项目说明符合本轮要求' }],
      status: 'awaiting_acceptance',
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 30, maxMinutes: 2, maxRework: 2 },
      revision: 1,
      planningMode: 'auto',
      stepsUsed: 0,
      acceptedArtifactIds: [],
      summary: '等候验收',
      createdAt: now,
      updatedAt: now,
    },
  };
  const store = new RuntimeStore(dataRoot);
  try {
    store.addWorkspace(workspace);
    store.save(snapshot);
  } finally {
    store.close();
  }
  return { original, current };
}
