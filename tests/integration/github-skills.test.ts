import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentIdentity, RuntimeOptions } from '../../packages/contracts/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { GitHubSkillClient } from '../../packages/runtime/src/github-skills';
import { createRuntime } from '../../packages/runtime/src/index';
import { waitForDelivery } from '../fixtures/wait-for-delivery';

const repo = 'public-team/skill-library';
const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const path = 'skills/report-format/SKILL.md';
const markdown =
  '---\nname: report-format\ndescription: Format reports.\n---\n# Report\n\nUse a dated heading.';
const root = `https://api.github.com/repos/${repo}`;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

function fakeGitHub({
  file = markdown,
  downloaded = file,
  truncated = false,
  repository = repo,
  repoStatus = 200,
  repoHeaders = {},
  repoMessage,
  repoPrivate = false,
  repoArchived = false,
  repoStars = 900,
  filename = path,
  responsePath = filename,
}: {
  file?: string;
  downloaded?: string;
  truncated?: boolean;
  repository?: string;
  repoStatus?: number;
  repoHeaders?: Record<string, string>;
  repoMessage?: string;
  repoPrivate?: boolean;
  repoArchived?: boolean;
  repoStars?: number;
  filename?: string;
  responsePath?: string;
} = {}) {
  const blob = createHash('sha1')
    .update(`blob ${Buffer.byteLength(file)}\0`)
    .update(file)
    .digest('hex');
  const requests = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', method: 'GET' });
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    if (new URL(url).pathname === '/search/repositories')
      return Response.json({
        incomplete_results: false,
        items: [
          {
            full_name: repo,
            private: false,
            archived: false,
            stargazers_count: 900,
            description: 'UNTRUSTED_DESCRIPTION',
          },
          {
            full_name: 'public-team/generic-awesome-list',
            private: false,
            archived: false,
            stargazers_count: 10000,
            description: 'A broad catalogue of public information and tools.',
          },
          {
            full_name: 'public-team/atlas',
            private: false,
            archived: false,
            stargazers_count: 750,
            topics: ['agent-skills'],
            description: 'UNTRUSTED_DESCRIPTION_TOPIC',
          },
          {
            full_name: 'public-team/small-skill',
            private: false,
            archived: false,
            stargazers_count: 99,
          },
          {
            full_name: 'public-team/old-skill',
            private: false,
            archived: true,
            stargazers_count: 2000,
          },
          {
            full_name: 'public-team/private-skill',
            private: true,
            archived: false,
            stargazers_count: 2000,
          },
          {
            full_name: 'https://redirect.example/instructions',
            private: false,
            archived: false,
            stargazers_count: 3000,
          },
        ],
      });
    if (url === root)
      return Response.json(
        repoMessage
          ? { message: repoMessage }
          : {
              full_name: repository,
              private: repoPrivate,
              archived: repoArchived,
              stargazers_count: repoStars,
              default_branch: 'main',
            },
        { status: repoStatus, headers: repoHeaders },
      );
    if (url === `${root}/git/ref/heads/main`)
      return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: commit } });
    if (url === `${root}/git/commits/${commit}`)
      return Response.json({ sha: commit, tree: { sha: tree } });
    if (url === `${root}/git/trees/${tree}?recursive=1`)
      return Response.json({
        sha: tree,
        truncated,
        tree: [
          {
            path: filename,
            type: 'blob',
            mode: '100644',
            sha: blob,
            size: Buffer.byteLength(file),
          },
          { path: 'other/unsafe/SKILL.md', type: 'blob', mode: '120000', sha: blob, size: 10 },
          { path: 'other/script/SKILL.md', type: 'blob', mode: '100755', sha: blob, size: 10 },
        ],
      });
    if (url === `${root}/contents/${filename}?ref=${commit}`)
      return Response.json({
        type: 'file',
        path: responsePath,
        sha: blob,
        size: Buffer.byteLength(file),
        encoding: 'base64',
        content: Buffer.from(downloaded).toString('base64'),
        download_url: 'https://other-site.example/untrusted',
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  return { requests, blob };
}

it('reads only the candidate SKILL.md at the verified commit and keeps private search terms local', async () => {
  const { requests, blob } = fakeGitHub();
  const client = new GitHubSkillClient(requests);
  const signal = new AbortController().signal;
  const [candidate] = await client.search(repo, 'report/format internal-token', signal);
  expect(candidate).toMatchObject({ repository: repo, commit, path, blob });
  expect(await client.acquire(candidate, signal)).toMatchObject({
    repository: repo,
    commit,
    path,
    blob,
    content: markdown,
    name: 'report-format',
  });
  expect(requests).toHaveBeenCalledTimes(6);
  expect(requests.mock.calls.every(([url]) => !String(url).includes('internal-token'))).toBe(true);
});

it('uses only public topic keywords and returns filtered repository names and stars', async () => {
  const { requests } = fakeGitHub();
  const client = new GitHubSkillClient(requests);
  const signal = new AbortController().signal;
  await expect(client.findRepositories(['PrivateCompanyToken'], signal)).rejects.toThrow(/topic/i);
  expect(requests).not.toHaveBeenCalled();
  expect(await client.findRepositories(['report'], signal)).toEqual({
    repositories: [
      { repository: repo, stars: 900 },
      { repository: 'public-team/atlas', stars: 750 },
    ],
    incomplete: false,
  });
  const indexed = new URL(String(requests.mock.calls[0][0]));
  expect(indexed.pathname).toBe('/search/repositories');
  expect(indexed.searchParams.get('q')).toMatch(
    /skills report .*is:public .*archived:false .*stars:>=100/,
  );
  expect(indexed.searchParams.get('sort')).toBe('stars');
  expect(indexed.searchParams.get('order')).toBe('desc');
});

it.each([
  { repoPrivate: true, reason: /public/i },
  { repoArchived: true, reason: /archived/i },
  { repoStars: 99, reason: /100 stars/i },
  { repoStatus: 404, reason: /private, missing, or unavailable/i },
])(
  'rejects ineligible GitHub repositories before inspecting a tree ($reason)',
  async ({ reason, ...options }) => {
    const { requests } = fakeGitHub(options);
    const client = new GitHubSkillClient(requests);
    await expect(client.search(repo, 'report', new AbortController().signal)).rejects.toThrow(
      reason,
    );
    expect(requests).toHaveBeenCalledTimes(1);
  },
);

it('revalidates repository eligibility before downloading a selected candidate', async () => {
  const { requests } = fakeGitHub();
  const client = new GitHubSkillClient(requests);
  const signal = new AbortController().signal;
  const [candidate] = await client.search(repo, 'report', signal);
  requests.mockResolvedValueOnce(
    Response.json({
      full_name: repo,
      private: false,
      archived: true,
      stargazers_count: 900,
      default_branch: 'main',
    }),
  );
  await expect(client.acquire(candidate, signal)).rejects.toThrow(/archived/i);
  expect(requests.mock.calls.some(([url]) => String(url).includes('/contents/'))).toBe(false);
});

it('accepts a valid standalone skill from a repository root', async () => {
  const skill = markdown.replace('name: report-format', 'name: skill-library');
  const { requests } = fakeGitHub({ filename: 'SKILL.md', file: skill });
  const client = new GitHubSkillClient(requests);
  const signal = new AbortController().signal;
  const [candidate] = await client.search(repo, 'skill-library', signal);
  expect(await client.acquire(candidate, signal)).toMatchObject({
    path: 'SKILL.md',
    name: 'skill-library',
    content: skill,
  });
});

it('returns only path matches and accepts English keywords alongside a localized query', async () => {
  const { requests } = fakeGitHub();
  const client = new GitHubSkillClient(requests);
  const signal = new AbortController().signal;
  await expect(client.search(repo, '演示文稿', signal)).resolves.toEqual([]);
  expect(requests).not.toHaveBeenCalled();
  await expect(client.search(repo, '演示文稿 pptx', signal)).resolves.toEqual([]);
  await expect(client.search(repo, '报告 ＲＥＰＯＲＴ', signal)).resolves.toEqual([
    expect.objectContaining({ path }),
  ]);
});

it.each<{
  repoStatus: number;
  repoHeaders: Record<string, string>;
  timing: string;
  repoMessage?: string;
}>([
  { repoStatus: 429, repoHeaders: { 'Retry-After': '120' }, timing: '120 seconds' },
  {
    repoStatus: 403,
    repoHeaders: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1790000000' },
    timing: new Date(1790000000000).toISOString(),
  },
  {
    repoStatus: 403,
    repoHeaders: {},
    repoMessage: 'You have exceeded a secondary rate limit.',
    timing: 'at least one minute',
  },
])(
  'reports GitHub rate-limit timing with a local fallback ($repoStatus)',
  async ({ repoStatus, repoHeaders, timing, repoMessage }) => {
    const { requests } = fakeGitHub({ repoStatus, repoHeaders, repoMessage });
    const client = new GitHubSkillClient(requests);
    const search = client.search(repo, 'report', new AbortController().signal);
    await expect(search).rejects.toThrow(timing);
    await expect(search).rejects.toThrow(/configured local skill|ask_input/i);
    expect(requests).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { fixtures: { downloaded: markdown.replace('dated', 'short') }, reason: /blob/i },
  { fixtures: { responsePath: 'other/report-format/SKILL.md' }, reason: /path or blob/i },
  { fixtures: { file: 'This is not a skill.' }, reason: /SKILL\.md/i },
  {
    fixtures: { file: markdown.replace('name: report-format', 'name: different') },
    reason: /SKILL\.md/i,
  },
])('rejects bad markdown identity or bytes ($reason)', async ({ fixtures, reason }) => {
  const { requests } = fakeGitHub(fixtures);
  const client = new GitHubSkillClient(requests);
  const signal = new AbortController().signal;
  const [candidate] = await client.search(repo, 'report-format', signal);
  await expect(client.acquire(candidate, signal)).rejects.toThrow(reason);
});

it.each([
  { fixtures: { truncated: true }, reason: /truncated/i },
  { fixtures: { repository: 'other-team/other-library' }, reason: /repository identity/i },
  { fixtures: { repoStatus: 429 }, reason: /rate limit/i },
])(
  'stops discovery when GitHub cannot verify the source ($reason)',
  async ({ fixtures, reason }) => {
    const { requests } = fakeGitHub(fixtures);
    const client = new GitHubSkillClient(requests);
    await expect(client.search(repo, 'report', new AbortController().signal)).rejects.toThrow(
      reason,
    );
  },
);

it('stops before the first request when cancelled', async () => {
  const { requests } = fakeGitHub();
  const client = new GitHubSkillClient(requests);
  await expect(client.search(repo, 'report', AbortSignal.abort())).rejects.toThrow();
  expect(requests).not.toHaveBeenCalled();
});

const authorManual = 'AN-AUTHOR-MANUAL-ONLY';
const reviewManual = 'A-REVIEW-MANUAL-ONLY';
const remoteTail = 'THE-PINNED-REMOTE-INSTRUCTION';
const authorRepoUnauthorized = 'other-owner/not-an-approved-source';
const undisclosedRepo = 'private-company/private-project';
const reviewerRepo = 'public-team/review-library';
const authorOutput = 'report.md';
const toolCall = (name: string, args: Record<string, unknown>) => ({
  id: randomUUID(),
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
type ModelInput = {
  messages: Array<{
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<ReturnType<typeof toolCall>>;
  }>;
  tools: Array<{ function: { name: string } }>;
};

async function commission(mode: 'selected' | 'public' | 'public-known' | 'disabled') {
  const discover = mode !== 'disabled';
  const originalSkill = `${markdown}\n\n${'使用标题和分栏。\n'.repeat(1300)}\n\n${remoteTail}`;
  expect(Buffer.byteLength(originalSkill)).toBeGreaterThan(30 * 1024);
  const { requests, blob } = fakeGitHub({ file: originalSkill });
  const modelInputs: ModelInput[] = [];
  const toolResults: Array<{ name: string; result: any }> = [];
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-github-skills-')));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  let pinnedCandidate: string | undefined;
  let resumedAfterDiscovery = false;
  let resumed = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const request = JSON.parse(raw) as ModelInput;
    modelInputs.push(request);
    const context = JSON.parse(request.messages.find((m) => m.role === 'user')!.content);
    const receipts = request.messages
      .filter((m) => m.role === 'tool')
      .map((m) => ({
        name: request.messages
          .flatMap((item) => item.tool_calls ?? [])
          .find((item) => item.id === m.tool_call_id)!.function.name,
        result: JSON.parse(m.content),
      }));
    toolResults.push(...receipts);
    const success = (name: string) =>
      receipts.find((entry) => entry.name === name && entry.result.ok)?.result;
    const tried = (name: string) => receipts.some((entry) => entry.name === name);
    let calls;
    if (!context.task) {
      calls = [
        toolCall('propose_plan', {
          tasks: [
            {
              key: 'author',
              title: 'Author',
              description: 'Write the report',
              kind: 'implement',
              agentId: 'mori',
              dependencies: [],
              criterionIds: ['c1'],
            },
            {
              key: 'review',
              title: 'Reviewer',
              description: 'Inspect the actual report',
              kind: 'review',
              agentId: 'luma',
              dependencies: ['author'],
              dependencyKinds: { author: 'artifact_available' },
              criterionIds: ['c1'],
            },
          ],
        }),
      ];
    } else if (context.task.kind === 'review') {
      const read = success('workspace_read');
      calls = read
        ? [
            toolCall('submit_review', {
              verdict: 'pass',
              summary: 'Report inspected',
              evidenceIds: [read.evidenceId],
              versionIds: [context.inputs[0].versionId],
            }),
          ]
        : [
            ...(pinnedCandidate
              ? [toolCall('github_skill_acquire', { candidateId: pinnedCandidate })]
              : []),
            toolCall('workspace_read', { path: authorOutput }),
          ];
    } else if (discover && !resumed) {
      if (success('github_skill_acquire')) return; // Shutdown interrupts this response after the durable receipt.
      const selected = success('github_skill_search')?.candidates[0];
      const newlyFound = success('github_skill_find_repositories')?.repositories[0]?.repository;
      if (mode === 'public' && newlyFound && !resumedAfterDiscovery) return;
      const foundRepository = newlyFound ?? context.discoveredGitHubRepositories?.[0]?.repository;
      if (selected) {
        pinnedCandidate = selected.id;
        calls = [
          toolCall('github_skill_acquire', { candidateId: pinnedCandidate }),
          toolCall('process_run', { command: process.execPath, args: ['-v'] }),
          ...(mode === 'public'
            ? [toolCall('github_skill_search', { repository: undisclosedRepo, query: 'report' })]
            : []),
        ];
      } else if (mode === 'public-known') {
        calls = [toolCall('github_skill_search', { repository: repo, query: 'report' })];
      } else if (mode === 'public') {
        calls = foundRepository
          ? [toolCall('github_skill_search', { repository: foundRepository, query: 'report' })]
          : [
              toolCall('github_skill_search', { repository: undisclosedRepo, query: 'report' }),
              toolCall('github_skill_find_repositories', { keywords: ['PrivateCompanyToken'] }),
              toolCall('github_skill_find_repositories', { keywords: ['report'] }),
            ];
      } else {
        calls = [
          toolCall('github_skill_find_repositories', { keywords: ['report'] }),
          toolCall('github_skill_search', { repository: authorRepoUnauthorized, query: 'report' }),
          toolCall('github_skill_search', { repository: repo, query: 'report' }),
        ];
      }
    } else if (!discover && !tried('github_skill_search')) {
      calls = [
        toolCall('github_skill_find_repositories', { keywords: ['report'] }),
        toolCall('github_skill_search', { repository: repo, query: 'report' }),
      ];
    } else if (!success('workspace_write')) {
      const marker = context.activeGitHubSkills?.[0]?.content?.includes(remoteTail)
        ? 'Used the acquired skill.'
        : 'Used the local skill.';
      calls = [
        toolCall('workspace_write', { path: authorOutput, content: `# Report\n\n${marker}` }),
      ];
    } else {
      calls = [
        toolCall('submit_artifact', {
          path: authorOutput,
          name: 'Report',
          mediaType: 'text/markdown',
        }),
        toolCall('complete_task', { summary: 'Report delivered' }),
      ];
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: calls } }] }));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address() as { port: number };
  const executor = createExecutor({ projectRoot: process.cwd() });
  const runTool = vi.fn(executor.execute);
  const options: RuntimeOptions = {
    dataRoot,
    executor: { ...executor, execute: runTool },
    githubSkillFetch: requests,
    getCredentials: async () => ({
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: 'skills-test',
      apiKey: 'provider-only-fixture-key',
    }),
  };
  let runtime = createRuntime(options);
  cleanup.push(() => runtime.close());
  const workspace = await runtime.createWorkspace({ name: 'Skill test workspace' });
  const roster: AgentIdentity[] = [
    {
      id: 'mori',
      name: 'Mori',
      temperament: 'explorer',
      skills: {
        instructions: [
          { name: 'Author local guide', description: 'Drafting reports', content: authorManual },
        ],
        autoDiscover: true,
        ...(mode === 'selected'
          ? { repositories: [repo] }
          : {
              repositories: mode === 'public-known' ? [repo.toUpperCase()] : [],
              discoveryScope: 'public' as const,
            }),
      },
    },
    {
      id: 'luma',
      name: 'Luma',
      temperament: 'organizer',
      skills: {
        instructions: [{ name: 'Reviewer local guide', content: reviewManual }],
        autoDiscover: true,
        repositories: [reviewerRepo],
      },
    },
  ];
  const { commissionId, ok } = await runtime.submit(
    {
      requestId: 'skill-commission',
      workspaceId: workspace.id,
      goal: 'Produce and independently review a report.',
      criteria: ['The report exists and was independently read.'],
      planningMode: 'auto',
      scope: {
        allowProcess: true,
        allowNetwork: true,
        allowedHosts: discover ? ['api.github.com'] : ['github.com'],
        readRoots: [],
        writeRoots: [],
      },
      budget: { maxSteps: 30, maxMinutes: 1, maxRework: 2 },
    },
    roster,
  );
  expect(ok).toBe(true);
  roster[0].skills!.instructions[0].content = 'CHANGED-AFTER-SUBMISSION';
  if (mode === 'public') {
    await vi.waitFor(
      () =>
        expect(
          modelInputs
            .at(-1)
            ?.messages.find(
              (entry) => entry.role === 'tool' && entry.content.includes(`"repository":"${repo}"`),
            ),
        ).toBeDefined(),
      { timeout: 10_000 },
    );
    await runtime.close();
    resumedAfterDiscovery = true;
    runtime = createRuntime(options);
    expect((await runtime.control(commissionId!, 'resume')).ok).toBe(true);
  }
  if (discover) {
    await vi.waitFor(
      () =>
        expect(
          modelInputs
            .at(-1)
            ?.messages.find((entry) => entry.role === 'tool' && entry.content.includes(remoteTail)),
        ).toBeDefined(),
      { timeout: 10_000 },
    );
    const before = await runtime.snapshot(commissionId!);
    const source = before.evidence.find((entry) =>
      entry.summary.startsWith('Activated GitHub skill'),
    );
    expect(source).toMatchObject({
      taskId: before.tasks.find((task) => task.agentId === 'mori')?.id,
    });
    expect(JSON.parse(source!.detail).source).toMatchObject({
      repository: repo,
      commit,
      path,
      blob,
    });
    expect(source!.detail).not.toContain(remoteTail);
    await runtime.close();
    resumed = true;
    runtime = createRuntime({
      ...options,
      githubSkillFetch: vi.fn(async () => {
        throw new Error('Unexpected GitHub request after restart');
      }),
    });
    expect((await runtime.control(commissionId!, 'resume')).ok).toBe(true);
  }
  const snapshot = await waitForDelivery(runtime, commissionId!);
  const preview = await runtime.artifact(snapshot.artifacts[0].id);
  return { snapshot, preview, requests, modelInputs, toolResults, runTool, originalSkill };
}

