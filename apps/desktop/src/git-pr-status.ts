import { z } from 'zod';
import type { GitDeliveryReceipt, GitPullRequestStatus } from '@astrisle/contracts';

const ref = z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() });
const pull = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  head: ref.extend({ sha: z.string() }),
  base: ref,
});
const runs = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
});
const statuses = z.object({
  total_count: z.number().int().nonnegative(),
  statuses: z.array(z.object({ state: z.string() })),
});

export function deliveryRepository(receipt: GitDeliveryReceipt) {
  if (
    receipt.status !== 'published' ||
    !receipt.commit ||
    !/^(?:[\da-f]{40}|[\da-f]{64})$/.test(receipt.commit)
  )
    throw new Error('请先核查已推送的提交。');
  const match = /^https:\/\/github\.com\/([a-z\d][a-z\d-]*)\/([a-z\d._-]+?)(?:\.git)?\/?$/i.exec(
    receipt.preview.remote,
  );
  if (!match || ['.', '..'].includes(match[2])) throw new Error('此交付没有可打开的 GitHub 仓库。');
  return `${match[1]}/${match[2]}`;
}

export function comparePage(receipt: GitDeliveryReceipt) {
  const repository = deliveryRepository(receipt);
  return `https://github.com/${repository}/compare/${encodeURIComponent(receipt.preview.baseBranch)}...${encodeURIComponent(receipt.preview.targetBranch)}?expand=1`;
}

async function getJson(url: URL, fetcher: typeof fetch) {
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Astrisle-Git-Delivery' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`无法读取 GitHub 公开状态（HTTP ${response.status}）。也可以在 GitHub 查看。`);
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('GitHub 返回的数据过大，请在 GitHub 查看。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function checksFor(
  base: string,
  sha: string,
  fetcher: typeof fetch,
): Promise<GitPullRequestStatus['checks']> {
  try {
    const [check, legacy] = await Promise.all([
      getJson(new URL(`${base}/commits/${sha}/check-runs?per_page=100`), fetcher).then((v) =>
        runs.parse(v),
      ),
      getJson(new URL(`${base}/commits/${sha}/status?per_page=100`), fetcher).then((v) =>
        statuses.parse(v),
      ),
    ]);
    const outcomes = check.check_runs
      .map((r) => (r.status === 'completed' ? r.conclusion : 'pending'))
      .concat(legacy.statuses.map((s) => s.state));
    if (
      outcomes.some((x) =>
        [
          'failure',
          'error',
          'cancelled',
          'timed_out',
          'action_required',
          'stale',
          'startup_failure',
        ].includes(x ?? ''),
      )
    )
      return 'failed';
    if (outcomes.includes('pending')) return 'pending';
    if (
      check.total_count > check.check_runs.length ||
      legacy.total_count > legacy.statuses.length ||
      outcomes.some((x) => !['success', 'skipped', 'neutral'].includes(x ?? ''))
    )
      return 'unavailable';
    if (!outcomes.includes('success')) return 'none';
    return 'passed';
  } catch {
    return 'unavailable';
  }
}

export async function readPublishedPullRequest(
  receipt: GitDeliveryReceipt,
  fetcher: typeof fetch = fetch,
): Promise<GitPullRequestStatus | null> {
  const repository = deliveryRepository(receipt),
    lower = repository.toLowerCase();
  const { baseBranch, targetBranch } = receipt.preview;
  const api = `https://api.github.com/repos/${repository}`;
  const url = new URL(api + '/pulls');
  url.search = new URLSearchParams({
    state: 'all',
    base: baseBranch,
    head: repository.split('/')[0] + ':' + targetBranch,
    per_page: '100',
  }).toString();
  const matches = z
    .array(pull)
    .parse(await getJson(url, fetcher))
    .filter(
      (p) =>
        p.head.sha === receipt.commit &&
        p.head.ref === targetBranch &&
        p.head.repo?.full_name.toLowerCase() === lower &&
        p.base.ref === baseBranch &&
        p.base.repo?.full_name.toLowerCase() === lower,
    );
  const pr = matches.find((p) => p.state === 'open') ?? matches[0];
  if (!pr) return null;
  return {
    number: pr.number,
    url: `https://github.com/${repository}/pull/${pr.number}`,
    state: pr.merged_at ? 'merged' : pr.state,
    checks: await checksFor(api, pr.head.sha, fetcher),
  };
}
