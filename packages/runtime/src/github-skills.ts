import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GITHUB_SKILL_MIN_STARS, isPartnerSkillRepository } from '../../contracts/src/index';
import type { AgentIdentity, Scope } from '../../contracts/src/index';
import type { StoredCall } from '../../persistence/src/index';

export const githubSkillHost = 'api.github.com';
export const githubSkillFindRepositories = 'github_skill_find_repositories';
export const githubSkillSearch = 'github_skill_search';
export const githubSkillAcquire = 'github_skill_acquire';
export const githubSkillCallKind = 'github_skill';
export const maxGitHubSkillSearches = 4;
export const maxGitHubSkillRepositorySearches = 3;
export const maxGitHubSkillAcquisitions = 4;
export const maxActiveGitHubSkills = 2;
export const maxActiveGitHubSkillBytes = 72 * 1024;
const maxSkillBytes = 48 * 1024;
const maxCandidates = 8;
const maxRepositoryCandidates = 8;
const maxRepositoryIndexResults = 24;
export const githubSkillRepositoryTopics = [
  'agent-skills',
  'skills',
  'ai',
  'api',
  'architecture',
  'automation',
  'browser',
  'charts',
  'ci',
  'code-review',
  'coding',
  'cpp',
  'csv',
  'data-analysis',
  'database',
  'design',
  'docker',
  'documentation',
  'docx',
  'electron',
  'excel',
  'frontend',
  'git',
  'github',
  'go',
  'html',
  'image',
  'javascript',
  'json',
  'kubernetes',
  'markdown',
  'ml',
  'nodejs',
  'office',
  'pdf',
  'powerpoint',
  'pptx',
  'presentation',
  'python',
  'react',
  'report',
  'research',
  'review',
  'rust',
  'slides',
  'software',
  'spreadsheet',
  'sql',
  'terraform',
  'testing',
  'typescript',
  'unreal-engine',
  'vue',
  'web',
  'windows',
  'word',
  'xlsx',
] as const;
const repositoryTopicSet = new Set<string>(githubSkillRepositoryTopics);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repositoryMetadata = z.object({
  full_name: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  stargazers_count: z.number().int().nonnegative(),
  visibility: z.string().optional(),
});
const repositoryInfo = repositoryMetadata.extend({ default_branch: z.string() });
const indexedRepository = repositoryMetadata.extend({
  description: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
});
const repositoryIndex = z.object({
  items: z.array(z.unknown()).max(maxRepositoryIndexResults),
  incomplete_results: z.boolean(),
});
const repositoryLead = z.object({
  repository: z.string().refine(isPartnerSkillRepository),
  stars: z.number().int().min(GITHUB_SKILL_MIN_STARS),
});
const repositoryDiscoveryReceipt = z.object({
  ok: z.literal(true),
  repositories: z.array(repositoryLead).max(maxRepositoryCandidates),
});
const branchRef = z.object({
  ref: z.string(),
  object: z.object({ sha, type: z.literal('commit') }),
});
const gitCommit = z.object({ sha, tree: z.object({ sha }) });
const entry = z.object({
  path: z.string(),
  sha,
  size: z.number().int().positive().max(maxSkillBytes),
  type: z.literal('blob'),
  mode: z.literal('100644'),
});
const gitTree = z.object({ sha, truncated: z.boolean(), tree: z.array(z.unknown()).max(10_000) });
const contentFile = z.object({
  type: z.literal('file'),
  path: z.string(),
  size: z.number().int().positive().max(maxSkillBytes),
  sha,
  encoding: z.literal('base64'),
  content: z.string(),
});

export interface GitHubSkillCandidate {
  id: string;
  repository: string;
  commit: string;
  path: string;
  blob: string;
  size: number;
}

export interface GitHubSkillReference extends GitHubSkillCandidate {
  name: string;
  content: string;
}

export type GitHubSkillAuthorization = { mode: 'public' | 'selected'; repositories: string[] };

export function githubSkillAuthorization(
  agent: AgentIdentity | undefined,
  scope: Scope,
): GitHubSkillAuthorization | undefined {
  if (
    !agent?.skills?.autoDiscover ||
    !scope.allowNetwork ||
    !scope.allowedHosts.some((host) => host.toLowerCase() === githubSkillHost)
  )
    return undefined;
  if (agent.skills.discoveryScope === 'public')
    return { mode: 'public', repositories: agent.skills.repositories };
  if (agent.skills.repositories.length)
    return { mode: 'selected', repositories: agent.skills.repositories };
}

