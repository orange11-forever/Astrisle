/** A scripted loopback HTTP provider tests protocol and runtime state. It is not real-model validation. */
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime, type RuntimeService } from '../../packages/runtime/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import type {
  ProjectSnapshot,
  RuntimeOptions,
  ToolExecutor,
} from '../../packages/contracts/src/index';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const call = (name: string, args: unknown) => ({
  id: `${name}-${Math.random()}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
async function fixture(
  mode:
    | 'normal'
    | 'rework'
    | 'weak'
    | 'mutate'
    | 'forge'
    | 'process'
    | 'extra'
    | 'targeted'
    | 'targeted_chain'
    | 'native'
    | 'native_single'
    | 'collision'
    | 'process_tree' = 'normal',
  overrides: {
    executor?: ToolExecutor;
    maxSteps?: number;
    maxRework?: number;
    beforeAuthorActions?: (goal: string) => Promise<void>;
    beforeReviewSubmit?: (inputs: ProjectSnapshot['artifacts']) => Promise<void>;
    seed?: Record<string, string>;
    processArgs?: string[];
  } = {},
) {
  const native = mode === 'native' || mode === 'native_single';
  const chained = mode === 'targeted_chain';
  const linked = mode === 'targeted' || mode === 'native' || mode === 'collision' || chained;
  const sourcePath = native ? 'draft.md' : 'result.txt';
  const derivedPath = native ? 'memo.docx' : mode === 'collision' ? sourcePath : 'derived.txt';
  const renderAndPublish = () => [
    call('render_source', { source: sourcePath, output: derivedPath }),
    call('submit_artifact', {
      path: derivedPath,
      name: 'Generated memo',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  ];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body),
      messages = request.messages;
    const first = JSON.parse(messages.find((m: any) => m.role === 'user').content);
    let calls: any[];
    if (!first.task)
      calls = [
        call('propose_plan', {
          tasks: [
            {
              key: 'author',
              title: 'Create real file',
              description: `Write ${sourcePath} and publish it`,
              kind: 'implement',
              agentId: 'mori',
              dependencies: [],
              criterionIds: ['c1'],
            },
            {
              key: 'review',
              title: 'Read and verify',
              description: 'Read exact published input and check content',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['author'],
              dependencyKinds: { author: 'artifact_available' },
              criterionIds: ['c1'],
            },
            ...(linked
              ? [
                  {
                    key: 'consumer',
                    title: 'Build downstream result',
                    description: `Read ${sourcePath} and publish ${derivedPath}`,
                    kind: 'implement',
                    agentId: 'mori',
                    dependencies: mode === 'collision' ? [] : ['author', 'review'],
                    criterionIds: ['c1'],
                  },
                  {
                    key: 'consumer_review',
                    title: 'Verify downstream result',
                    description: 'Read exact published downstream result',
                    kind: 'review',
                    agentId: 'luma',
                    dependencies: ['consumer'],
                    criterionIds: ['c1'],
                  },
                  ...(chained
                    ? [
                        {
                          key: 'tail',
                          title: 'Build last dependent result',
                          description: 'Consume derived.txt and publish tail.txt',
                          kind: 'implement',
                          agentId: 'mori',
                          dependencies: ['consumer'],
                          dependencyKinds: { consumer: 'artifact_available' },
                          criterionIds: ['c1'],
                        },
                        {
                          key: 'tail_review',
                          title: 'Verify last dependent result',
                          description: 'Read exact published tail result',
                          kind: 'review',
                          agentId: 'luma',
                          dependencies: ['tail'],
                          criterionIds: ['c1'],
                        },
                      ]
                    : []),
                ]
              : []),
          ],
        }),
      ];
    else if (first.task.kind !== 'review') {
      await overrides.beforeAuthorActions?.(first.goal);
      if (mode === 'process_tree') {
        calls = [call('process_run', { command: process.execPath, args: overrides.processArgs })];
      } else if (mode === 'native' && first.task.title === 'Build downstream result') {
        calls = [
          ...renderAndPublish(),
          call('complete_task', { summary: 'Published the rendered document' }),
        ];
      } else if (
        ['mutate', 'extra'].includes(mode) &&
        messages.some((m: any) => m.role === 'tool')
      ) {
        calls = [
          call('ask_input', {
            title: 'Published copy differs',
            detail: 'Need to republish changed bytes',
            kind: 'input',
          }),
        ];
      } else {
        let content =
          mode === 'rework' && !first.task.title.startsWith('Rework:')
            ? 'incorrect'
            : 'verified result';
        if (native)
          content = first.task.artifactRework
            ? '# Revised memo\n\nNew text.'
            : '# Memo\n\nInitial text.';
        else if (first.task.artifactRework) content = 'user-directed revision';
        else if (chained && first.task.title.startsWith('Rework:'))
          content = 'corrected downstream result';
        const path =
          first.previousArtifact?.relativePath ??
          (first.task.title.endsWith('Build downstream result')
            ? derivedPath
            : first.task.title === 'Build last dependent result'
              ? 'tail.txt'
              : sourcePath);
        calls = [
          call('workspace_write', { path, content }),
          call('submit_artifact', {
            path,
            name: path === 'result.txt' ? 'Result' : path,
            mediaType: native ? 'text/markdown' : 'text/plain',
          }),
          call('complete_task', { summary: 'Real file published' }),
        ];
        if (mode === 'native_single') calls.splice(-1, 0, ...renderAndPublish());
        if (mode === 'native_single' && !first.task.artifactRework)
          calls.splice(
            2,
            0,
            call('workspace_write', { path, content: '# Unpublished mutation' }),
            call('render_source', { source: path, output: 'mutated.docx' }),
            call('workspace_write', { path, content }),
          );
        if (
          (mode === 'targeted' || mode === 'native_single') &&
          first.task.title === 'Create real file'
        )
          calls.splice(
            2,
            0,
            call('workspace_write', { path: 'sibling.txt', content: 'keep this artifact' }),
            call('submit_artifact', {
              path: 'sibling.txt',
              name: 'Sibling',
              mediaType: 'text/plain',
            }),
          );
        if (native && !first.task.artifactRework)
          calls.splice(
            1,
            0,
            call('render_source', { source: sourcePath, output: 'unpinned.docx' }),
          );
        if (mode === 'targeted' && first.task.artifactRework)
          calls.unshift(
            call('submit_artifact', {
              path: 'sibling.txt',
              name: 'Unexpected replacement',
              mediaType: 'text/plain',
            }),
          );
        if (mode === 'mutate')
          calls.splice(
            2,
            0,
            call('workspace_write', { path: 'result.txt', content: 'unpublished later mutation' }),
          );
        if (mode === 'extra')
          calls.splice(
            2,
            0,
            call('workspace_write', { path: 'extra.ts', content: 'unpublished extra change' }),
          );
      }
    } else {
      const returned = messages
        .filter((m: any) => m.role === 'tool')
        .map((m: any) => JSON.parse(m.content));
      const tool = returned.find((r: any) => r.evidenceId);
      const nextPath = linked || native ? first.inputs[returned.length]?.relativePath : sourcePath;
      if (!tool || ((linked || native) && returned.length < first.inputs.length))
        calls =
          mode === 'forge'
            ? [
                call('workspace_write', { path: 'result.txt', content: 'forged review bytes' }),
                call('workspace_read', { path: 'result.txt' }),
              ]
            : [
                mode === 'weak'
                  ? call('workspace_list', {})
                  : mode === 'process'
                    ? call('process_run', {
                        command: process.execPath,
                        args: ['-e', 'process.exit(0)'],
                      })
                    : native && nextPath === derivedPath
                      ? call('inspect_delivery', { source: nextPath })
                      : call('workspace_read', { path: nextPath }),
              ];
      else {
        await overrides.beforeReviewSubmit?.(first.inputs);
        const input = first.inputs[0];
        const upstreamCorrection =
          chained &&
          input.relativePath === derivedPath &&
          input.previousVersionId &&
          !first.availableArtifacts.find(
            (artifact: ProjectSnapshot['artifacts'][number]) =>
              artifact.versionId === input.previousVersionId,
          )?.previousVersionId;
        calls = [
          call('submit_review', {
            verdict:
              tool.output === 'incorrect' || upstreamCorrection ? 'changes_requested' : 'pass',
            summary:
              tool.output === 'incorrect'
                ? 'Content is incorrect; change to verified result'
                : 'Read actual pinned file',
            evidenceIds: returned.map((r: any) => r.evidenceId).filter(Boolean),
            versionIds: first.inputs.map((a: any) => a.versionId),
          }),
        ];
      }
    }
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
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-execution-')));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  const port = (server.address() as { port: number }).port;
  const options: RuntimeOptions = {
    dataRoot,
    executor: overrides.executor ?? createExecutor({ projectRoot: process.cwd() }),
    getCredentials: async () => ({
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'scripted-fixture-not-real-model',
      apiKey: 'test-only-secret',
    }),
  };
  const openRuntime = () => {
    const runtime = createRuntime(options);
    cleanup.push(() => runtime.close());
    return runtime;
  };
  const runtime = openRuntime();
  const workspace = await runtime.createWorkspace({ name: 'Execution fixture' });
  for (const [path, content] of Object.entries(overrides.seed ?? {}))
    await writeFile(join(workspace.workPath, path), content);
  const response = await runtime.submit({
    requestId: 'run',
    workspaceId: workspace.id,
    goal: 'Create a real file',
    criteria: [
      native
        ? 'The native memo matches the reviewed Markdown draft'
        : 'result.txt contains verified result',
    ],
    planningMode: 'auto',
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: mode === 'process' || mode === 'process_tree',
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: {
      maxSteps: overrides.maxSteps ?? 30,
      maxMinutes: 1,
      maxRework: overrides.maxRework ?? 3,
    },
  });
  return { runtime, workspace, id: response.commissionId!, dataRoot, openRuntime };
}
async function until(
  runtime: RuntimeService,
  id: string,
  predicate: (s: ProjectSnapshot) => boolean,
) {
  const end = Date.now() + 6000;
  let snapshot = await runtime.snapshot(id);
  while (!predicate(snapshot) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    snapshot = await runtime.snapshot(id);
  }
  expect(
    predicate(snapshot),
    JSON.stringify({
      commission: snapshot.commission,
      tasks: snapshot.tasks,
      events: snapshot.events.slice(-8),
    }),
  ).toBe(true);
  return snapshot;
}
it('delivers verified results when the final review consumes the exact last model step', async () => {
  const { runtime, id } = await fixture('normal', { maxSteps: 4 });
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(snapshot.commission.stepsUsed).toBe(4);
  expect(snapshot.tasks.every((t) => t.status === 'passed')).toBe(true);
});

it('reworks one current version and refreshes the downstream work through independent review', async () => {
  let releaseReview!: () => void;
  const reviewGate = new Promise<void>((resolve) => (releaseReview = resolve));
  cleanup.push(async () => releaseReview());
  const { runtime, id, workspace } = await fixture('targeted', {
    beforeReviewSubmit: async (inputs) => {
      if (
        inputs.some(
          (artifact) => artifact.previousVersionId && artifact.relativePath === 'result.txt',
        )
      )
        await reviewGate;
    },
  });
  const initial = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const target = initial.artifacts.find((a) => a.relativePath === 'result.txt')!;
  const sibling = initial.artifacts.find((a) => a.relativePath === 'sibling.txt')!;
  const downstream = initial.artifacts.find((a) => a.relativePath === 'derived.txt')!;
  expect(await runtime.accept(id, [sibling.id])).toMatchObject({ ok: true });
  expect(await runtime.accept(id, [downstream.id])).toMatchObject({ ok: true });
  const request = {
    commissionId: id,
    artifactId: target.id,
    versionId: target.versionId,
    revision: initial.commission.revision,
    instruction: 'Change result.txt to user-directed revision',
    requestId: 'targeted-rework',
  };
  expect(typeof runtime.requestArtifactRework).toBe('function');
  expect(
    await runtime.requestArtifactRework({
      ...request,
      artifactId: sibling.id,
      versionId: sibling.versionId,
    }),
  ).toMatchObject({ ok: false, code: 'artifact_accepted' });
  expect(
    await runtime.requestArtifactRework({ ...request, revision: request.revision + 1 }),
  ).toMatchObject({ ok: false, code: 'stale_revision' });
  const submitted = await Promise.all([
    runtime.requestArtifactRework(request),
    runtime.requestArtifactRework(request),
  ]);
  expect(submitted).toEqual([submitted[0], submitted[0]]);
  expect(submitted[0]).toMatchObject({ ok: true, requestId: 'targeted-rework' });
  try {
    const reviewing = await until(runtime, id, (s) =>
      s.artifacts.some((a) => a.previousVersionId === target.versionId && a.validity === 'current'),
    );
    const replacement = reviewing.artifacts.find((a) => a.previousVersionId === target.versionId)!;
    expect(await runtime.artifact(target.id)).toMatchObject({ content: 'verified result' });
    expect(await runtime.artifact(replacement.id)).toMatchObject({
      content: 'user-directed revision',
    });
    expect(await runtime.accept(id, [replacement.id])).toMatchObject({
      ok: false,
      code: 'unverified',
    });
    expect(await runtime.accept(id, [target.id])).toMatchObject({ ok: false });
    expect(reviewing.commission.acceptedArtifactIds).toEqual([sibling.id]);
    expect(reviewing.artifacts.find((a) => a.id === downstream.id)?.validity).toBe('stale');
    expect(reviewing.events.filter((e) => e.type === 'rework_created')).toHaveLength(1);
    expect(
      await runtime.requestArtifactRework({ ...request, instruction: 'Different instructions' }),
    ).toMatchObject({ ok: false, code: 'request_conflict' });
  } finally {
    releaseReview();
  }
  const reviewed = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const current = reviewed.artifacts.filter((a) => a.validity === 'current');
  expect(current.map((a) => a.relativePath).sort()).toEqual([
    'derived.txt',
    'result.txt',
    'sibling.txt',
  ]);
  expect(current.find((a) => a.relativePath === 'sibling.txt')?.id).toBe(sibling.id);
  const replacement = current.find((a) => a.relativePath === 'result.txt')!;
  const newDownstream = current.find((a) => a.relativePath === 'derived.txt')!;
  expect(newDownstream.id).not.toBe(downstream.id);
  expect(newDownstream.inputVersions).toContain(replacement.versionId);
  const oldReviewIds = initial.evidence.filter((e) => e.kind === 'review').map((e) => e.taskId);
  const replacementReview = reviewed.evidence.find(
    (e) =>
      e.kind === 'review' &&
      e.status === 'passed' &&
      e.artifactVersionIds.includes(replacement.versionId),
  )!;
  expect(oldReviewIds).not.toContain(replacementReview.taskId);
  expect(await readFile(join(workspace.workPath, 'sibling.txt'), 'utf8')).toBe(
    'keep this artifact',
  );
  expect(await runtime.accept(id, [replacement.id, newDownstream.id])).toMatchObject({ ok: true });
  expect((await runtime.snapshot(id)).commission.status).toBe('accepted');
});

it('keeps paused rework and its idempotency receipt through a runtime restart', async () => {
  const { runtime, id, openRuntime } = await fixture('targeted', { maxRework: 0 });
  const initial = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const target = initial.artifacts.find((a) => a.relativePath === 'result.txt')!;
  const secondTarget = initial.artifacts.find((a) => a.relativePath === 'sibling.txt')!;
  const downstream = initial.artifacts.find((a) => a.relativePath === 'derived.txt')!;
  const request = {
    commissionId: id,
    artifactId: target.id,
    versionId: target.versionId,
    revision: initial.commission.revision,
    instruction: 'Change the result',
    requestId: 'paused-rework',
  };
  expect(await runtime.requestArtifactRework(request)).toMatchObject({
    ok: false,
    code: 'rework_budget_exhausted',
  });
  expect(await runtime.control(id, 'pause')).toMatchObject({ ok: true });
  expect(
    await runtime.updateBudget(
      id,
      { ...initial.commission.budget, maxRework: 2 },
      initial.commission.budgetRevision!,
    ),
  ).toMatchObject({ ok: true });
  const receipt = await runtime.requestArtifactRework(request);
  expect(receipt).toMatchObject({ ok: true });
  expect(
    await runtime.requestArtifactRework({
      ...request,
      artifactId: secondTarget.id,
      versionId: secondTarget.versionId,
      requestId: 'another-paused-rework',
    }),
  ).toMatchObject({ ok: true });
  await runtime.close();
  const restarted = openRuntime();
  expect(await restarted.requestArtifactRework(request)).toEqual(receipt);
  const queued = await restarted.snapshot(id);
  expect(queued.commission.status).toBe('paused');
  expect(queued.commission.stepsUsed).toBe(initial.commission.stepsUsed);
  expect(queued.tasks.find((t) => t.artifactRework?.requestId === request.requestId)?.status).toBe(
    'queued',
  );
  expect(queued.artifacts.find((a) => a.id === target.id)?.validity).toBe('stale');
  expect(
    await restarted.requestArtifactRework({ ...request, requestId: 'new-request' }),
  ).toMatchObject({ ok: false, code: 'stale_version' });
  expect(await restarted.control(id, 'resume')).toMatchObject({ ok: true });
  const delivered = await until(
    restarted,
    id,
    (s) => s.commission.status === 'awaiting_acceptance',
  );
  expect(delivered.events.filter((e) => e.type === 'rework_created')).toHaveLength(2);
  expect(delivered.artifacts.some((a) => a.previousVersionId === target.versionId)).toBe(true);
  expect(delivered.artifacts.some((a) => a.previousVersionId === secondTarget.versionId)).toBe(
    true,
  );
  expect(delivered.artifacts.some((a) => a.previousVersionId === downstream.versionId)).toBe(true);
});

it('serializes user acceptance with a concurrent rework request for the same version', async () => {
  const { runtime, id } = await fixture('targeted');
  const initial = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const target = initial.artifacts.find((a) => a.relativePath === 'result.txt')!;
  const [accepted, reworked] = await Promise.all([
    runtime.accept(id, [target.id]),
    runtime.requestArtifactRework({
      commissionId: id,
      artifactId: target.id,
      versionId: target.versionId,
      revision: initial.commission.revision,
      instruction: 'Change the result',
      requestId: 'concurrent-acceptance',
    }),
  ]);
  expect([accepted.ok, reworked.ok].filter(Boolean)).toHaveLength(1);
  const state = await runtime.snapshot(id);
  expect(state.commission.acceptedArtifactIds.includes(target.id)).toBe(accepted.ok);
  expect(state.artifacts.find((a) => a.id === target.id)?.validity).toBe(
    accepted.ok ? 'current' : 'stale',
  );
});

it('starts a queued artifact rework after its author releases from another workspace', async () => {
  let authorStarted!: () => void;
  const otherAuthorStarted = new Promise<void>((resolve) => (authorStarted = resolve));
  let releaseAuthor!: () => void;
  const holdAuthor = new Promise<void>((resolve) => (releaseAuthor = resolve));
  cleanup.push(async () => releaseAuthor());
  const { runtime, id } = await fixture('targeted', {
    beforeAuthorActions: async (goal) => {
      if (goal === 'Hold author in second workspace') {
        authorStarted();
        await holdAuthor;
      }
    },
  });
  const initial = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const target = initial.artifacts.find((a) => a.relativePath === 'result.txt')!;
  const otherWorkspace = await runtime.createWorkspace({ name: 'Concurrent workspace' });
  const other = await runtime.submit({
    requestId: 'hold-author',
    workspaceId: otherWorkspace.id,
    goal: 'Hold author in second workspace',
    criteria: ['Create a verified result from the second workspace'],
    planningMode: 'auto',
    budget: initial.commission.budget,
    scope: initial.commission.scope,
  });
  expect(other.ok).toBe(true);
  await otherAuthorStarted;
  try {
    expect(
      await runtime.requestArtifactRework({
        commissionId: id,
        artifactId: target.id,
        versionId: target.versionId,
        revision: initial.commission.revision,
        instruction: 'Change the first workspace result',
        requestId: 'queued-while-author-busy',
      }),
    ).toMatchObject({ ok: true });
    const waiting = await runtime.snapshot(id);
    expect(waiting.tasks.find((t) => t.artifactRework)?.status).toBe('queued');
  } finally {
    releaseAuthor();
  }
  const finished = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(finished.artifacts.some((a) => a.previousVersionId === target.versionId)).toBe(true);
}, 10000);

it('renders from the exact published source and rebuilds the native output after source rework', async () => {
  const { runtime, id } = await fixture('native');
  const initial = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const source = initial.artifacts.find((a) => a.relativePath === 'draft.md')!;
  const native = initial.artifacts.find((a) => a.relativePath === 'memo.docx')!;
  expect(native.renderedFromVersionId).toBe(source.versionId);
  expect(native.inputVersions).toContain(source.versionId);
  expect(initial.artifacts).toHaveLength(2);
  expect(
    initial.evidence.find(
      (e) => e.taskId === source.taskId && e.detail.includes('RENDER_SOURCE_NOT_PINNED'),
    )?.status,
  ).toBe('failed');
  const request = {
    commissionId: id,
    artifactId: native.id,
    versionId: native.versionId,
    revision: initial.commission.revision,
    instruction: 'Add the new paragraph to the memo',
    requestId: 'rework-the-source',
  };
  expect(await runtime.requestArtifactRework(request)).toMatchObject({
    ok: false,
    code: 'source_rework_required',
  });
  expect(
    await runtime.requestArtifactRework({
      ...request,
      artifactId: source.id,
      versionId: source.versionId,
    }),
  ).toMatchObject({ ok: true });
  const rebuilt = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const updatedSource = rebuilt.artifacts.find((a) => a.previousVersionId === source.versionId)!;
  const updatedNative = rebuilt.artifacts.find((a) => a.previousVersionId === native.versionId)!;
  expect(updatedNative.renderedFromVersionId).toBe(updatedSource.versionId);
  expect(updatedNative.sha256).not.toBe(native.sha256);
  expect(rebuilt.artifacts.find((a) => a.id === native.id)?.validity).toBe('stale');
  expect(
    rebuilt.evidence.some(
      (e) =>
        e.kind === 'review' &&
        e.status === 'passed' &&
        e.artifactVersionIds.includes(updatedNative.versionId),
    ),
  ).toBe(true);
});

it('reworks a same-task source and its rendered output together while retaining an accepted sibling', async () => {
  const { runtime, id } = await fixture('native_single');
  const initial = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const originalSource = initial.artifacts.find((a) => a.relativePath === 'draft.md')!;
  const originalNative = initial.artifacts.find((a) => a.relativePath === 'memo.docx')!;
  const sibling = initial.artifacts.find((a) => a.relativePath === 'sibling.txt')!;
  expect(originalNative.taskId).toBe(originalSource.taskId);
  expect(originalNative.renderedFromVersionId).toBe(originalSource.versionId);
  expect(originalNative.inputVersions).toContain(originalSource.versionId);
  expect(initial.tasks.find((t) => t.id === originalSource.taskId)).toMatchObject({
    dependencies: [],
    inputVersions: [],
  });
  expect(
    initial.evidence.some(
      (e) => e.detail.includes('RENDER_SOURCE_CHANGED') && e.status === 'failed',
    ),
  ).toBe(true);
  expect(await runtime.accept(id, [sibling.id])).toMatchObject({ ok: true });
  expect(
    await runtime.requestArtifactRework({
      commissionId: id,
      artifactId: originalSource.id,
      versionId: originalSource.versionId,
      revision: initial.commission.revision,
      instruction: 'Revise the memo text',
      requestId: 'rework-same-task-source',
    }),
  ).toMatchObject({ ok: true });
  const rebuilt = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const current = rebuilt.artifacts.filter((a) => a.validity === 'current');
  expect(current.map((a) => a.relativePath).sort()).toEqual([
    'draft.md',
    'memo.docx',
    'sibling.txt',
  ]);
  expect(rebuilt.commission.acceptedArtifactIds).toEqual([sibling.id]);
  const source = current.find((a) => a.previousVersionId === originalSource.versionId)!;
  const native = current.find((a) => a.previousVersionId === originalNative.versionId)!;
  expect(native.taskId).toBe(source.taskId);
  expect(native.renderedFromVersionId).toBe(source.versionId);
  expect(native.sha256).not.toBe(originalNative.sha256);
  const reviewers = initial.evidence.filter((e) => e.kind === 'review').map((e) => e.taskId);
  expect(
    rebuilt.evidence.some(
      (e) =>
        e.kind === 'review' &&
        e.status === 'passed' &&
        e.artifactVersionIds.includes(source.versionId) &&
        e.artifactVersionIds.includes(native.versionId) &&
        !reviewers.includes(e.taskId),
    ),
  ).toBe(true);
  expect(await runtime.accept(id, [source.id, native.id])).toMatchObject({ ok: true });
});

it('preserves the versions and rework budget when an unrelated live output owns the same path', async () => {
  const { runtime, id } = await fixture('collision');
  const initial = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const [target, other] = initial.artifacts;
  expect(target.relativePath).toBe(other.relativePath);
  expect(target.taskId).not.toBe(other.taskId);
  expect(target.sha256).toBe(other.sha256);
  expect(
    await runtime.requestArtifactRework({
      commissionId: id,
      artifactId: target.id,
      versionId: target.versionId,
      revision: initial.commission.revision,
      instruction: 'Change only the selected result',
      requestId: 'colliding-path-rework',
    }),
  ).toMatchObject({ ok: false, code: 'path_conflict' });
  const unchanged = await runtime.snapshot(id);
  expect(unchanged.lastSequence).toBe(initial.lastSequence);
  expect(unchanged.artifacts).toEqual(initial.artifacts);
  expect(unchanged.commission.status).toBe('awaiting_acceptance');
});

it('relocates an affected consumer to a downstream author retry after independent review rejects the first replacement', async () => {
  const { runtime, id } = await fixture('targeted_chain');
  const initial = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const target = initial.artifacts.find((a) => a.relativePath === 'result.txt')!;
  const downstream = initial.artifacts.find((a) => a.relativePath === 'derived.txt')!;
  expect(
    await runtime.requestArtifactRework({
      commissionId: id,
      artifactId: target.id,
      versionId: target.versionId,
      revision: initial.commission.revision,
      instruction: 'Change the first result',
      requestId: 'rework-with-dependent-retry',
    }),
  ).toMatchObject({ ok: true });
  const finished = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const rejected = finished.artifacts.find((a) => a.previousVersionId === downstream.versionId)!;
  const corrected = finished.artifacts.find((a) => a.previousVersionId === rejected.versionId)!;
  const last = finished.artifacts.find(
    (a) => a.relativePath === 'tail.txt' && a.validity === 'current',
  )!;
  expect(rejected.validity).toBe('stale');
  expect(corrected.validity).toBe('current');
  expect(finished.tasks.find((t) => t.id === corrected.taskId)?.replacesTaskId).toBe(
    rejected.taskId,
  );
  expect(last.inputVersions).toContain(corrected.versionId);
  expect(
    finished.evidence.some(
      (e) =>
        e.kind === 'review' &&
        e.status === 'passed' &&
        e.artifactVersionIds.includes(last.versionId),
    ),
  ).toBe(true);
}, 10000);

it('delivers verified results when active time expires while the reserved final review responds', async () => {
  const start = Date.now();
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => start + offset);
  const { runtime, id } = await fixture('normal', {
    beforeReviewSubmit: async () => {
      offset = 60001;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    },
  });
  await vi.waitFor(
    async () => expect((await runtime.snapshot(id)).commission.status).toBe('awaiting_acceptance'),
    { timeout: 5000 },
  );
  expect((await runtime.snapshot(id)).tasks.every((t) => t.status === 'passed')).toBe(true);
});

it('continues a review blocked by the rework cap after the user raises that cap', async () => {
  const { runtime, id } = await fixture('rework', { maxRework: 0 });
  const paused = await until(
    runtime,
    id,
    (s) =>
      s.commission.status === 'paused' &&
      s.tasks.some((t) => t.kind === 'review' && t.status === 'failed'),
  );
  await vi.waitFor(async () =>
    expect(
      await runtime.updateBudget(id, { ...paused.commission.budget, maxRework: 2 }, 0),
    ).toMatchObject({ ok: true }),
  );
  expect((await runtime.control(id, 'resume')).ok).toBe(true);
  const finished = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(finished.events.some((e) => e.type === 'rework_created')).toBe(true);
  expect(finished.evidence.some((e) => e.kind === 'review' && e.status === 'failed')).toBe(true);
});

it('executes real file tools, unblocks artifact review before author pass, verifies immutable bytes, and accepts delivery', async () => {
  const { runtime, id, workspace } = await fixture();
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(await readFile(join(workspace.workPath, 'result.txt'), 'utf8')).toBe('verified result');
  const artifact = snapshot.artifacts.find((a) => a.validity === 'current')!;
  expect((await runtime.artifact(artifact.id)).content).toBe('verified result');
  expect(
    snapshot.evidence.some(
      (e) =>
        e.kind === 'review' &&
        e.status === 'passed' &&
        e.artifactVersionIds.includes(artifact.versionId),
    ),
  ).toBe(true);
  expect(snapshot.tasks.every((t) => t.status === 'passed')).toBe(true);
  const published = snapshot.events.find((e) => e.type === 'artifact_available')!;
  expect(published.taskId).toBe(artifact.taskId);
  expect(published.agentId).toBe('mori');
  expect(published.artifactVersionId).toBe(artifact.versionId);
  for (const type of ['tool_started', 'tool_finished', 'task_completed']) {
    const events = snapshot.events.filter((event) => event.type === type);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const owner = snapshot.tasks.find((task) => task.id === event.taskId);
      expect(owner).toBeDefined();
      expect(event.agentId).toBe(owner!.agentId);
    }
  }
  expect((await runtime.accept(id, [artifact.id])).ok).toBe(true);
  expect((await runtime.snapshot(id)).commission.status).toBe('accepted');
  expect((await runtime.revise(id, 'Add a new constraint', snapshot.commission.revision)).ok).toBe(
    true,
  );
  const revised = await runtime.snapshot(id);
  expect(revised.artifacts.every((a) => a.validity === 'stale')).toBe(true);
  expect((await runtime.accept(id, [artifact.id])).code).toBe('invalid_artifact');
});
it('creates linked rework, keeps failed review history, and verifies the replacement version', async () => {
  const { runtime, id } = await fixture('rework');
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  expect(snapshot.events.some((e) => e.type === 'rework_created')).toBe(true);
  expect(snapshot.evidence.some((e) => e.kind === 'review' && e.status === 'failed')).toBe(true);
  expect(snapshot.artifacts.filter((a) => a.validity === 'stale')).toHaveLength(1);
  expect(
    (await runtime.artifact(snapshot.artifacts.find((a) => a.validity === 'current')!.id)).content,
  ).toBe('verified result');
});
it('keeps a review unable to verify when evidence only lists a directory', async () => {
  const { runtime, id } = await fixture('weak');
  const snapshot = await until(runtime, id, (s) =>
    s.tasks.some((t) => t.step === 'Unable to verify'),
  );
  expect(snapshot.commission.status).toBe('paused');
  expect(
    (
      await runtime.accept(
        id,
        snapshot.artifacts.map((a) => a.id),
      )
    ).code,
  ).toBe('unverified');
});
it('pauses before exceeding the model step budget', async () => {
  const { runtime, id } = await fixture('normal', { maxSteps: 1 });
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'paused');
  expect(snapshot.commission.stepsUsed).toBe(1);
  expect(snapshot.tasks.every((t) => t.attempts === 0)).toBe(true);
});
it('reports cancelling until an in-flight tool confirms it has returned stopped', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    start = new Promise<void>((resolve) => (started = resolve));
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      if (name === 'workspace_write') {
        started();
        await gate;
        return {
          ok: false,
          code: 'ABORTED',
          output: 'Stopped before writing',
          metadata: { stopStatus: 'stopped' },
        };
      }
      return base.execute(name, args, context);
    },
  };
  const { runtime, id } = await fixture('normal', { executor });
  await start;
  expect((await runtime.control(id, 'cancel')).ok).toBe(true);
  expect((await runtime.snapshot(id)).commission.status).toBe('cancelling');
  release();
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'cancelled');
  expect(snapshot.tasks.some((t) => t.status === 'passed')).toBe(false);
});
it.skipIf(process.platform !== 'win32').each([false, true])(
  'persists real process-tree stop evidence across runtime restart (supervisor lost=%s)',
  async (lost) => {
    const processRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-runtime-tree-')));
    cleanup.push(() => rm(processRoot, { recursive: true, force: true }));
    const { runtime, id, dataRoot } = await fixture('process_tree', {
      processArgs: [join(process.cwd(), 'tests/fixtures/process-tree.cjs'), 'parent', processRoot],
    });
    for (let i = 0; i < 250; i++) {
      if (
        await readFile(join(processRoot, 'heartbeat')).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((done) => setTimeout(done, 20));
    }
    expect((await readFile(join(processRoot, 'heartbeat'))).length).toBeGreaterThan(0);
    if (lost)
      process.kill(Number(await readFile(join(processRoot, 'supervisor.pid'), 'utf8')), 'SIGKILL');
    else expect((await runtime.control(id, 'cancel')).ok).toBe(true);
    const snapshot = await until(runtime, id, (s) =>
      lost
        ? s.tasks.some((task) => task.error === 'outcome_unknown')
        : s.commission.status === 'cancelled',
    );
    expect(snapshot.commission.status).toBe(lost ? 'paused' : 'cancelled');
    await runtime.close();
    const store = new RuntimeStore(dataRoot);
    const calls = store
      .recentTaskCalls(id, snapshot.tasks.find((task) => task.kind === 'implement')!.id)
      .filter((call) => call.request.name === 'process_run');
    store.close();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      state: lost ? 'outcome_unknown' : 'finished',
      result: {
        code: lost ? 'OUTCOME_UNKNOWN' : 'ABORTED',
        metadata: {
          stopStatus: lost ? 'outcome_unknown' : 'stopped',
          termination: { mechanism: 'windows_job', confirmed: !lost },
        },
      },
    });
    const restarted = createRuntime({
      dataRoot,
      executor: createExecutor({ projectRoot: process.cwd() }),
      getCredentials: async () => null,
    });
    cleanup.push(() => restarted.close());
    expect((await restarted.snapshot(id)).commission.status).toBe(lost ? 'paused' : 'cancelled');
    if (lost) expect((await restarted.control(id, 'resume')).code).toBe('outcome_unknown');
    expect(snapshot.tasks.some((task) => task.status === 'passed')).toBe(false);
  },
);
it('rejects integrating bytes changed after immutable publication', async () => {
  const { runtime, id, workspace } = await fixture('mutate');
  const snapshot = await until(runtime, id, (s) =>
    s.requests.some((r) => r.title === 'Published copy differs'),
  );
  expect(snapshot.commission.status).toBe('active');
  await expect(readFile(join(workspace.workPath, 'result.txt'), 'utf8')).rejects.toThrow();
  expect((await runtime.artifact(snapshot.artifacts[0].id)).content).toBe('verified result');
});
it.each([false, true])(
  'keeps an unknown tool outcome unresolved and blocks dispatch (cancel=%s)',
  async (cancel) => {
    const base = createExecutor({ projectRoot: process.cwd() });
    let release!: () => void,
      started!: () => void,
      calls = 0;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      start = new Promise<void>((resolve) => (started = resolve));
    const executor: ToolExecutor = {
      ...base,
      execute: async () => {
        calls++;
        started();
        await gate;
        return {
          ok: false,
          code: 'OUTCOME_UNKNOWN',
          output: 'Stop could not be confirmed',
          metadata: { stopStatus: 'outcome_unknown', reason: cancel ? 'cancelled' : 'timeout' },
        };
      },
    };
    const { runtime, id } = await fixture('normal', { executor });
    await start;
    if (cancel) await runtime.control(id, 'cancel');
    release();
    const snapshot = await until(runtime, id, (s) =>
      s.tasks.some((t) => t.error === 'outcome_unknown'),
    );
    expect(snapshot.commission.status).toBe('paused');
    expect(calls).toBe(1);
    expect(snapshot.artifacts).toHaveLength(0);
    expect(snapshot.events.some((e) => e.type === 'commission_cancelled')).toBe(false);
    expect((await runtime.control(id, 'resume')).code).toBe('outcome_unknown');
    expect((await runtime.control(id, 'cancel')).code).toBe('outcome_unknown');
  },
);
it('rejects reviewer file writes before they reach the executor', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  let forgedWrites = 0;
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      if (name === 'workspace_write' && args.content === 'forged review bytes') forgedWrites++;
      return base.execute(name, args, context);
    },
  };
  const { runtime, id } = await fixture('forge', { executor });
  const snapshot = await until(
    runtime,
    id,
    (s) => s.commission.status === 'awaiting_acceptance' || s.commission.status === 'paused',
  );
  expect(forgedWrites).toBe(0);
  expect(
    snapshot.evidence
      .filter((e) => e.kind === 'tool')
      .some((e) => e.detail.includes('forged review bytes')),
  ).toBe(false);
});
it('does not bind evidence to pinned versions when consumed bytes change during the tool', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      const output = await base.execute(name, args, context);
      if (name === 'workspace_read')
        await writeFile(join(context.workPath, 'result.txt'), 'tampered after read');
      return output;
    },
  };
  const { runtime, id } = await fixture('normal', { executor });
  const snapshot = await until(runtime, id, (s) =>
    s.tasks.some((t) => t.step === 'Unable to verify'),
  );
  expect(snapshot.evidence.some((e) => e.kind === 'review' && e.status === 'passed')).toBe(false);
});
it('rechecks review bytes at the decision after previously valid read evidence', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  let pinnedPath = '';
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      if (name === 'workspace_read') pinnedPath = join(context.workPath, 'result.txt');
      return base.execute(name, args, context);
    },
  };
  const { runtime, id } = await fixture('normal', {
    executor,
    beforeReviewSubmit: async () => {
      await writeFile(pinnedPath, 'tampered before decision');
    },
  });
  const snapshot = await until(runtime, id, (s) =>
    s.tasks.some((t) => t.step === 'Unable to verify'),
  );
  expect(snapshot.evidence.some((e) => e.kind === 'review' && e.status === 'passed')).toBe(false);
});
it('does not treat unrelated process exit zero as verification for every artifact', async () => {
  const { runtime, id } = await fixture('process');
  const snapshot = await until(runtime, id, (s) =>
    s.tasks.some((t) => t.step === 'Unable to verify'),
  );
  expect(snapshot.evidence.some((e) => e.kind === 'review' && e.status === 'passed')).toBe(false);
});
it('rechecks revision and artifact validity after acceptance blob IO', async () => {
  const { runtime, id } = await fixture();
  const snapshot = await until(runtime, id, (s) => s.commission.status === 'awaiting_acceptance');
  const accepting = runtime.accept(id, [snapshot.artifacts[0].id]);
  await runtime.revise(
    id,
    'New requirement invalidates the old artifact',
    snapshot.commission.revision,
  );
  expect((await accepting).code).toBe('stale_revision');
  expect((await runtime.snapshot(id)).commission.acceptedArtifactIds).toEqual([]);
});
it('blocks integrating an extra changed file that was never published', async () => {
  const { runtime, id, workspace } = await fixture('extra');
  await until(runtime, id, (s) => s.requests.some((r) => r.title === 'Published copy differs'));
  await expect(readFile(join(workspace.workPath, 'extra.ts'), 'utf8')).rejects.toThrow();
  await expect(readFile(join(workspace.workPath, 'result.txt'), 'utf8')).rejects.toThrow();
});
it('blocks integrating an unsupported unreviewed deletion', async () => {
  const base = createExecutor({ projectRoot: process.cwd() });
  const executor: ToolExecutor = {
    ...base,
    execute: async (name, args, context) => {
      const output = await base.execute(name, args, context);
      if (name === 'workspace_write' && args.path === 'result.txt')
        await unlink(join(context.workPath, 'source.ts'));
      return output;
    },
  };
  const { runtime, id, workspace } = await fixture('extra', {
    executor,
    seed: { 'source.ts': 'preserve original' },
  });
  await until(runtime, id, (s) => s.requests.some((r) => r.title === 'Published copy differs'));
  expect(await readFile(join(workspace.workPath, 'source.ts'), 'utf8')).toBe('preserve original');
});