it(
  'uses distinct captured skills and resumes the exact activated GitHub document with independent review',
  { timeout: 30_000 },
  async () => {
    const { requests, preview, modelInputs, toolResults, runTool, originalSkill } =
      await commission('selected');
    expect(preview.content).toContain('Used the acquired skill.');
    expect(requests).toHaveBeenCalledTimes(6);
    const prompts = modelInputs.map(({ messages, tools }) => ({
      context: JSON.parse(messages.find((m) => m.role === 'user')!.content),
      tools: tools.map((t) => t.function.name),
    }));
    expect(prompts.flatMap(({ tools }) => tools)).not.toContain('github_skill_find_repositories');
    expect(prompts[0].context.agents[0].skills).toEqual([
      { name: 'Author local guide', description: 'Drafting reports' },
    ]);
    expect(JSON.stringify(prompts[0].context)).not.toContain(authorManual);
    for (const { context, tools } of prompts.filter(
      ({ context }) => context.task?.kind === 'implement',
    )) {
      expect(context.configuredPartnerSkills[0].content).toBe(authorManual);
      expect(JSON.stringify(context)).not.toContain(reviewManual);
      if (context.activeGitHubSkills) {
        expect(context.activeGitHubSkills[0].content).toBe(originalSkill);
        expect(tools).not.toContain('process_run');
      }
    }
    const review = prompts.find(({ context }) => context.task?.kind === 'review')!.context;
    expect(review.configuredPartnerSkills[0].content).toBe(reviewManual);
    expect(JSON.stringify(review)).not.toContain(authorManual);
    expect(JSON.stringify(review)).not.toContain(remoteTail);
    expect(runTool.mock.calls.map(([name]) => name)).toEqual(['workspace_write', 'workspace_read']);
    expect(toolResults).toContainEqual(
      expect.objectContaining({
        name: 'github_skill_search',
        result: expect.objectContaining({ ok: false }),
      }),
    );
    expect(toolResults).toContainEqual(
      expect.objectContaining({
        name: 'github_skill_acquire',
        result: expect.objectContaining({ ok: false }),
      }),
    );
    expect(toolResults).toContainEqual(
      expect.objectContaining({
        name: 'process_run',
        result: expect.objectContaining({ ok: false }),
      }),
    );
  },
);