export function githubSkillRepositoryAuthorized(
  authorization: GitHubSkillAuthorization,
  repository: unknown,
  calls: StoredCall[],
): repository is string {
  if (!isPartnerSkillRepository(repository)) return false;
  const key = repository.toLowerCase();
  return (
    authorization.repositories.some((name) => name.toLowerCase() === key) ||
    (authorization.mode === 'public' &&
      discoveredGitHubRepositories(calls).some((lead) => lead.repository.toLowerCase() === key))
  );
}

export function discoveredGitHubRepositories(calls: StoredCall[]) {
  const leads = new Map<string, z.infer<typeof repositoryLead>>();
  for (const call of calls) {
    if (call.state !== 'finished' || call.request.name !== githubSkillFindRepositories) continue;
    const result = repositoryDiscoveryReceipt.safeParse(call.result);
    if (!result.success) continue;
    for (const lead of result.data.repositories) leads.set(lead.repository.toLowerCase(), lead);
  }
  return [...leads.values()];
}

export function validateGitHubSkillRepositoryTopics(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 4 ||
    !value.every((topic) => typeof topic === 'string' && repositoryTopicSet.has(topic))
  )
    throw new Error(
      'Choose one to four public technical topics from the GitHub skill discovery tool',
    );
  return [...new Set(value)];
}

export function plannerPartner({ skills, ...agent }: AgentIdentity) {
  return {
    ...agent,
    ...(skills && {
      skills: skills.instructions.map(({ name, description }) => ({ name, description })),
    }),
  };
}

export function partnerWithoutSkillSettings({ skills: _skills, ...agent }: AgentIdentity) {
  return agent;
}

export function activeGitHubSkills(calls: StoredCall[]): GitHubSkillReference[] {
  return calls.flatMap((call) => {
    const result = call.result as { ok?: boolean; skill?: GitHubSkillReference } | undefined;
    return call.state === 'finished' &&
      call.request.name === githubSkillAcquire &&
      result?.ok &&
      result.skill
      ? [result.skill]
      : [];
  });
}

export function searchedGitHubCandidate(calls: StoredCall[], id: unknown) {
  for (const call of calls) {
    const result = call.result as { ok?: boolean; candidates?: GitHubSkillCandidate[] } | undefined;
    if (call.state !== 'finished' || call.request.name !== githubSkillSearch || !result?.ok)
      continue;
    const candidate = result.candidates?.find((item) => item.id === id);
    if (candidate) return candidate;
  }
}

function safePath(path: string): boolean {
  const parts = path.split('/');
  return (
    path.length <= 320 &&
    parts.length <= 12 &&
    parts.at(-1) === 'SKILL.md' &&
    parts.every((part) => /^[A-Za-z0-9._-]{1,90}$/.test(part) && part !== '.' && part !== '..')
  );
}

function repoEndpoint(repository: string): string {
  if (!isPartnerSkillRepository(repository)) throw new Error('Invalid GitHub skill repository');
  return `/repos/${repository}`;
}

function skillName(content: string, path: string, repository: string): string {
  const match = /^---\r?\n([\s\S]{1,4096}?)\r?\n---[ \t]*\r?\n([\s\S]*)$/.exec(content);
  if (!match || !match[2].trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content))
    throw new Error('Invalid SKILL.md: expected UTF-8 Markdown with skill frontmatter and a body');
  const frontmatter = match[1];
  const names = [
    ...frontmatter.matchAll(
      /^name:[ \t]*(['"]?)([a-z0-9]+(?:-[a-z0-9]+)*)\1[ \t]*(?:[ \t]#.*)?$/gm,
    ),
  ];
  const descriptions = [...frontmatter.matchAll(/^description:[ \t]*(.*)$/gm)];
  const name = names[0]?.[2];
  const description = descriptions[0]?.[1].trim();
  const expectedName = path.split('/').at(-2) ?? repository.split('/').at(-1)?.toLowerCase();
  const hasDescription =
    description &&
    description.length <= 1024 &&
    !/^(?:#|['"]{2}$|null$|~$)/i.test(description) &&
    (!/^[|>][+-]?\d?$/.test(description) || /^description:[^\n]*\n[ \t]+\S/m.test(frontmatter));
  if (
    names.length !== 1 ||
    (frontmatter.match(/^name:/gm)?.length ?? 0) !== 1 ||
    !name ||
    name.length > 64 ||
    name !== expectedName ||
    descriptions.length !== 1 ||
    !hasDescription
  )
    throw new Error('Invalid SKILL.md: expected a matching name and a description');
  return name;
}

function rateLimitError(headers: Headers): Error {
  const timing: string[] = [];
  const retryAfter = headers.get('retry-after') ?? '';
  if (/^\d{1,9}$/.test(retryAfter)) {
    timing.push(`Retry after ${Number(retryAfter)} seconds.`);
  } else if (/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)) {
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp))
      timing.push(`Retry after ${new Date(timestamp).toISOString()}.`);
  }
  const reset = headers.get('x-ratelimit-reset') ?? '';
  if (headers.get('x-ratelimit-remaining') === '0' && /^\d{1,12}$/.test(reset))
    timing.push(`Rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.`);
  if (!timing.length) timing.push('Wait at least one minute before retrying.');
  return new Error(
    `GitHub skill request reached the rate limit. ${timing.join(' ')} Use a configured local skill, or call ask_input if user guidance is required.`,
  );
}

