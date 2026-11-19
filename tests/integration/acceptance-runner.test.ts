import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAcceptanceScenario } from '../acceptance/runner';
import { scenarioSchema } from '../acceptance/schema';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const scenario = {
  id: 'file-roundtrip',
  title: 'Synthetic file acceptance',
  seed: { 'source.txt': 'keep original' },
  stages: [
    {
      goal: 'Write result.txt containing verified result',
      criteria: ['result.txt contains verified result'],
      checks: [{ kind: 'text', path: 'result.txt', equals: 'verified result' }],
    },
  ],
};
const tool = (name: string, args: unknown) => ({
  id: `${name}-${Math.random()}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
async function fixture(mode = 'success') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-acceptance-test-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let planningCalls = 0;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages;
    const input = JSON.parse(messages.find((m: any) => m.role === 'user').content);
    requests.push({ input, tools: JSON.parse(body).tools });
    if (mode === 'hang') return;
    let calls: ReturnType<typeof tool>[];
    if (!input.task) {
      planningCalls++;
      calls = [
        tool('propose_plan', {
          tasks: [
            {
              key: 'write',
              title: 'Write result',
              description: 'Write and publish result.txt',
              kind: mode === 'repair' && planningCalls === 2 ? 'authoring' : 'implement',
              agentId: 'mori',
              dependencies: [],
              criterionIds: ['c1'],
            },
            {
              key: 'review',
              title: 'Review result',
              description: 'Read result.txt and review',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['write'],
              dependencyKinds: { write: 'artifact_available' },
              criterionIds: ['c1'],
            },
          ],
        }),
      ];
      if (mode === 'bad-plan' || (mode === 'repair' && planningCalls === 1)) calls = [];
      if (mode === 'chain') {
        const tasks = [
          {
            key: 'facts',
            title: 'Prepare facts',
            description: 'Read source.txt, publish facts.txt',
            kind: 'investigate',
            agentId: 'mori',
            dependencies: [],
            criterionIds: ['c1'],
          },
          {
            key: 'write',
            title: 'Write result',
            description: 'Use facts.txt and publish result.txt',
            kind: 'implement',
            agentId: 'mori',
            dependencies: ['facts'],
            criterionIds: ['c1'],
          },
          {
            key: 'review',
            title: 'Review result',
            description: 'Read and review result.txt',
            kind: 'review',
            agentId: 'luma',
            dependencies: ['write'],
            criterionIds: ['c1'],
          },
        ];
        if (planningCalls > 1)
          tasks.splice(1, 0, {
            key: 'review-facts',
            title: 'Review facts',
            description: 'Read and review facts.txt',
            kind: 'review',
            agentId: 'luma',
            dependencies: ['facts'],
            criterionIds: ['c1'],
          });
        calls = [tool('propose_plan', { tasks })];
      }
    } else if (input.task.kind !== 'review') {
      calls =
        mode === 'question'
          ? [
              tool('ask_input', {
                title: 'Need decision',
                detail: 'synthetic-secret-for-redaction',
                kind: 'approval',
              }),
            ]
          : [
              tool('workspace_write', {
                path: firstOutputPath(input),
                content: mode === 'wrong' ? 'wrong bytes' : 'verified result',
              }),
              tool('submit_artifact', {
                path: firstOutputPath(input),
                name: 'Result',
                mediaType: 'text/plain',
              }),
              tool('complete_task', { summary: 'Created' }),
            ];
    } else {
      const evidence = messages
        .filter((m: any) => m.role === 'tool')
        .map((m: any) => JSON.parse(m.content))
        .find((r: any) => r.evidenceId);
      calls = evidence
        ? [
            tool('submit_review', {
              verdict: 'pass',
              summary: 'Read exact bytes',
              evidenceIds: [evidence.evidenceId],
              versionIds: input.inputs.map((a: any) => a.versionId),
            }),
          ]
        : [
            tool('workspace_read', {
              path: mode === 'chain' ? input.inputs[0].relativePath : 'result.txt',
            }),
          ];
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: calls } }],
      }),
    );
  });
  function firstOutputPath(input: any): string {
    return mode === 'chain' && input.task.kind === 'investigate' ? 'facts.txt' : 'result.txt';
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return {
    root,
    requests,
    options: {
      scenario: scenarioSchema.parse(scenario),
      outputRoot: root,
      projectRoot: process.cwd(),
      mode: 'scripted' as const,
      provider: {
        kind: 'openai-compatible' as const,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: 'scripted-only',
        apiKey: 'synthetic-secret-for-redaction',
      },
      timeoutMs: 5000,
    },
  };
}
it('records missing credentials as not_run and does not create runtime data', async () => {
  const { options } = await fixture();
  const report = await runAcceptanceScenario({ ...options, provider: null });
  expect(report.status).toBe('not_run');
  expect(report.stages).toEqual([]);
  expect(await readdir(report.directory)).not.toContain('runtime');
});
it('runs the real runtime, checks immutable bytes, accepts and exports a unique sample', async () => {
  const { options } = await fixture();
  const report = await runAcceptanceScenario(options);
  expect(report.status, report.reason).toBe('passed');
  expect(report.mode).toBe('scripted');
  expect(report.stages[0].snapshot?.commission.status).toBe('accepted');
  expect(report.stages[0].checks.every((c) => c.status === 'passed')).toBe(true);
  expect(await readFile(join(report.directory, 'export-1', 'result.txt'), 'utf8')).toBe(
    'verified result',
  );
  expect(await readFile(join(report.directory, 'source', 'source.txt'), 'utf8')).toBe(
    'keep original',
  );
  const second = await runAcceptanceScenario(options);
  expect(second.directory).not.toBe(report.directory);
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8')).status).toBe(
    'passed',
  );
});
it('fails independent checks even when a model reviewer passes wrong bytes', async () => {
  const { options } = await fixture('wrong');
  const report = await runAcceptanceScenario(options);
  expect(report.status).toBe('failed');
  expect(report.stages[0].snapshot?.commission.acceptedArtifactIds).toEqual([]);
  expect(report.stages[0].checks.some((c) => c.status === 'failed')).toBe(true);
});
it('preserves an approval request without granting it and redacts echoed credentials', async () => {
  const { options } = await fixture('question');
  const report = await runAcceptanceScenario(options);
  expect(report.status).toBe('blocked');
  expect(report.stages[0].snapshot?.requests[0].status).toBe('open');
  expect(report.interventions).toBe(1);
  const json = await readFile(join(report.directory, 'report.json'), 'utf8');
  expect(json).not.toContain('synthetic-secret-for-redaction');
  expect(JSON.stringify(report)).not.toContain('synthetic-secret-for-redaction');
});
it('aborts hanging provider work at the wall-clock deadline and retains a report', async () => {
  const { options } = await fixture('hang');
  const report = await runAcceptanceScenario({ ...options, timeoutMs: 200 });
  expect(report.status).toBe('blocked');
  expect(report.reason).toContain('timeout');
  expect(report.stages[0].snapshot?.commission.status).toBe('paused');
});
it('records a caller cancellation without accepting artifacts', async () => {
  const { options, requests } = await fixture('hang');
  const controller = new AbortController();
  const run = runAcceptanceScenario({ ...options, signal: controller.signal });
  // This case exercises cancellation during a model call, after capability preflight.
  await expect.poll(() => requests.length, { timeout: 5000 }).toBeGreaterThan(0);
  controller.abort();
  const report = await run;
  expect(report.status).toBe('cancelled');
  expect(report.stages[0].snapshot?.commission.acceptedArtifactIds).toEqual([]);
});
it('rejects escaping seed/check paths before creating a workspace', () => {
  expect(() => scenarioSchema.parse({ ...scenario, seed: { '../escape': 'no' } })).toThrow();
  expect(() =>
    scenarioSchema.parse({
      ...scenario,
      stages: [
        { ...scenario.stages[0], checks: [{ kind: 'text', path: 'C:/outside.txt', equals: 'no' }] },
      ],
    }),
  ).toThrow();
});
it('repairs missing and invalid plans within the existing step budget', async () => {
  const { options } = await fixture('repair');
  const report = await runAcceptanceScenario(options);
  expect(report.status, report.reason).toBe('passed');
  expect(report.stages[0].snapshot?.events.filter((e) => e.type === 'plan_rejected')).toHaveLength(
    2,
  );
  expect(report.stages[0].snapshot?.commission.stepsUsed).toBeGreaterThanOrEqual(6);
});
it('bounds semantic plan retries and does not turn malformed plans into tasks', async () => {
  const { options } = await fixture('bad-plan');
  const report = await runAcceptanceScenario(options);
  expect(report.status).toBe('blocked');
  expect(report.stages[0].snapshot?.tasks).toEqual([]);
  expect(report.stages[0].snapshot?.commission.stepsUsed).toBe(3);
});
it('tells the model the real host environment and omits ungranted process/network tools', async () => {
  const { options, requests } = await fixture();
  expect((await runAcceptanceScenario(options)).status).toBe('passed');
  for (const request of requests) {
    expect(request.input.environment.platform).toBe(process.platform);
    expect(request.input.environment.nodeExecutable).toBe(process.execPath);
    expect(request.input.environment.allowProcess).toBe(false);
    expect(
      request.tools.some((tool: any) => ['process_run', 'web_read'].includes(tool.function.name)),
    ).toBe(false);
  }
});
it.skipIf(process.platform !== 'win32')(
  'does not call the provider when process supervision is unavailable',
  async () => {
    const { root, options, requests } = await fixture();
    const scriptScenario = scenarioSchema.parse({
      ...scenario,
      stages: [{ ...scenario.stages[0], checks: [{ kind: 'node', path: 'result.mjs', json: 42 }] }],
    });
    const report = await runAcceptanceScenario({
      ...options,
      scenario: scriptScenario,
      projectRoot: root,
      allowProcess: true,
    });
    expect(report.status).toBe('not_run');
    expect(requests).toEqual([]);
    expect(report.reason).toContain('supervisor');
  },
);
it('repairs an indirectly reviewed preparation plan and accepts every independently reviewed output', async () => {
  const { options } = await fixture('chain');
  const report = await runAcceptanceScenario(options);
  expect(report.status, report.reason).toBe('passed');
  const snapshot = report.stages[0].snapshot!;
  expect(snapshot.events.filter((e) => e.type === 'plan_rejected')).toHaveLength(1);
  expect(snapshot.tasks).toHaveLength(4);
  expect(snapshot.artifacts.map((a) => a.relativePath).sort()).toEqual(['facts.txt', 'result.txt']);
  expect(snapshot.commission.acceptedArtifactIds).toHaveLength(2);
  for (const artifact of snapshot.artifacts)
    expect(
      snapshot.evidence.some(
        (e) =>
          e.kind === 'review' &&
          e.status === 'passed' &&
          e.artifactVersionIds.includes(artifact.versionId),
      ),
    ).toBe(true);
});
