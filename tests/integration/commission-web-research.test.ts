import { expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Artifact, RuntimeOptions, Task } from '../../packages/contracts/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { createRuntime } from '../../packages/runtime/src/index';
import { waitForDelivery } from '../fixtures/wait-for-delivery';

const report = 'research.md';
const question = '花港今年修复了多少盏航标灯？';
const call = (name: string, args: unknown) => ({
  id: randomUUID(),
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

async function modelReply(req: IncomingMessage) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const messages: { role: string; content: string }[] = JSON.parse(body).messages;
  const context: { task?: Task; inputs: Artifact[] } = JSON.parse(
    messages.find((message) => message.role === 'user')!.content,
  );
  if (!context.task) {
    return [
      call('propose_plan', {
        tasks: [
          {
            key: 'author',
            title: '查原文并撰写报告',
            description: question,
            kind: 'investigate',
            agentId: 'mori',
            dependencies: [],
            criterionIds: ['c1'],
          },
          {
            key: 'review',
            title: '独立核对原文',
            description: '检查报告数字和所引原文',
            kind: 'review',
            agentId: 'luma',
            dependencies: ['author'],
            criterionIds: ['c1'],
          },
        ],
      }),
    ];
  }
  const results = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
  for (const result of results) expect(result.ok, result.output).not.toBe(false);
  const [first, second] = results;
  if (context.task.kind === 'review') {
    const [input] = context.inputs;
    if (!first) return [call('workspace_read', { path: input.relativePath })];
    const sourceUrl = input.webSources![0].url;
    if (!second) return [call('web_read', { url: sourceUrl })];
    const matches = first.output.includes(second.output) && first.output.includes(sourceUrl);
    return [
      call('submit_review', {
        verdict: matches ? 'pass' : 'changes_requested',
        summary: '逐字核对港务所公告与报告引用',
        versionIds: [input.versionId],
        evidenceIds: [first.evidenceId, second.evidenceId],
      }),
    ];
  }
  if (!first) return [call('web_search', { query: question })];
  if (!second) return [call('web_read', { url: JSON.parse(first.output)[0].url })];
  return [
    call('workspace_write', {
      path: report,
      content: '# 花港调研\n\n' + second.output + '\n\n' + second.metadata.url,
    }),
    call('submit_artifact', {
      path: report,
      name: '花港调研',
      mediaType: 'text/markdown',
      sourceEvidenceIds: [second.evidenceId],
    }),
    call('complete_task', { summary: '已发表带原文出处的调研报告' }),
  ];
}

it('discovers a source, publishes its final URL and independently checks the report against it across restart', async () => {
  const requests: string[] = [];
  const errors: unknown[] = [];
  const announcement = '港务所本年共修复 37 盏航标灯。';
  let origin = '';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      if (req.method === 'GET') requests.push(url.pathname);
      switch (url.pathname) {
        case '/search':
          expect(url.searchParams.get('format')).toBe('json');
          expect(url.searchParams.get('q')).toContain(question);
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              results: [
                { title: '未授权转载', url: 'https://unapproved.example/archive', content: '转载' },
                { title: '花港公告', url: origin + '/latest', content: '摘录来自旧稿，数字待核。' },
              ],
            }),
          );
          break;
        case '/latest':
          res.writeHead(302, { location: '/notices/lighting' }).end();
          break;
        case '/notices/lighting':
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(announcement);
          break;
        case '/v1/chat/completions': {
          const calls = await modelReply(req);
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
            }),
          );
          break;
        }
        default:
          res.writeHead(404).end();
      }
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end();
    }
  });
  const dataRoot = await mkdtemp(join(tmpdir(), 'astrisle-research-'));
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const options: RuntimeOptions = {
    dataRoot,
    executor: createExecutor({ projectRoot: process.cwd() }),
    getCredentials: async () => ({
      kind: 'openai-compatible',
      baseUrl: origin + '/v1',
      model: 'scripted-research-fixture',
      apiKey: 'fixture',
    }),
  };
  let runtime = createRuntime(options);
  try {
    const workspace = await runtime.createWorkspace({ name: '花港' });
    const response = await runtime.submit({
      workspaceId: workspace.id,
      requestId: randomUUID(),
      goal: question,
      criteria: ['根据原始公告回答并附出处'],
      planningMode: 'auto',
      scope: {
        allowNetwork: true,
        allowProcess: false,
        allowedHosts: ['127.0.0.1'],
        searchEndpoint: origin + '/search',
        readRoots: [],
        writeRoots: [],
      },
      budget: { maxSteps: 18, maxMinutes: 2, maxRework: 1 },
    });
    const id = response.commissionId!;
    const delivery = await waitForDelivery(runtime, id).catch((error) => {
      throw errors[0] || error;
    });
    const [artifact] = delivery.artifacts;
    const [source] = artifact.webSources!;
    expect(source.url).toBe(origin + '/notices/lighting');
    const review = delivery.evidence.find((e) => e.kind === 'review' && e.status === 'passed')!;
    expect(review.artifactVersionIds).toContain(artifact.versionId);
    expect(delivery.tasks.find((task) => task.id === review.taskId)?.agentId).toBe('luma');
    const authorRead = delivery.evidence.find((e) => e.id === source.evidenceId)!;
    expect(authorRead.taskId).toBe(artifact.taskId);
    expect(JSON.parse(authorRead.detail).result.output).toBe(announcement);
    const reviewIds: string[] = JSON.parse(review.detail).evidenceIds;
    expect(
      delivery.evidence.some(
        (e) =>
          e.taskId === review.taskId &&
          reviewIds.includes(e.id) &&
          JSON.parse(e.detail).name === 'web_read' &&
          JSON.parse(e.detail).result.output === announcement,
      ),
    ).toBe(true);
    expect(requests).toEqual(['/search', '/latest', '/notices/lighting', '/notices/lighting']);
    expect(errors).toEqual([]);
    await runtime.close();
    runtime = createRuntime(options);
    const reopened = await runtime.snapshot(id);
    expect(reopened.artifacts[0].webSources).toEqual([source]);
    const preview = await runtime.artifact(artifact.id);
    expect(preview.content).toContain(announcement);
    expect(preview.content).toContain(source.url);
  } finally {
    await runtime.close();
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}, 35_000);
