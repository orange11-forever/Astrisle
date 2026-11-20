import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type {
  ProjectSnapshot,
  ProviderKind,
  RuntimeOptions,
  Task,
} from '../../packages/contracts/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { createRuntime } from '../../packages/runtime/src/index';

const date = '2026-11-21T00:00:00Z';
const later = '2026-11-21T00:01:00Z';
const secret = 'fixture-private-credential';
const sourcePath = 'C:\\Users\\Private\\project';
const input = { commissionId: 'project', partnerId: 'mori', question: '报告为什么返工？' };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

function task(id: string, agentId: string, title: string): Task {
  return {
    id,
    agentId,
    title,
    commissionId: input.commissionId,
    kind: 'implement',
    description: 'Write a verified report',
    status: 'passed',
    dependencies: [],
    criterionIds: [],
    inputVersions: [],
    outputArtifactIds: [],
    step: 'Report ready',
    attempts: 1,
    createdAt: date,
    updatedAt: later,
  };
}

async function open(getCredentials: RuntimeOptions['getCredentials']) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'astrisle-dialogue-'));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new RuntimeStore(dataRoot);
  const snapshot: ProjectSnapshot = {
    commission: {
      id: input.commissionId,
      workspaceId: 'workspace',
      title: 'Review the report',
      goal: `Summarize the findings for ${sourcePath}`,
      status: 'paused',
      criteria: [],
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 100, maxMinutes: 10, maxRework: 2 },
      revision: 1,
      planningMode: 'auto',
      stepsUsed: 9,
      createdAt: date,
      updatedAt: later,
      acceptedArtifactIds: [],
      summary: '',
    },
    workspace: {
      id: 'workspace',
      name: 'Fixture',
      sourcePath,
      workPath: `${sourcePath}\\work`,
      createdAt: date,
    },
    agents: [
      { id: 'mori', name: 'Original Mori', temperament: 'explorer' },
      { id: 'luma', name: 'Luma', temperament: 'organizer' },
      { id: 'partner-unrelated', name: 'Unrelated', temperament: 'organizer' },
      { id: 'partner-idle', name: 'Idle partner', temperament: 'organizer' },
    ],
    tasks: [
      task('write', 'mori', 'Draft report'),
      { ...task('review', 'luma', 'Review report'), kind: 'review', dependencies: ['write'] },
      {
        ...task('write-appendix', 'mori', 'Draft appendix'),
        description: 'Example notes\nReview feedback: Mention the draft\nReworks task write',
      },
      {
        ...task('review-appendix', 'partner-unrelated', 'Review appendix'),
        kind: 'review',
        dependencies: ['write-appendix'],
      },
      {
        ...task('rework-report', 'mori', 'Rework report'),
        description:
          'Write a verified report\nReview feedback: Missing the totals table.\nReworks task write',
      },
      task('unrelated-task', 'partner-unrelated', 'Unrelated task marker'),
    ],
    artifacts: ['old', 'new'].map((id) => ({
      id: 'report',
      versionId: `version-${id}`,
      commissionId: input.commissionId,
      taskId: 'write',
      name: 'Report',
      relativePath: 'private-directory/report.md',
      mediaType: 'text/markdown',
      sha256: 'a'.repeat(64),
      size: 10,
      inputVersions: [],
      validity: id === 'old' ? 'stale' : 'current',
      createdAt: id === 'old' ? date : later,
    })),
    evidence: [
      {
        id: 'failed-review',
        kind: 'review',
        summary: `Missing the totals table. API key=${secret}`,
        detail: JSON.stringify({
          verdict: 'changes_requested',
          authorTaskIds: ['write'],
          raw: 'full evidence marker',
          evidenceIds: ['check'],
        }),
        status: 'failed',
        taskId: 'review',
        artifactVersionIds: ['version-old'],
        createdAt: date,
      },
    ],
    events: [
      {
        id: 'handoff',
        commissionId: input.commissionId,
        sequence: 1,
        type: 'task_completed',
        message: 'Sent the draft to Luma.',
        taskId: 'write',
        agentId: 'mori',
        createdAt: date,
      },
      {
        id: 'rework-link',
        commissionId: input.commissionId,
        sequence: 2,
        type: 'rework_created',
        message: 'Linked rework-report to write',
        taskId: 'rework-report',
        agentId: 'mori',
        createdAt: later,
      },
    ],
    requests: [],
    lastSequence: 2,
  };
  try {
    store.addWorkspace(snapshot.workspace);
    store.save(snapshot);
    store.save({
      ...snapshot,
      commission: {
        ...snapshot.commission,
        id: 'other-project',
        goal: 'Another project marker',
        status: 'accepted',
      },
      agents: [
        ...snapshot.agents.slice(0, 2),
        { id: 'partner-other', name: 'Other partner', temperament: 'explorer' },
      ],
      tasks: [
        {
          ...task('alternate-write', 'luma', 'Draft report'),
          commissionId: 'other-project',
          outputArtifactIds: ['alternate-report'],
        },
        {
          ...task('alternate-review', 'mori', 'Review report'),
          commissionId: 'other-project',
          kind: 'review',
          dependencies: ['alternate-write'],
          inputVersions: ['alternate-version'],
        },
      ],
      artifacts: [
        {
          ...snapshot.artifacts[1],
          commissionId: 'other-project',
          id: 'alternate-report',
          taskId: 'alternate-write',
          versionId: 'alternate-version',
        },
      ],
      evidence: [],
      events: [],
      lastSequence: 0,
    });
  } finally {
    store.close();
  }
  const runtime = createRuntime({
    dataRoot,
    getCredentials,
    executor: {
      definitions: () => {
        throw new Error('Dialogue must not list execution tools');
      },
      execute: async () => {
        throw new Error('Dialogue must not run execution tools');
      },
      capabilities: async () => [],
    },
  });
  cleanup.push(() => runtime.close());
  return runtime;
}

