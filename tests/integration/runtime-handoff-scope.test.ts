/** Loopback HTTP provider fixtures verify runtime handoff and review scope invariants, not real-model capability. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { waitForDelivery } from '../fixtures/wait-for-delivery';
import type { AgentIdentity, RuntimeOptions } from '../../packages/contracts/src/index';

const executor = createExecutor({ projectRoot: process.cwd() });
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const novaId = 'partner-30165261-f00f-4f96-9e13-88e46cf7cdd2';
const threePartners: AgentIdentity[] = [
  { id: 'mori', name: 'Mori', temperament: 'explorer' },
  { id: novaId, name: 'Nova', temperament: 'explorer' },
  { id: 'luma', name: 'Luma', temperament: 'organizer' },
];

const call = (name: string, args: unknown) => ({
  id: `${name}-${randomUUID()}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function toolReceipts(messages: any[]) {
  return messages
    .filter((m: any) => m.role === 'tool')
    .map((m: any) => {
      const sent = messages
        .flatMap((item: any) => item.tool_calls ?? [])
        .find((item: any) => item.id === m.tool_call_id);
      return { name: sent?.function.name, output: JSON.parse(m.content) };
    });
}

async function startServer(
  handler: (
    messages: any[],
    context: any,
    signal: AbortSignal,
  ) => Promise<ReturnType<typeof call>[]>,
) {
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    let body = '';
    for await (const chunk of req) body += chunk;
    if (abort.signal.aborted) return;
    const request = JSON.parse(body);
    const messages = request.messages;
    const first = JSON.parse(messages.find((m: any) => m.role === 'user').content);
    const calls = await handler(messages, first, abort.signal);
    if (abort.signal.aborted || res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

async function createTestRuntime(baseUrl: string) {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-handoff-')));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 5 }));
  const options: RuntimeOptions = {
    dataRoot,
    executor,
    getCredentials: async () => ({
      kind: 'openai-compatible',
      baseUrl,
      model: 'scripted-handoff-fixture',
      apiKey: 'test-only-secret',
    }),
  };
  const openRuntime = (): RuntimeService => {
    const runtime = createRuntime(options);
    cleanup.push(() => runtime.close());
    return runtime;
  };
  return { dataRoot, openRuntime };
}

it('waits for all multi-file author outputs and complete_task before starting an idle downstream consumer', async () => {
  const firstPublished = deferred();
  const allowSecondPublish = deferred();
  cleanup.push(async () => allowSecondPublish.resolve());
  const consumerContexts: any[] = [];

  const baseUrl = await startServer(async (messages, first) => {
    const receipts = toolReceipts(messages);
    if (!first.task) {
      return [
        call('propose_plan', {
          tasks: [
            {
              key: 'sources',
              title: 'Author brief and budget',
              description: 'Publish brief.md first and budget.csv second',
              kind: 'implement',
              agentId: 'mori',
              dependencies: [],
              criterionIds: ['c1'],
            },
            {
              key: 'render',
              title: 'Build combined deliverable',
              description: 'Consume brief.md and budget.csv and publish summary.md',
              kind: 'implement',
              agentId: novaId,
              dependencies: ['sources'],
              dependencyKinds: { sources: 'artifact_available' },
              criterionIds: ['c1'],
            },
            {
              key: 'review_sources',
              title: 'Review source files',
              description: 'Verify brief.md and budget.csv',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['sources'],
              dependencyKinds: { sources: 'artifact_available' },
              criterionIds: ['c1'],
            },
            {
              key: 'review_render',
              title: 'Review combined deliverable',
              description: 'Verify summary.md',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['render'],
              dependencyKinds: { render: 'artifact_available' },
              criterionIds: ['c1'],
            },
          ],
        }),
      ];
    }
    if (first.task.title === 'Author brief and budget') {
      if (!receipts.length) {
        return [
          call('workspace_write', { path: 'brief.md', content: '# 星岛验收\n\n第一阶段源稿。\n' }),
          call('submit_artifact', {
            path: 'brief.md',
            name: 'Brief',
            mediaType: 'text/markdown',
          }),
        ];
      }
      firstPublished.resolve();
      await allowSecondPublish.promise;
      return [
        call('workspace_write', {
          path: 'budget.csv',
          content: 'Item,Amount\nA,10\nB,20\nTotal,30\n',
        }),
        call('submit_artifact', {
          path: 'budget.csv',
          name: 'Budget',
          mediaType: 'text/csv',
        }),
        call('complete_task', { summary: 'Published brief.md and budget.csv' }),
      ];
    }
    if (first.task.title === 'Build combined deliverable') {
      if (!receipts.length) {
        consumerContexts.push(first);
        return [
          call('workspace_read', { path: 'brief.md' }),
          call('workspace_read', { path: 'budget.csv' }),
        ];
      }
      const briefText = receipts[0]?.output?.output ?? '';
      const budgetText = receipts[1]?.output?.output ?? '';
      return [
        call('workspace_write', {
          path: 'summary.md',
          content: `${briefText.trim()}\n\n${budgetText.trim()}\n`,
        }),
        call('submit_artifact', {
          path: 'summary.md',
          name: 'Combined summary',
          mediaType: 'text/markdown',
        }),
        call('complete_task', { summary: 'Published combined summary from both pinned inputs' }),
      ];
    }
    if (receipts.length < first.inputs.length) {
      return first.inputs.map((input: any) => call('workspace_read', { path: input.relativePath }));
    }
    return [
      call('submit_review', {
        verdict: 'pass',
        summary: 'Verified all pinned inputs',
        evidenceIds: receipts.map((r: any) => r.output.evidenceId).filter(Boolean),
        versionIds: first.expectedReviewVersionIds,
      }),
    ];
  });

  const { openRuntime } = await createTestRuntime(baseUrl);
  const runtime = openRuntime();
  await runtime.bootstrap();
  const workspace = await runtime.createWorkspace({ name: 'Multi-input handoff' });
  const submitted = await runtime.submit(
    {
      requestId: 'multi-input-handoff',
      workspaceId: workspace.id,
      goal: 'Publish brief.md and budget.csv, then combine them into summary.md',
      criteria: ['brief.md, budget.csv, and summary.md are independently verified'],
      planningMode: 'auto',
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 20, maxMinutes: 1, maxRework: 1 },
    },
    threePartners,
  );
  expect(submitted.ok).toBe(true);
  const id = submitted.commissionId!;

  await firstPublished.promise;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const midHandoff = await runtime.snapshot(id);
  expect(midHandoff.artifacts.map((a) => a.relativePath)).toEqual(['brief.md']);
  expect(midHandoff.tasks.find((t) => t.title === 'Author brief and budget')?.status).toBe(
    'running',
  );
  expect(midHandoff.tasks.find((t) => t.title === 'Build combined deliverable')).toMatchObject({
    status: 'queued',
    attempts: 0,
    inputVersions: [],
  });
  expect(midHandoff.tasks.find((t) => t.title === 'Review source files')).toMatchObject({
    status: 'queued',
    attempts: 0,
  });
  expect(consumerContexts).toHaveLength(0);

  allowSecondPublish.resolve();
  const delivered = await waitForDelivery(runtime, id);
  const brief = delivered.artifacts.find((a) => a.relativePath === 'brief.md')!;
  const budget = delivered.artifacts.find((a) => a.relativePath === 'budget.csv')!;
  const summary = delivered.artifacts.find((a) => a.relativePath === 'summary.md')!;
  const consumerTask = delivered.tasks.find((t) => t.title === 'Build combined deliverable')!;

  expect(consumerContexts).toHaveLength(1);
  expect(consumerTask.attempts).toBe(1);
  expect(consumerTask.inputVersions).toEqual([brief.versionId, budget.versionId]);
  expect(summary.inputVersions).toEqual([brief.versionId, budget.versionId]);
  expect(await readFile(join(workspace.workPath, 'summary.md'), 'utf8')).toContain('Total,30');
});

it('resumes cleanly after a restart between two submit_artifact calls without duplicating the first artifact', async () => {
  const firstPublished = deferred();
  let holdBeforeRestart = true;
  const authorContexts: any[] = [];

  const baseUrl = await startServer(async (messages, first, signal) => {
    const receipts = toolReceipts(messages);
    if (!first.task) {
      return [
        call('propose_plan', {
          tasks: [
            {
              key: 'sources',
              title: 'Author brief and budget',
              description: 'Publish brief.md and budget.csv',
              kind: 'implement',
              agentId: 'mori',
              dependencies: [],
              criterionIds: ['c1'],
            },
            {
              key: 'render',
              title: 'Consume both sources',
              description: 'Read brief.md and budget.csv and publish summary.md',
              kind: 'implement',
              agentId: novaId,
              dependencies: ['sources'],
              dependencyKinds: { sources: 'artifact_available' },
              criterionIds: ['c1'],
            },
            {
              key: 'review_sources',
              title: 'Review sources',
              description: 'Verify brief.md and budget.csv',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['sources'],
              dependencyKinds: { sources: 'artifact_available' },
              criterionIds: ['c1'],
            },
            {
              key: 'review_render',
              title: 'Review summary',
              description: 'Verify summary.md',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['render'],
              dependencyKinds: { render: 'artifact_available' },
              criterionIds: ['c1'],
            },
          ],
        }),
      ];
    }
    if (first.task.title === 'Author brief and budget') {
      if (!receipts.length) authorContexts.push(first);
      const briefAlreadyPublished =
        first.availableArtifacts.some(
          (a: any) => a.relativePath === 'brief.md' && a.validity === 'current',
        ) || receipts.some((r: any) => r.name === 'submit_artifact' && r.output?.ok);
      if (!briefAlreadyPublished) {
        return [
          call('workspace_write', {
            path: 'brief.md',
            content: '# 星岛续跑\n\n已保存首份源稿。\n',
          }),
          call('submit_artifact', {
            path: 'brief.md',
            name: 'Brief',
            mediaType: 'text/markdown',
          }),
        ];
      }
      if (holdBeforeRestart) {
        firstPublished.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return [];
      }
      return [
        call('workspace_write', {
          path: 'budget.csv',
          content: 'Item,Amount\nA,10\nB,25\nTotal,35\n',
        }),
        call('submit_artifact', {
          path: 'budget.csv',
          name: 'Budget',
          mediaType: 'text/csv',
        }),
        call('complete_task', {
          summary: 'Published remaining budget.csv and integrated both files',
        }),
      ];
    }
    if (first.task.title === 'Consume both sources') {
      if (!receipts.length) {
        return [
          call('workspace_read', { path: 'brief.md' }),
          call('workspace_read', { path: 'budget.csv' }),
        ];
      }
      return [
        call('workspace_write', {
          path: 'summary.md',
          content: `${receipts[0].output.output.trim()}\n${receipts[1].output.output.trim()}\n`,
        }),
        call('submit_artifact', {
          path: 'summary.md',
          name: 'Summary',
          mediaType: 'text/markdown',
        }),
        call('complete_task', { summary: 'Combined both sources after restart' }),
      ];
    }
    if (receipts.length < first.inputs.length) {
      return first.inputs.map((input: any) => call('workspace_read', { path: input.relativePath }));
    }
    return [
      call('submit_review', {
        verdict: 'pass',
        summary: 'Verified pinned files',
        evidenceIds: receipts.map((r: any) => r.output.evidenceId).filter(Boolean),
        versionIds: first.expectedReviewVersionIds,
      }),
    ];
  });

  const { openRuntime } = await createTestRuntime(baseUrl);
  const firstRuntime = openRuntime();
  await firstRuntime.bootstrap();
  const workspace = await firstRuntime.createWorkspace({ name: 'Restart mid-handoff' });
  const submitted = await firstRuntime.submit(
    {
      requestId: 'restart-mid-handoff',
      workspaceId: workspace.id,
      goal: 'Publish brief.md and budget.csv across a restart and combine them',
      criteria: ['Both sources and summary.md are verified without duplicate source versions'],
      planningMode: 'auto',
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 20, maxMinutes: 1, maxRework: 1 },
    },
    threePartners,
  );
  const id = submitted.commissionId!;

  await firstPublished.promise;
  const beforeClose = await firstRuntime.snapshot(id);
  expect(beforeClose.artifacts.map((a) => a.relativePath)).toEqual(['brief.md']);
  expect(beforeClose.tasks.find((t) => t.title === 'Consume both sources')?.attempts).toBe(0);

  await firstRuntime.close();
  holdBeforeRestart = false;

  const restarted = openRuntime();
  const recovered = await restarted.snapshot(id);
  expect(recovered.commission.status).toBe('paused');
  expect(recovered.requests.filter((r) => r.status === 'open')).toEqual([]);
  expect(recovered.tasks.find((t) => t.title === 'Author brief and budget')?.status).toBe('queued');
  expect(recovered.tasks.find((t) => t.title === 'Consume both sources')?.attempts).toBe(0);

  expect((await restarted.control(id, 'resume')).ok).toBe(true);
  const delivered = await waitForDelivery(restarted, id);

  expect(authorContexts).toHaveLength(2);
  expect(authorContexts[1].continuation.files).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: 'brief.md', status: 'present' })]),
  );
  expect(delivered.artifacts.filter((a) => a.relativePath === 'brief.md')).toHaveLength(1);
  expect(delivered.artifacts.filter((a) => a.relativePath === 'budget.csv')).toHaveLength(1);
  const brief = delivered.artifacts.find((a) => a.relativePath === 'brief.md')!;
  const budget = delivered.artifacts.find((a) => a.relativePath === 'budget.csv')!;
  const consumer = delivered.tasks.find((t) => t.title === 'Consume both sources')!;
  expect(consumer.inputVersions).toEqual([brief.versionId, budget.versionId]);
  expect(await readFile(join(workspace.workPath, 'summary.md'), 'utf8')).toContain('Total,35');
});

it('narrows reviewer artifact context and recovers in-place from out-of-scope or partial submit_review versionIds', async () => {
  let downstreamVersionId = '';
  const sourceReviewerPayloads: any[] = [];
  const mismatchReceipts: any[] = [];

  const baseUrl = await startServer(async (messages, first) => {
    const receipts = toolReceipts(messages);
    if (!first.task) {
      return [
        call('propose_plan', {
          tasks: [
            {
              key: 'sources',
              title: 'Write source files',
              description: 'Publish brief.md and budget.csv',
              kind: 'implement',
              agentId: 'mori',
              dependencies: [],
              criterionIds: ['c1'],
            },
            {
              key: 'renderer',
              title: 'Render downstream deliverable',
              description: 'Consume brief.md and budget.csv and publish deliverable.md',
              kind: 'implement',
              agentId: novaId,
              dependencies: ['sources'],
              dependencyKinds: { sources: 'artifact_available' },
              criterionIds: ['c1'],
            },
            {
              key: 'source_review',
              title: 'Review source files only',
              description: 'Independently verify brief.md and budget.csv',
              kind: 'review',
              agentId: novaId,
              dependencies: ['sources'],
              dependencyKinds: { sources: 'artifact_available' },
              criterionIds: ['c1'],
            },
            {
              key: 'renderer_review',
              title: 'Review downstream deliverable',
              description: 'Independently verify deliverable.md',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['renderer'],
              dependencyKinds: { renderer: 'artifact_available' },
              criterionIds: ['c1'],
            },
          ],
        }),
      ];
    }
    if (first.task.title === 'Write source files') {
      return [
        call('workspace_write', { path: 'brief.md', content: '# 星岛验收\n' }),
        call('submit_artifact', {
          path: 'brief.md',
          name: 'Brief',
          mediaType: 'text/markdown',
        }),
        call('workspace_write', { path: 'budget.csv', content: 'Item,Amount\nTotal,30\n' }),
        call('submit_artifact', {
          path: 'budget.csv',
          name: 'Budget',
          mediaType: 'text/csv',
        }),
        call('complete_task', { summary: 'Published brief.md and budget.csv' }),
      ];
    }
    if (first.task.title === 'Render downstream deliverable') {
      const published = receipts.find((r: any) => r.name === 'submit_artifact')?.output;
      if (published?.versionId) {
        downstreamVersionId = published.versionId;
        return [call('complete_task', { summary: 'Published deliverable.md' })];
      }
      return [
        call('workspace_write', {
          path: 'deliverable.md',
          content: '# Rendered deliverable\n合计：30\n',
        }),
        call('submit_artifact', {
          path: 'deliverable.md',
          name: 'Deliverable',
          mediaType: 'text/markdown',
        }),
      ];
    }
    if (first.task.title === 'Review source files only') {
      if (!receipts.length) {
        sourceReviewerPayloads.push(first);
        return first.inputs.map((input: any) =>
          call('workspace_read', { path: input.relativePath }),
        );
      }
      const readIds = receipts
        .filter((r: any) => r.name === 'workspace_read')
        .map((r: any) => r.output.evidenceId);
      const reviewAttempts = receipts.filter((r: any) => r.name === 'submit_review');
      if (reviewAttempts.length === 0) {
        return [
          call('submit_review', {
            verdict: 'pass',
            summary: 'Checked both source files (mistakenly attached downstream version)',
            evidenceIds: readIds,
            versionIds: [...first.inputs.map((a: any) => a.versionId), downstreamVersionId],
          }),
        ];
      }
      if (reviewAttempts.length === 1) {
        mismatchReceipts.push(reviewAttempts[0].output);
        return [
          call('submit_review', {
            verdict: 'pass',
            summary: 'Checked both source files (mistakenly omitted second version)',
            evidenceIds: readIds,
            versionIds: [first.inputs[0].versionId],
          }),
        ];
      }
      mismatchReceipts.push(reviewAttempts[1].output);
      return [
        call('submit_review', {
          verdict: 'pass',
          summary: 'Checked exact pinned source versions',
          evidenceIds: readIds,
          versionIds: reviewAttempts[1].output.expectedVersionIds,
        }),
      ];
    }
    if (!receipts.length) {
      return first.inputs.map((input: any) => call('workspace_read', { path: input.relativePath }));
    }
    return [
      call('submit_review', {
        verdict: 'pass',
        summary: 'Verified downstream deliverable',
        evidenceIds: receipts.map((r: any) => r.output.evidenceId).filter(Boolean),
        versionIds: first.expectedReviewVersionIds,
      }),
    ];
  });

  const { openRuntime } = await createTestRuntime(baseUrl);
  const runtime = openRuntime();
  await runtime.bootstrap();
  const workspace = await runtime.createWorkspace({ name: 'Review scope recovery' });
  const submitted = await runtime.submit(
    {
      requestId: 'review-scope-recovery',
      workspaceId: workspace.id,
      goal: 'Author two sources, render deliverable.md, and independently review all outputs',
      criteria: ['All source and rendered deliverables pass independent review'],
      planningMode: 'auto',
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 10, maxMinutes: 1, maxRework: 0 },
    },
    threePartners,
  );
  const id = submitted.commissionId!;

  const delivered = await waitForDelivery(runtime, id);
  const brief = delivered.artifacts.find((a) => a.relativePath === 'brief.md')!;
  const budget = delivered.artifacts.find((a) => a.relativePath === 'budget.csv')!;
  const deliverable = delivered.artifacts.find((a) => a.relativePath === 'deliverable.md')!;

  expect(downstreamVersionId).toBe(deliverable.versionId);
  expect(sourceReviewerPayloads).toHaveLength(1);
  expect(sourceReviewerPayloads[0].availableArtifacts.map((a: any) => a.relativePath)).toEqual([
    'brief.md',
    'budget.csv',
  ]);
  expect(sourceReviewerPayloads[0].expectedReviewVersionIds).toEqual([
    brief.versionId,
    budget.versionId,
  ]);
  expect(mismatchReceipts).toEqual([
    expect.objectContaining({
      ok: false,
      code: 'REVIEW_VERSION_SCOPE_MISMATCH',
      expectedVersionIds: [brief.versionId, budget.versionId],
    }),
    expect.objectContaining({
      ok: false,
      code: 'REVIEW_VERSION_SCOPE_MISMATCH',
      expectedVersionIds: [brief.versionId, budget.versionId],
    }),
  ]);
  const sourceReviewTask = delivered.tasks.find((t) => t.title === 'Review source files only')!;
  expect(sourceReviewTask.attempts).toBe(1);
  expect(sourceReviewTask.status).toBe('passed');
  expect(delivered.commission.stepsUsed).toBe(10);
  expect(await runtime.accept(id, [brief.id, budget.id, deliverable.id])).toMatchObject({
    ok: true,
  });
  expect((await runtime.snapshot(id)).commission.status).toBe('accepted');
});