it(
  'withholds GitHub tools without an exact authorized API host while still using local skills',
  { timeout: 30_000 },
  async () => {
    const { requests, preview, modelInputs, toolResults } = await commission('disabled');
    expect(preview.content).toContain('Used the local skill.');
    expect(requests).not.toHaveBeenCalled();
    expect(modelInputs.flatMap(({ tools }) => tools.map((t) => t.function.name))).not.toContain(
      'github_skill_search',
    );
    expect(modelInputs.flatMap(({ tools }) => tools.map((t) => t.function.name))).not.toContain(
      'github_skill_find_repositories',
    );
    expect(toolResults).toContainEqual(
      expect.objectContaining({
        name: 'github_skill_search',
        result: expect.objectContaining({ ok: false }),
      }),
    );
  },
);

it(
  'discovers and applies a new popular public skill during a commission with no repository configuration',
  { timeout: 30_000 },
  async () => {
    const { snapshot, requests, preview, toolResults, runTool } = await commission('public');
    expect(snapshot.agents.find(({ id }) => id === 'mori')?.skills).toMatchObject({
      discoveryScope: 'public',
      repositories: [],
    });
    expect(preview.content).toContain('Used the acquired skill.');
    expect(requests).toHaveBeenCalledTimes(7);
    const requestsMade = requests.mock.calls.map(([url]) => new URL(String(url)));
    expect(requestsMade[0].pathname).toBe('/search/repositories');
    expect(requestsMade[1].pathname).toBe(`/repos/${repo}`);
    expect(requestsMade.at(-1)!.searchParams.get('ref')).toBe(commit);
    expect(JSON.stringify(toolResults)).not.toContain('UNTRUSTED_DESCRIPTION');
    expect(
      requestsMade.some(
        (url) => url.href.includes('PrivateCompanyToken') || url.href.includes(undisclosedRepo),
      ),
    ).toBe(false);
    expect(
      toolResults.filter(({ name, result }) => name === 'github_skill_search' && !result.ok).length,
    ).toBeGreaterThanOrEqual(2);
    expect(runTool.mock.calls.map(([name]) => name)).toEqual(['workspace_write', 'workspace_read']);
    expect(toolResults).toContainEqual(
      expect.objectContaining({
        name: 'process_run',
        result: expect.objectContaining({ ok: false }),
      }),
    );
  },
);

it(
  'can inspect an explicitly configured popular public repository without a preceding index search',
  { timeout: 30_000 },
  async () => {
    const { requests, preview } = await commission('public-known');
    expect(preview.content).toContain('Used the acquired skill.');
    expect(requests).toHaveBeenCalledTimes(6);
    expect(String(requests.mock.calls[0][0])).toBe(root);
  },
);
