import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Scope, ToolExecutor } from '../../packages/contracts/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { createRuntime } from '../../packages/runtime/src/index';
import { waitForDelivery } from '../fixtures/wait-for-delivery';

const searchEndpoint = 'https://lookup.example/search';
const firstUrl = 'https://sources.example/report';
const firstFinalUrl = 'https://sources.example/2026/report';
const secondUrl = 'https://sources.example/data';
const missingUrl = 'https://sources.example/missing';
const emptyUrl = 'https://sources.example/empty';
const privateUrl = 'https://sources.example/redirect-with-token';
const scope = {
  readRoots: [],
  writeRoots: [],
  allowProcess: false,
  allowNetwork: true,
  allowedHosts: ['sources.example'],
  searchEndpoint,
};
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const call = (name: string, args: Record<string, unknown>) => ({
  id: randomUUID(),
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

async function fixture(
  reviewMode:
    | 'complete'
    | 'skip_second'
    | 'reuse_author'
    | 'blank'
    | 'stale'
    | 'republish'
    | 'repair'
    | 'outage'
    | 'automatic'
    | 'targeted' = 'complete',
  permission: Scope = scope,
  planningMode: 'auto' | 'review_first' = 'auto',
) {
  const workspaceTools = createExecutor({ projectRoot: process.cwd() });
  const reviewTasks = new Set<string>();
  let sourceAvailable = reviewMode !== 'outage';
  // Only the network boundary is scripted here. Workspace isolation, provider protocol,
  // receipts, rework, and review use the production implementations.
  const executor: ToolExecutor = {
    ...workspaceTools,
    definitions: () => [
      ...workspaceTools.definitions().filter((tool) => tool.name !== 'web_search'),
      {
        name: 'web_search',
        effect: 'network',
        description: 'Find leads',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
    execute: async (name, args, context) => {
      if (name === 'web_search')
        return { ok: true, output: JSON.stringify([{ url: firstUrl }, { url: secondUrl }]) };
      if (name === 'web_read') {
        const outage =
          args.url === secondUrl && !sourceAvailable && reviewTasks.has(context.taskId);
        const blank =
          args.url === emptyUrl ||
          (args.url === secondUrl && reviewMode === 'blank' && reviewTasks.has(context.taskId));
        return {
          ok: args.url !== missingUrl && !outage,
          output: blank ? '   \n' : 'Untrusted source content',
          metadata: {
            url:
              args.url === firstUrl
                ? firstFinalUrl
                : args.url === privateUrl
                  ? 'https://sources.example/redirected?access_token=private-test-value'
                  : args.url,
            status: outage ? 503 : args.url === missingUrl ? 404 : 200,
          },
        };
      }
      return workspaceTools.execute(name, args, context);
    },
  };
  const requests: any[] = [];
  const authorReadsByTask = new Map<string, string[]>();
  const reviewerReadsByTask = new Map<string, string[]>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const request = JSON.parse(raw);
    requests.push(request);
    const messages = request.messages;
    const first = JSON.parse(messages.find((m: any) => m.role === 'user').content);
    const receipts = messages
      .filter((m: any) => m.role === 'tool')
      .map((m: any) => {
        const sent = messages
          .flatMap((item: any) => item.tool_calls ?? [])
          .find((item: any) => item.id === m.tool_call_id);
        return { name: sent?.function.name, output: JSON.parse(m.content) };
      });
    let calls;
    if (!first.task) {
      calls = [
        call('propose_plan', {
          tasks: [
            {
              key: 'author',
              title: 'Research the subject',
              description: 'Research original documents and publish the findings in report.md',
              kind: ['targeted', 'republish', 'automatic'].includes(reviewMode)
                ? 'implement'
                : 'investigate',
              agentId: 'mori',
              dependencies: [],
              criterionIds: ['c1'],
            },
            {
              key: 'review',
              title: 'Verify report and sources',
              description: 'Verify the report against the original documents',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['author'],
              dependencyKinds: { author: 'artifact_available' },
              criterionIds: ['c1'],
            },
          ],
        }),
      ];
    } else if (first.task.kind !== 'review') {
      const publish = (sourceEvidenceIds?: string[]) =>
        call('submit_artifact', {
          path: 'report.md',
          name: 'Research report',
          mediaType: 'text/markdown',
          ...(sourceEvidenceIds && { sourceEvidenceIds }),
        });
      if (!receipts.length)
        calls = [
          ...(['republish', 'automatic'].includes(reviewMode)
            ? []
            : [call('web_search', { query: 'Original documents' })]),
          call('web_read', { url: firstUrl }),
          call('web_read', { url: secondUrl }),
          call('web_read', { url: missingUrl }),
          call('web_read', { url: emptyUrl }),
          call('web_read', { url: privateUrl }),
          call('workspace_write', {
            path: 'report.md',
            content: `# ${first.task.artifactRework || first.task.title.startsWith('Rework:') ? 'Updated research report' : 'Research report'}\n\nSources: [Report](${firstFinalUrl}), [Data](${secondUrl})\n`,
          }),
        ];
      else {
        const search = receipts.find((r: any) => r.name === 'web_search')?.output;
        const reads = receipts.filter((r: any) => r.name === 'web_read');
        const earlierAuthorReads = [...authorReadsByTask.values()][0];
        const currentAuthorReads = reads.slice(0, 2).map((r: any) => r.output.evidenceId);
        authorReadsByTask.set(first.task.id, currentAuthorReads);
        calls =
          reviewMode === 'republish'
            ? [
                publish(currentAuthorReads),
                call('workspace_write', {
                  path: 'report.md',
                  content: `# Revised report\n\n[Report](${firstFinalUrl}), [Data](${secondUrl})\n`,
                }),
                publish(),
                publish(currentAuthorReads),
                call('complete_task', { summary: 'Published the revised sourced report' }),
              ]
            : [
                ...(!['targeted', 'automatic'].includes(reviewMode) || earlierAuthorReads
                  ? [publish()]
                  : []),
                publish(['fabricated-evidence-id']),
                ...(search?.evidenceId ? [publish([search.evidenceId])] : []),
                publish([reads[2].output.evidenceId]),
                publish([reads[3].output.evidenceId]),
                publish([reads[4].output.evidenceId]),
                ...(earlierAuthorReads ? [publish(earlierAuthorReads)] : []),
                publish(currentAuthorReads),
                call('complete_task', { summary: 'Published the sourced report' }),
              ];
      }
    } else {
      reviewTasks.add(first.task.id);
      if (!receipts.length)
        calls = [
          call('workspace_read', { path: 'report.md' }),
          ...(reviewMode === 'reuse_author'
            ? []
            : [
                call('web_read', { url: firstFinalUrl }),
                ...(['skip_second', 'repair'].includes(reviewMode)
                  ? []
                  : [call('web_read', { url: secondUrl })]),
              ]),
        ];
      else {
        const readIds = receipts
          .filter((r: any) => r.name === 'web_read')
          .map((r: any) => r.output.evidenceId);
        const earlierReadIds = reviewerReadsByTask.get(first.task.id);
        const rejected = receipts.some((r: any) => r.name === 'submit_review' && !r.output.ok);
        if (!rejected) reviewerReadsByTask.set(first.task.id, readIds);
        if (rejected && reviewMode === 'repair' && readIds.length === 1) {
          calls = [call('web_read', { url: secondUrl })];
        } else {
          const unable = (rejected && reviewMode !== 'repair') || !sourceAvailable;
          calls = [
            call('submit_review', {
              verdict: unable
                ? 'unable_to_verify'
                : ['stale', 'automatic'].includes(reviewMode) && !earlierReadIds
                  ? 'changes_requested'
                  : 'pass',
              summary: unable ? 'A required source could not be verified' : 'Checked the findings',
              versionIds: first.inputs.map((input: any) => input.versionId),
              evidenceIds: [
                receipts.find((r: any) => r.name === 'workspace_read').output.evidenceId,
                ...(reviewMode === 'reuse_author'
                  ? authorReadsByTask.get(first.task.dependencies[0])!
                  : reviewMode === 'stale' && earlierReadIds
                    ? earlierReadIds
                    : readIds),
              ],
            }),
          ];
        }
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: calls } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-research-')));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 5 }));
  const { port } = server.address() as { port: number };
  const runtime = createRuntime({
    dataRoot,
    executor,
    getCredentials: async () => ({
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'scripted-model',
      apiKey: 'test-credential',
    }),
  });
  cleanup.push(() => runtime.close());
  const workspace = await runtime.createWorkspace({ name: 'Web research fixture' });
  const response = await runtime.submit({
    requestId: randomUUID(),
    workspaceId: workspace.id,
    goal: 'Research original documents online and write the findings',
    criteria: ['The findings cite original documents and are independently verified'],
    planningMode,
    scope: permission,
    budget: { maxSteps: 20, maxMinutes: 1, maxRework: 1 },
  });
  expect(response.ok).toBe(true);
  return {
    runtime,
    id: response.commissionId!,
    requests,
    restoreSource: () => {
      sourceAvailable = true;
    },
  };
}

it('binds only successful original reads to the published report and verifies both final URLs', async () => {
  const { runtime, id, requests } = await fixture();
  const snapshot = await waitForDelivery(runtime, id);
  const [report] = snapshot.artifacts;
  expect(snapshot.artifacts).toHaveLength(1);
  expect(report.webSources).toEqual([
    { url: firstFinalUrl, evidenceId: expect.any(String) },
    { url: secondUrl, evidenceId: expect.any(String) },
  ]);
  const authorTurn = requests.find((request) =>
    request.tools?.some((tool: any) => tool.function.name === 'submit_artifact'),
  );
  expect(authorTurn.tools.map((tool: any) => tool.function.name)).toContain('web_search');
  const planner = JSON.parse(requests[0].messages[1].content);
  expect(planner.tools.some((tool: any) => tool.name === 'web_search')).toBe(true);
  expect(JSON.stringify(requests)).not.toContain(searchEndpoint);
});

it.each(['skip_second', 'reuse_author', 'blank', 'stale'] as const)(
  'requires independent source receipts for the exact reviewed version (%s)',
  async (mode) => {
    const { runtime, id } = await fixture(mode);
    const snapshot = await vi.waitFor(
      async () => {
        const current = await runtime.snapshot(id);
        expect(['awaiting_acceptance', 'paused']).toContain(current.commission.status);
        return current;
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(snapshot.commission.status, snapshot.commission.summary).toBe('paused');
    expect(snapshot.evidence.filter((e) => e.kind === 'review').at(-1)?.status).toBe('not_run');
    if (mode === 'stale') {
      expect(snapshot.artifacts.map((a) => a.validity)).toEqual(['stale', 'current']);
      expect(snapshot.artifacts[1].webSources).toHaveLength(2);
    }
  },
);

it('preserves source requirements when a sourced implementation deliverable is reworked', async () => {
  const { runtime, id } = await fixture('targeted');
  const initial = await waitForDelivery(runtime, id);
  const [report] = initial.artifacts;
  await vi.waitFor(async () => {
    const result = await runtime.requestArtifactRework({
      commissionId: id,
      artifactId: report.id,
      versionId: report.versionId,
      revision: initial.commission.revision,
      instruction: 'Update the report title',
      requestId: 'targeted-sourced-report',
    });
    expect(result.ok, result.message).toBe(true);
  });
  const updated = await waitForDelivery(runtime, id);
  expect(updated.artifacts).toHaveLength(2);
  const replacement = updated.artifacts.find((item) => item.previousVersionId === report.versionId);
  expect(replacement?.validity).toBe('current');
  expect(replacement?.webSources?.map((source) => source.url)).toEqual([firstFinalUrl, secondUrl]);
  expect(replacement?.webSources?.map((source) => source.evidenceId)).not.toEqual(
    report.webSources?.map((source) => source.evidenceId),
  );
});

it('requires source receipts on same-task republication after a direct web read', async () => {
  const { runtime, id } = await fixture('republish', { ...scope, searchEndpoint: undefined });
  const snapshot = await waitForDelivery(runtime, id);
  expect(snapshot.artifacts).toHaveLength(2);
  const [original, revised] = snapshot.artifacts;
  expect(revised).toMatchObject({
    previousVersionId: original.versionId,
    taskId: original.taskId,
    validity: 'current',
    webSources: original.webSources,
  });
  expect(original.validity).toBe('stale');
  expect(revised.sha256).not.toBe(original.sha256);
  expect((await runtime.artifact(revised.id)).content).toContain('# Revised report');
  expect(snapshot.evidence.find((e) => e.kind === 'review')?.artifactVersionIds).toEqual([
    revised.versionId,
  ]);
});

it('preserves a directly sourced artifact family through changes_requested rework', async () => {
  const { runtime, id } = await fixture('automatic', { ...scope, searchEndpoint: undefined });
  const snapshot = await waitForDelivery(runtime, id);
  expect(snapshot.artifacts).toHaveLength(2);
  const [original, revised] = snapshot.artifacts;
  expect(revised).toMatchObject({ previousVersionId: original.versionId, validity: 'current' });
  expect(revised.taskId).not.toBe(original.taskId);
  expect(revised.webSources?.map((source) => source.url)).toEqual([firstFinalUrl, secondUrl]);
  expect(revised.webSources?.map((source) => source.evidenceId)).not.toEqual(
    original.webSources?.map((source) => source.evidenceId),
  );
  expect(snapshot.evidence.filter((e) => e.kind === 'review').at(-1)?.artifactVersionIds).toEqual([
    revised.versionId,
  ]);
});

it('lets the reviewer add the omitted read and retry a pass in the same task', async () => {
  const { runtime, id, requests } = await fixture('repair');
  const snapshot = await waitForDelivery(runtime, id);
  const reviews = snapshot.evidence.filter((e) => e.kind === 'review');
  expect(reviews).toHaveLength(1);
  expect(reviews[0].status).toBe('passed');
  expect(snapshot.tasks.find((task) => task.id === reviews[0].taskId)?.attempts).toBe(1);
  const cited = JSON.parse(reviews[0].detail).evidenceIds as string[];
  const citedReads = snapshot.evidence
    .filter((evidence) => evidence.taskId === reviews[0].taskId && cited.includes(evidence.id))
    .map((evidence) => JSON.parse(evidence.detail))
    .filter((receipt) => receipt.name === 'web_read');
  expect(citedReads.map((receipt) => receipt.result.metadata.url)).toEqual([
    firstFinalUrl,
    secondUrl,
  ]);
  expect(
    requests.some((request) =>
      request.messages.some(
        (message: any) =>
          message.role === 'tool' &&
          JSON.parse(message.content).code === 'WEB_SOURCE_REVIEW_REQUIRED',
      ),
    ),
  ).toBe(true);
});

it('retries an unavailable source review only after the user resumes it', async () => {
  const { runtime, id, restoreSource } = await fixture('outage');
  const paused = await vi.waitFor(
    async () => {
      const snapshot = await runtime.snapshot(id);
      expect(snapshot.commission.status).toBe('paused');
      return snapshot;
    },
    { interval: 100, timeout: 5_000 },
  );
  const reviewer = paused.tasks.find((task) => task.kind === 'review')!;
  expect(paused.evidence.find((e) => e.kind === 'review')?.status).toBe('not_run');
  expect(reviewer.attempts).toBe(1);
  expect(
    paused.evidence
      .filter((e) => e.taskId === reviewer.id && e.status === 'failed')
      .some((e) => JSON.parse(e.detail).result.metadata.status === 503),
  ).toBe(true);
  restoreSource();
  expect((await runtime.control(id, 'resume')).ok).toBe(true);
  const delivered = await waitForDelivery(runtime, id);
  expect(delivered.artifacts.map((artifact) => artifact.versionId)).toEqual(
    paused.artifacts.map((artifact) => artifact.versionId),
  );
  expect(delivered.evidence.filter((e) => e.kind === 'review').map((e) => e.status)).toEqual([
    'not_run',
    'passed',
  ]);
  expect(delivered.tasks.find((task) => task.id === reviewer.id)?.attempts).toBe(2);
});

it.each([
  { allowNetwork: false },
  { searchEndpoint: undefined },
  { searchEndpoint: 'file:///not-a-search-service' },
  { allowedHosts: [] },
  { allowedHosts: ['https://sources.example/report'] },
])(
  'omits web_search from the planner tools without an authorized configuration (%j)',
  async (permission) => {
    const { runtime, id, requests } = await fixture(
      'complete',
      { ...scope, ...permission },
      'review_first',
    );
    await vi.waitFor(
      async () => expect((await runtime.snapshot(id)).commission.status).toBe('paused'),
      { timeout: 15_000, interval: 100 },
    );
    const planner = JSON.parse(requests[0].messages[1].content);
    expect(planner.tools.some((tool: any) => tool.name === 'web_search')).toBe(false);
  },
);