function repositoryIneligibility(
  repository: z.infer<typeof repositoryMetadata>,
): string | undefined {
  if (
    repository.private ||
    (repository.visibility !== undefined && repository.visibility !== 'public')
  )
    return 'GitHub skill repository must be public';
  if (repository.archived) return 'GitHub skill repository is archived';
  if (repository.stargazers_count < GITHUB_SKILL_MIN_STARS)
    return `GitHub skill repository requires at least ${GITHUB_SKILL_MIN_STARS} stars`;
}

const skillTopics = new Set([
  'agent-skills',
  'ai-skills',
  'claude-skills',
  'claude-code-skills',
  'codex-skills',
  'opencode-skills',
  'skill-md',
  'skills-md',
]);

function hasSkillIdentity(repository: z.infer<typeof indexedRepository>): boolean {
  const name = repository.full_name.split('/').at(-1) ?? '';
  const description = repository.description ?? '';
  return (
    /(?:^|[._-])skills?(?:$|[._-])/i.test(name) ||
    !!repository.topics?.some((topic) => skillTopics.has(topic.toLowerCase())) ||
    /\b(?:skill\.md|(?:ai|agent|claude|codex)[ -]skills?)\b/i.test(description)
  );
}

export class GitHubSkillClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async findRepositories(keywords: string[], signal: AbortSignal) {
    const topics = validateGitHubSkillRepositoryTopics(keywords);
    const query = new URLSearchParams({
      q: [
        ...new Set(['skills', ...topics]),
        'in:name,description,topics,readme',
        'is:public',
        'archived:false',
        `stars:>=${GITHUB_SKILL_MIN_STARS}`,
        'fork:true',
      ].join(' '),
      sort: 'stars',
      order: 'desc',
      per_page: String(maxRepositoryIndexResults),
    });
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const index = repositoryIndex.safeParse(
      await this.json(`/search/repositories?${query}`, 512 * 1024, deadline),
    );
    if (!index.success)
      throw new Error('GitHub skill repository search response could not be verified');