type ProviderBody = Record<string, any>;
async function provider(
  handler: (body: ProviderBody) => unknown,
  kind: ProviderKind = 'openai-compatible',
) {
  let failure: unknown;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = handler(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (payload === undefined) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (error) {
      failure = error;
      res.writeHead(500).end();
    }
  });
  cleanup.push(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (failure) throw failure;
  });
  await new Promise<Server>((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider failed to listen');
  return { kind, baseUrl: `http://127.0.0.1:${address.port}`, model: 'fixture', apiKey: secret };
}

function chatResponse(text: string, toolCalls?: unknown[]) {
  return { choices: [{ message: { content: text, tool_calls: toolCalls } }] };
}

it('answers from the selected partner’s handoff and exact reviewed version without writing runtime state', async () => {
  const settings = await provider((body) => {
    expect(body).not.toHaveProperty('tools');
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      'system',
      'user',
    ]);
    const { question, partner, history, sources } = JSON.parse(body.messages[1].content);
    expect(partner).toEqual({ id: 'mori', name: 'Renamed Mori' });
    expect(question).toBe(input.question);
    expect(history).toEqual([{ question: '此前交给谁？', answer: '交给了 Luma。' }]);
    expect(sources.find((source: { kind: string }) => source.kind === 'commission')).toMatchObject({
      status: 'paused',
    });
    for (const privateText of [
      sourcePath,
      secret,
      'private-directory',
      'full evidence marker',
      'Unrelated task marker',
      'Another project marker',
    ])
      expect(body.messages[1].content).not.toContain(privateText);
    const author = sources.find((source: { title?: string }) => source.title === 'Draft report');
    const reviewer = sources.find((source: { title?: string }) => source.title === 'Review report');
    const reviewed = sources.find((source: { validity?: string }) => source.validity === 'stale');
    const current = sources.find((source: { validity?: string }) => source.validity === 'current');
    const evidence = sources.find((source: { kind: string }) => source.kind === 'evidence');
    expect(author).toMatchObject({
      partnerId: 'mori',
      partnerName: 'Renamed Mori',
      handoff: 'Sent the draft to Luma.',
    });
    expect(reviewer).toMatchObject({ partnerId: 'luma', partnerName: 'Renamed Luma' });
    expect(reviewed).toMatchObject({ versionNumber: 1 });
    expect(current).toMatchObject({ versionNumber: 2 });
    expect(evidence).toMatchObject({
      verdict: 'changes_requested',
      taskKey: reviewer.key,
      artifactKeys: [reviewed.key],
      partnerId: 'luma',
      partnerName: 'Renamed Luma',
    });
    expect(evidence.summary).toContain('Missing the totals table.');
    return chatResponse(
      JSON.stringify({
        answer: '复核发现初版少了汇总表。',
        sources: [author.key, reviewed.key, current.key, evidence.key, evidence.key],
      }),
    );
  });
  const runtime = await open(async () => settings);
  const before = await runtime.snapshot(input.commissionId);
  const history = [{ question: '此前交给谁？', answer: '交给了 Luma。' }];
  const reply = await runtime.askPartner(
    { ...input, history },
    { mori: 'Renamed Mori', luma: 'Renamed Luma' },
  );
  expect(reply.answer).toBe('复核发现初版少了汇总表。');
  expect(reply.references.map(({ kind, id }) => [kind, id])).toEqual([
    ['task', 'write'],
    ['artifact', 'version-old'],
    ['artifact', 'version-new'],
    ['evidence', 'failed-review'],
  ]);
  expect(
    reply.references.filter(({ kind }) => kind === 'artifact').map(({ label }) => label),
  ).toEqual(['Report · 第 1 版', 'Report · 第 2 版']);
  expect(await runtime.snapshot(input.commissionId)).toEqual(before);
});

