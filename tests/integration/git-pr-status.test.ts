import { expect, it, vi } from 'vitest';
import { readPublishedPullRequest } from '../../apps/desktop/src/git-pr-status';
import type { GitDeliveryReceipt } from '../../packages/contracts/src/git-delivery';

const sha = '7'.repeat(40);
const target = 'astrisle/delivery-1';
const receipt: GitDeliveryReceipt = {
  preview: {
    operationId: 'op',
    revision: 1,
    acceptedVersionIds: ['version'],
    commissionId: 'commission',
    remote: 'https://github.com/sample/studio.git',
    baseBranch: 'main',
    baseCommit: '3'.repeat(40),
    targetBranch: target,
    changes: [],
    diff: '',
    diffTruncated: false,
  },
  status: 'published',
  commit: sha,
  compareUrl: 'https://github.com/sample/studio/compare/main...astrisle/delivery-1?expand=1',
  message: null,
  updatedAt: '2026-11-25',
};
const pr = {
  number: 19,
  state: 'open',
  merged_at: null,
  head: { sha, ref: target, repo: { full_name: 'sample/studio' } },
  base: { ref: 'main', repo: { full_name: 'sample/studio' } },
};
const reply = (data: unknown) => new Response(JSON.stringify(data));

it('reads public PR and CI for the confirmed repository, branch and exact pushed commit', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(reply([pr]))
    .mockResolvedValueOnce(
      reply({
        total_count: 2,
        check_runs: [
          { status: 'completed', conclusion: 'success' },
          { status: 'in_progress', conclusion: null },
        ],
      }),
    )
    .mockResolvedValueOnce(reply({ total_count: 0, statuses: [] }));
  const result = await readPublishedPullRequest(receipt, fetcher);
  expect(result).toMatchObject({
    number: 19,
    url: 'https://github.com/sample/studio/pull/19',
    state: 'open',
    checks: 'pending',
  });
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(
    Array(3).fill('api.github.com'),
  );
  expect(fetcher.mock.calls.slice(1).every(([url]) => String(url).includes(sha))).toBe(true);
});

it('does not attribute another head commit or fork to the published change', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    reply([
      { ...pr, head: { ...pr.head, sha: 'a'.repeat(40) } },
      { ...pr, head: { ...pr.head, repo: { full_name: 'someone/studio' } } },
    ]),
  );
  expect(await readPublishedPullRequest(receipt, fetcher)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('keeps failed legacy statuses visible and reports inaccessible checks separately', async () => {
  const failed = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(reply([{ ...pr, state: 'closed', merged_at: '2026-11-25T01:00:00Z' }]))
    .mockResolvedValueOnce(
      reply({ total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] }),
    )
    .mockResolvedValueOnce(reply({ total_count: 1, statuses: [{ state: 'failure' }] }));
  expect(await readPublishedPullRequest(receipt, failed)).toMatchObject({
    state: 'merged',
    checks: 'failed',
  });
  const unavailable = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(reply([pr]))
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(reply({ total_count: 0, statuses: [] }));
  expect(await readPublishedPullRequest(receipt, unavailable)).toMatchObject({
    number: 19,
    checks: 'unavailable',
  });
});