    const seen = new Set<string>();
    const repositories = index.data.items.flatMap((item) => {
      const checked = indexedRepository.safeParse(item);
      if (
        !checked.success ||
        repositoryIneligibility(checked.data) ||
        !hasSkillIdentity(checked.data)
      )
        return [];
      const { full_name: repository, stargazers_count: stars } = checked.data;
      const key = repository.toLowerCase();
      if (!isPartnerSkillRepository(repository) || seen.has(key)) return [];
      seen.add(key);
      return [{ repository, stars }];
    });
    return {
      repositories: repositories.slice(0, maxRepositoryCandidates),
      incomplete: index.data.incomplete_results,
    };
  }

  private async verifyRepository(repository: string, root: string, signal: AbortSignal) {
    const result = repositoryInfo.safeParse(await this.json(root, 64 * 1024, signal));
    if (!result.success || result.data.full_name.toLowerCase() !== repository.toLowerCase())
      throw new Error('GitHub skill repository identity could not be verified');
    const reason = repositoryIneligibility(result.data);
    if (reason) throw new Error(reason);
    return result.data;
  }

  async search(
    repository: string,
    query: string,
    signal: AbortSignal,
  ): Promise<GitHubSkillCandidate[]> {
    const root = repoEndpoint(repository);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    deadline.throwIfAborted();
    // The model query may include private context. Rank paths in memory and omit the query from HTTP.
    const words = [
      ...new Set(
        query
          .normalize('NFKC')
          .toLowerCase()
          .match(/[a-z0-9]{2,}/g) ?? [],
      ),
    ];
    if (!words.length) return [];
    const branch = (await this.verifyRepository(repository, root, deadline)).default_branch;
    if (
      !branch ||
      branch.length > 200 ||
      !branch
        .split('/')
        .every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== '.' && part !== '..')
    )
      throw new Error('Invalid default branch for GitHub skill repository');
    const reference = branchRef.safeParse(
      await this.json(`${root}/git/ref/heads/${branch}`, 16 * 1024, deadline),
    );
    if (!reference.success || reference.data.ref !== `refs/heads/${branch}`)
      throw new Error('Could not resolve the GitHub skill repository default branch');
    const commit = reference.data.object.sha;
    const resolved = gitCommit.safeParse(
      await this.json(`${root}/git/commits/${commit}`, 128 * 1024, deadline),
    );
    if (!resolved.success || resolved.data.sha !== commit)
      throw new Error('GitHub skill repository commit could not be verified');
    const tree = resolved.data.tree.sha;
    const source = gitTree.safeParse(
      await this.json(`${root}/git/trees/${tree}?recursive=1`, 1024 * 1024, deadline),
    );
    if (!source.success || source.data.sha !== tree)
      throw new Error('GitHub skill repository tree could not be verified');
    if (source.data.truncated) throw new Error('GitHub skill repository tree was truncated');

    const candidates = source.data.tree.flatMap((value) => {
      const item = entry.safeParse(value);
      if (!item.success || !safePath(item.data.path)) return [];
      const { path, sha: blob, size } = item.data;
      const normalized = (
        path === 'SKILL.md' ? repository : path.slice(0, -'/SKILL.md'.length)
      ).toLowerCase();
      const score = words.reduce((count, word) => count + Number(normalized.includes(word)), 0);
      if (!score) return [];
      const id = createHash('sha256')
        .update(JSON.stringify([repository.toLowerCase(), commit, path, blob]))
        .digest('hex');
      return [{ score, candidate: { id, repository, commit, path, blob, size } }];
    });
    candidates.sort(
      (a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path),
    );
    return candidates.slice(0, maxCandidates).map(({ candidate }) => candidate);
  }

  async acquire(
    candidate: GitHubSkillCandidate,
    signal: AbortSignal,
  ): Promise<GitHubSkillReference> {
    const { repository, commit, path, blob, size } = candidate;
    const root = repoEndpoint(repository);
    if (!sha.safeParse(commit).success || !sha.safeParse(blob).success || !safePath(path))
      throw new Error('Invalid GitHub skill identity');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    await this.verifyRepository(repository, root, deadline);
    const file = contentFile.safeParse(
      await this.json(
        `${root}/contents/${path}?ref=${commit}`,
        2 * maxSkillBytes + 8 * 1024,
        deadline,
      ),
    );
    if (
      !file.success ||
      file.data.sha !== blob ||
      file.data.path !== path ||
      file.data.size !== size
    )
      throw new Error('GitHub skill path or blob did not match the selected candidate');
    const base64 = file.data.content.replace(/\r?\n/g, '');
    const bytes = Buffer.from(base64, 'base64');
    const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (bytes.length !== size || bytes.toString('base64') !== base64 || digest !== blob)
      throw new Error('GitHub skill bytes did not match the selected blob');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Invalid SKILL.md: expected UTF-8 Markdown');
    }
    return { ...candidate, name: skillName(content, path, repository), content };
  }

  private async json(path: string, limit: number, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const url = `https://${githubSkillHost}${path}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Astrisle',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      signal.throwIfAborted();
      throw new Error('GitHub skill request could not be completed');
    }
    signal.throwIfAborted();
    if (response.redirected || (response.url && response.url !== url)) {
      await response.body?.cancel().catch(() => {});
      throw new Error('GitHub skill response came from an unexpected URL');
    }
    if (!response.ok) {
      const headers = response.headers;
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')));
      if (response.status === 403 && !limited && response.body) {
        const payload = await this.readJson(response.body, 4096, signal).catch(() => undefined);
        signal.throwIfAborted();
        const message = z.object({ message: z.string() }).safeParse(payload);
        if (message.success && /secondary rate limit/i.test(message.data.message))
          throw rateLimitError(headers);
      } else {
        await response.body?.cancel().catch(() => {});
        if (limited) throw rateLimitError(headers);
      }
      if (response.status === 404)
        throw new Error(
          'GitHub skill repository or content is private, missing, or unavailable (HTTP 404)',
        );
      throw new Error(`GitHub skill request failed (HTTP ${response.status})`);
    }
    if (!response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => {});
      throw new Error('GitHub skill response was missing or exceeded its byte limit');
    }
    return this.readJson(response.body, limit, signal);
  }

  private async readJson(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) throw new Error('GitHub skill response exceeded its byte limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    signal.throwIfAborted();
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)),
      );
    } catch {
      throw new Error('GitHub skill response was not valid JSON');
    }
  }
}