it('answers for the same partners after their author and reviewer roles swap in another commission', async () => {
  const settings = await provider((body) => {
    const { partner, sources } = JSON.parse(body.messages[1].content);
    const task = sources.find(
      (s: { partnerId?: string; title?: string }) =>
        s.partnerId === partner.id && ['Draft report', 'Review report'].includes(s.title ?? ''),
    );
    const version = sources.find(
      (s: { kind: string; validity?: string }) => s.kind === 'artifact' && s.validity === 'current',
    );
    return chatResponse(
      JSON.stringify({ answer: task.taskKind, sources: [task.key, version.key] }),
    );
  });
  const runtime = await open(async () => settings);
  for (const [commissionId, partnerId, role, taskId, version] of [
    ['project', 'mori', 'implement', 'write', 'version-new'],
    ['project', 'luma', 'review', 'review', 'version-new'],
    ['other-project', 'mori', 'review', 'alternate-review', 'alternate-version'],
    ['other-project', 'luma', 'implement', 'alternate-write', 'alternate-version'],
  ]) {
    const reply = await runtime.askPartner({
      commissionId,
      partnerId,
      question: '这次由你撰写还是复核？',
    });
    expect(reply.answer).toBe(role);
    expect(reply.references.map((reference) => reference.id)).toEqual([taskId, version]);
  }
});

it('rejects invalid or cross-commission participants before reading credentials', async () => {
  let credentialsReads = 0;
  const runtime = await open(async () => {
    credentialsReads++;
    return null;
  });
  for (const partnerId of ['user', 'partner-other'])
    await expect(
      runtime.askPartner({ ...input, partnerId }, { [partnerId]: 'Current profile' }),
    ).rejects.toMatchObject({
      code: 'partner_unavailable',
    });
  await expect(runtime.askPartner({ ...input, question: '好'.repeat(1201) })).rejects.toMatchObject(
    { code: 'invalid_partner_dialogue' },
  );
  await expect(
    runtime.askPartner({ ...input, history: [{ question: '之前', answer: '好'.repeat(4001) }] }),
  ).rejects.toMatchObject({ code: 'invalid_partner_dialogue' });
  expect(credentialsReads).toBe(0);
  await expect(runtime.askPartner(input)).rejects.toMatchObject({ code: 'provider_missing' });
});

it('allows an idle partner to cite the saved commission status and rejects keys from an earlier prompt', async () => {
  let previousKey: string | undefined;
  const settings = await provider((body) => {
    const { partner, sources } = JSON.parse(body.messages[1].content);
    expect(partner).toEqual({ id: 'partner-idle', name: 'Idle partner' });
    expect(sources).toMatchObject([
      {
        kind: 'commission',
        title: 'Review the report',
        status: 'paused',
        goal: expect.stringContaining('Summarize the findings'),
      },
    ]);
    const [{ key }] = sources;
    const cited = previousKey ?? key;
    previousKey = key;
    return chatResponse(JSON.stringify({ answer: '委托目前处于暂停状态。', sources: [cited] }));
  });
  const runtime = await open(async () => settings);
  const question = { ...input, partnerId: 'partner-idle', question: '委托现在是什么状态？' };
  await expect(runtime.askPartner(question)).resolves.toEqual({
    answer: '委托目前处于暂停状态。',
    references: [{ kind: 'commission', id: input.commissionId, label: '委托目标与进度' }],
  });
  await expect(runtime.askPartner(question)).rejects.toMatchObject({
    code: 'partner_reply_invalid',
  });
});

it('identifies the reviewer for each producer using current dependency source keys', async () => {
  const settings = await provider((body) => {
    const { sources } = JSON.parse(body.messages[1].content);
    const find = (title: string) =>
      sources.find((source: { title?: string }) => source.title === title);
    expect(find('Review report').dependencyKeys).toEqual([find('Draft report').key]);
    expect(find('Review appendix').dependencyKeys).toEqual([find('Draft appendix').key]);
    return chatResponse(
      JSON.stringify({ answer: 'Luma 负责复核报告。', sources: [find('Review report').key] }),
    );
  });
  const runtime = await open(async () => settings);
  await expect(
    runtime.askPartner({ ...input, question: '谁负责复核报告？' }),
  ).resolves.toMatchObject({
    references: [{ kind: 'task', id: 'review' }],
  });
});

it('reports legacy rework feedback only for a task with a saved rework link', async () => {
  const settings = await provider((body) => {
    const { sources } = JSON.parse(body.messages[1].content);
    const find = (title: string) =>
      sources.find((source: { title?: string }) => source.title === title);
    expect(find('Draft appendix')).not.toHaveProperty('reworkReason');
    const rework = find('Rework report');
    expect(rework.reworkReason).toBe('Missing the totals table.');
    return chatResponse(JSON.stringify({ answer: '报告缺少汇总表。', sources: [rework.key] }));
  });
  const runtime = await open(async () => settings);
  await expect(runtime.askPartner(input)).resolves.toMatchObject({
    references: [{ kind: 'task', id: 'rework-report' }],
  });
});

it('rejects fabricated sources, oversized replies, and unsolicited tool calls', async () => {
  const response = [
    chatResponse(JSON.stringify({ answer: 'Wrong.', sources: ['failed-review'] })),
    chatResponse(JSON.stringify({ answer: '好'.repeat(4001), sources: [] })),
    chatResponse(JSON.stringify({ answer: 'Claim without a source.', sources: [] })),
    chatResponse('{}', [
      { id: 'write', type: 'function', function: { name: 'workspace_write', arguments: '{}' } },
    ]),
  ];
  const settings = await provider(() => response.shift());
  const runtime = await open(async () => settings);
  await expect(runtime.askPartner(input)).rejects.toMatchObject({ code: 'partner_reply_invalid' });
  await expect(runtime.askPartner(input)).rejects.toMatchObject({ code: 'partner_reply_invalid' });
  await expect(runtime.askPartner(input)).resolves.toEqual({
    answer: expect.stringContaining('记录不足'),
    references: [],
  });
  await expect(runtime.askPartner(input)).rejects.toMatchObject({ code: 'partner_reply_invalid' });
});

const otherProtocols = {
  'openai-responses': {
    userText: (body: ProviderBody) => body.input[1].content,
    reply: (text: string) => ({
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    }),
  },
  anthropic: {
    userText: (body: ProviderBody) => body.messages[0].content,
    reply: (text: string) => ({ content: [{ type: 'text', text }] }),
  },
  gemini: {
    userText: (body: ProviderBody) => body.contents[0].parts[0].text,
    reply: (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  },
};

it.each(Object.entries(otherProtocols))(
  'reads text replies without tools via %s',
  async (kind, protocol) => {
    const settings = await provider((body) => {
      expect(body).not.toHaveProperty('tools');
      const { partner, sources } = JSON.parse(protocol.userText(body));
      expect(partner).toEqual({ id: 'luma', name: 'Luma' });
      const review = sources.find((source: { kind: string }) => source.kind === 'evidence');
      return protocol.reply(
        JSON.stringify({ answer: '复核记录显示初版需返工。', sources: [review.key] }),
      );
    }, kind as ProviderKind);
    const runtime = await open(async () => settings);
    await expect(runtime.askPartner({ ...input, partnerId: 'luma' })).resolves.toMatchObject({
      answer: '复核记录显示初版需返工。',
      references: [{ kind: 'evidence', id: 'failed-review' }],
    });
  },
);

it('reports provider failures without exposing provider-supplied error details', async () => {
  const settings = await provider(() => ({ error: { message: secret } }));
  const runtime = await open(async () => settings);
  await expect(runtime.askPartner(input)).rejects.toMatchObject({
    code: 'provider_error',
    message: expect.not.stringContaining(secret),
  });
});

it('cancels pending model requests during runtime shutdown', async () => {
  let resolve!: () => void;
  const arrived = new Promise<void>((accept) => {
    resolve = accept;
  });
  const settings = await provider(() => {
    resolve();
  });
  const runtime = await open(async () => settings);
  const reply = expect(runtime.askPartner(input)).rejects.toMatchObject({
    code: 'runtime_closing',
  });
  await arrived;
  await runtime.close();
  await reply;
});

it('cancels dialogue while credentials are still loading', async () => {
  const runtime = await open(() => new Promise(() => {}));
  const reply = expect(runtime.askPartner(input)).rejects.toMatchObject({
    code: 'runtime_closing',
  });
  await runtime.close();
  await reply;
});
