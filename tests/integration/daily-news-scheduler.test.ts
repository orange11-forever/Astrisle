import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntime } from '../../packages/runtime/src/index';
import type { DailyNewsSettings, RuntimeOptions } from '../../packages/contracts/src/index';
import { DailyNewsCollectionError } from '../../packages/runtime/src/daily-news-collector';

const { collect } = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock(import('../../packages/runtime/src/daily-news-collector'), async (importOriginal) => ({
  ...(await importOriginal()),
  collectDailyNews: collect,
}));

const settings: DailyNewsSettings = {
  enabled: true,
  time: '08:30',
  topic: '技术新闻',
  feeds: ['https://example.com/news.xml'],
};
const delivered = {
  items: [
    {
      title: 'New public report',
      url: 'https://example.com/report',
      publishedAt: '2026-11-23T00:30:00.000Z',
      summary: 'A new public report has been released.',
    },
  ],
  message: 'Latest public report',
};
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  try {
    for (const action of cleanup.splice(0).reverse()) await action();
  } finally {
    vi.useRealTimers();
    collect.mockReset();
  }
});

async function fixture() {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-daily-news-')));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 23, 7, 0));
  const options: RuntimeOptions = {
    dataRoot,
    getCredentials: async () => null,
    executor: {
      definitions: () => [],
      execute: async () => ({ ok: false, output: 'No tools' }),
      capabilities: async () => [],
    },
  };
  function open() {
    const runtime = createRuntime(options);
    cleanup.push(() => runtime.close());
    return runtime;
  }
  const runtime = open();
  const workspace = await runtime.createWorkspace({ name: 'News fixture' });
  return { runtime, id: workspace.id, open, dataRoot };
}

it('leaves each mailbox disabled until enabled, then stores one issue per island and date', async () => {
  const { runtime, id } = await fixture();
  const other = await runtime.createWorkspace({ name: 'Other island' });
  collect.mockResolvedValue(delivered);
  expect(await runtime.getDailyNewsMailbox(id)).toMatchObject({
    settings: { enabled: false },
    issues: [],
  });

  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);

  expect((await runtime.getDailyNewsMailbox(id)).issues).toMatchObject([
    { date: '2026-11-23', status: 'delivered', itemCount: 1 },
  ]);
  expect(await runtime.getDailyNewsIssue(id, '2026-11-23')).toMatchObject(delivered);
  expect((await runtime.getDailyNewsMailbox(other.id)).issues).toEqual([]);
  expect(collect).toHaveBeenCalledTimes(1);
});

it('catches up missed dates after restart and prioritizes today once it is due', async () => {
  const { runtime, id, open } = await fixture();
  collect.mockResolvedValue({ items: [], message: 'No eligible items' });
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await runtime.close();

  vi.setSystemTime(new Date(2026, 10, 25, 9, 0));
  const started = open();
  await vi.advanceTimersByTimeAsync(0);
  expect((await started.getDailyNewsMailbox(id)).issues).toMatchObject([
    { date: '2026-11-25', status: 'empty', itemCount: 0 },
    { date: '2026-11-24', status: 'empty', itemCount: 0 },
    { date: '2026-11-23', status: 'empty', itemCount: 0 },
  ]);
  expect(collect.mock.calls.map(([call]) => call.date)).toEqual([
    '2026-11-23',
    '2026-11-25',
    '2026-11-24',
  ]);

  await started.close();
  open();
  await vi.advanceTimersByTimeAsync(0);
  expect(collect).toHaveBeenCalledTimes(3);
});

it('catches up missed dates on resume before today is due, without an unbounded pending batch', async () => {
  const { runtime, id } = await fixture();
  collect.mockResolvedValue({ items: [], message: 'No eligible items' });
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);

  let finish!: (result: { items: []; message: string }) => void;
  collect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  vi.setSystemTime(new Date(2026, 10, 29, 8, 0));
  expect(await runtime.getDailyNewsWakeState()).toEqual({
    schedules: [{ workspaceId: id, time: '08:30' }],
    cleanup: [],
    pending: true,
  });
  await runtime.resumeDailyNews();
  await vi.advanceTimersByTimeAsync(0);
  const pending = (await runtime.getDailyNewsMailbox(id)).issues.filter((issue) =>
    ['queued', 'running'].includes(issue.status),
  );
  expect(pending.length).toBeGreaterThan(0);
  expect(pending.length).toBeLessThan(5);

  finish({ items: [], message: 'No eligible items' });
  await vi.advanceTimersByTimeAsync(0);
  expect((await runtime.getDailyNewsMailbox(id)).issues.map((issue) => issue.date)).toEqual([
    '2026-11-28',
    '2026-11-27',
    '2026-11-26',
    '2026-11-25',
    '2026-11-24',
    '2026-11-23',
  ]);
  expect(await runtime.getDailyNewsWakeState()).toEqual({
    schedules: [{ workspaceId: id, time: '08:30' }],
    cleanup: [],
    pending: false,
  });
});

it('does not backfill dates before opt-in or while scheduling was disabled', async () => {
  const { runtime, id, open } = await fixture();
  collect.mockResolvedValue({ items: [], message: 'No eligible items' });
  vi.setSystemTime(new Date(2026, 10, 25, 9, 0));
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await runtime.setDailyNewsSettings(id, { ...settings, enabled: false });
  await runtime.close();

  vi.setSystemTime(new Date(2026, 10, 28, 9, 0));
  const started = open();
  await vi.advanceTimersByTimeAsync(0);
  await started.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  expect((await started.getDailyNewsMailbox(id)).issues.map((issue) => issue.date)).toEqual([
    '2026-11-28',
    '2026-11-25',
  ]);
});

it('delivers an active issue under its scheduled date after local midnight', async () => {
  const { runtime, id } = await fixture();
  vi.setSystemTime(new Date(2026, 10, 23, 23, 59));
  let finish!: (result: typeof delivered) => void;
  collect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  await runtime.setDailyNewsSettings(id, { ...settings, time: '23:59' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await runtime.getDailyNewsIssue(id, '2026-11-23')).toMatchObject({ status: 'running' });
  expect(collect.mock.calls[0][0].signal.aborted).toBe(false);

  finish(delivered);
  await vi.advanceTimersByTimeAsync(0);
  expect(await runtime.getDailyNewsIssue(id, '2026-11-23')).toMatchObject({ status: 'delivered' });
});

it('keeps an unavailable historical issue distinct from a successful empty issue', async () => {
  const { runtime, id, open } = await fixture();
  const unavailable = '无法核实这一天的新闻原文。';
  collect.mockImplementation(async ({ date }) => {
    if (date === '2026-11-24') throw new DailyNewsCollectionError(unavailable);
    return { items: [], message: 'No eligible items' };
  });
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await runtime.close();

  vi.setSystemTime(new Date(2026, 10, 26, 8, 0));
  const started = open();
  await vi.advanceTimersByTimeAsync(0);
  expect((await started.getDailyNewsWakeState()).pending).toBe(true);
  expect(await started.getDailyNewsIssue(id, '2026-11-25')).toMatchObject({ status: 'empty' });
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect((await started.getDailyNewsWakeState()).pending).toBe(false);
  expect(await started.getDailyNewsIssue(id, '2026-11-24')).toMatchObject({
    status: 'failed',
    message: unavailable,
    items: [],
  });
});

it('respects the configured local time and checks the due date after a resume', async () => {
  const { runtime, id } = await fixture();
  collect.mockResolvedValue({ items: [], message: 'No eligible items' });
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);

  vi.setSystemTime(new Date(2026, 10, 24, 8, 29));
  await runtime.resumeDailyNews();
  await vi.advanceTimersByTimeAsync(0);
  expect((await runtime.getDailyNewsMailbox(id)).issues).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(60_000);
  expect((await runtime.getDailyNewsMailbox(id)).issues).toHaveLength(2);
  vi.setSystemTime(new Date(2026, 10, 25, 10, 15));
  await runtime.resumeDailyNews();
  await vi.advanceTimersByTimeAsync(0);
  expect((await runtime.getDailyNewsMailbox(id)).issues[0]).toMatchObject({
    date: '2026-11-25',
    status: 'empty',
  });
});

it('preserves retry delays across restart, stops after bounded failures, and accepts explicit retry', async () => {
  const { runtime, id, open } = await fixture();
  collect.mockRejectedValue(new Error('temporary upstream failure'));
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await runtime.close();

  const started = open();
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  expect(collect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(16 * 60_000);
  expect(collect).toHaveBeenCalledTimes(3);
  expect(await started.getDailyNewsIssue(id, '2026-11-23')).toMatchObject({ status: 'failed' });
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(collect).toHaveBeenCalledTimes(3);

  collect.mockResolvedValue(delivered);
  await started.retryDailyNews(id, '2026-11-23');
  await vi.advanceTimersByTimeAsync(0);
  expect(await started.getDailyNewsIssue(id, '2026-11-23')).toMatchObject({ status: 'delivered' });
});

it('discards late completion after disabling and keeps the mailbox quiet until reenabled', async () => {
  const { runtime, id } = await fixture();
  let finish!: (result: typeof delivered) => void;
  const pending = new Promise<typeof delivered>((resolve) => (finish = resolve));
  collect.mockReturnValueOnce(pending).mockResolvedValue(delivered);
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  expect(await runtime.getDailyNewsIssue(id, '2026-11-23')).toMatchObject({ status: 'running' });

  await runtime.setDailyNewsSettings(id, { ...settings, enabled: false });
  finish(delivered);
  await vi.advanceTimersByTimeAsync(0);
  expect(await runtime.getDailyNewsIssue(id, '2026-11-23')).toMatchObject({
    status: 'failed',
    items: [],
  });
  expect(collect.mock.calls[0][0].signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(collect).toHaveBeenCalledTimes(1);

  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  expect((await runtime.getDailyNewsMailbox(id)).issues[0]).toMatchObject({
    date: '2026-11-24',
    status: 'delivered',
  });
});

it('collects with the new topic and ignores a late result from the old settings', async () => {
  const { runtime, id } = await fixture();
  let finishOld!: (result: typeof delivered) => void;
  const pending = new Promise<typeof delivered>((resolve) => (finishOld = resolve));
  collect.mockReturnValueOnce(pending).mockResolvedValue(delivered);
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);

  await runtime.setDailyNewsSettings(id, { ...settings, topic: '航天新闻' });
  await vi.advanceTimersByTimeAsync(0);
  finishOld({ items: [], message: 'Stale result' });
  await vi.advanceTimersByTimeAsync(0);

  expect(collect.mock.calls[0][0].signal.aborted).toBe(true);
  expect(collect.mock.calls[1][0].settings.topic).toBe('航天新闻');
  expect((await runtime.getDailyNewsMailbox(id)).issues).toHaveLength(1);
  expect(await runtime.getDailyNewsIssue(id, '2026-11-23')).toMatchObject(delivered);
});

it('parks a running issue on shutdown and discards results from the previous runtime', async () => {
  const { runtime, id, open } = await fixture();
  let finishOld!: (result: typeof delivered) => void;
  const pending = new Promise<typeof delivered>((resolve) => (finishOld = resolve));
  collect.mockReturnValueOnce(pending).mockResolvedValue(delivered);
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);

  await runtime.close();
  const started = open();
  finishOld({ items: [], message: 'Stale result' });
  await vi.advanceTimersByTimeAsync(0);

  expect(collect.mock.calls[0][0].signal.aborted).toBe(true);
  expect(collect).toHaveBeenCalledTimes(2);
  expect(await started.getDailyNewsIssue(id, '2026-11-23')).toMatchObject(delivered);
});

it('rejects unknown islands, dates, retries on a delivered issue, and retries while disabled', async () => {
  const { runtime, id } = await fixture();
  collect.mockResolvedValue(delivered);
  await expect(runtime.getDailyNewsMailbox('other')).rejects.toMatchObject({
    code: 'workspace_not_found',
  });
  await expect(runtime.getDailyNewsIssue(id, '2026-11-22')).rejects.toMatchObject({
    code: 'daily_news_issue_not_found',
  });
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await expect(runtime.retryDailyNews(id, '2026-11-23')).rejects.toMatchObject({
    code: 'daily_news_not_retryable',
  });
  await runtime.setDailyNewsSettings(id, { ...settings, enabled: false });
  await expect(runtime.retryDailyNews(id, '2026-11-23')).rejects.toMatchObject({
    code: 'daily_news_disabled',
  });
});

it('retains pending Windows task cleanup until acknowledged across restarts', async () => {
  const { runtime, id, open } = await fixture();
  collect.mockResolvedValue(delivered);
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await runtime.setDailyNewsSettings(id, { ...settings, enabled: false });
  await runtime.close();

  const started = open();
  await started.setDailyNewsSettings(id, { ...settings, enabled: false, time: '09:30' });
  expect(await started.getDailyNewsWakeState()).toEqual({
    schedules: [],
    cleanup: [id],
    pending: false,
  });
  await started.ackDailyNewsTaskCleanup(id);
  await started.close();

  const reopened = open();
  expect(await reopened.getDailyNewsWakeState()).toEqual({
    schedules: [],
    cleanup: [],
    pending: false,
  });
  expect(await reopened.getDailyNewsIssue(id, '2026-11-23')).toMatchObject(delivered);
});

it('clears pending cleanup when reenabled without changing a live subscription on ack', async () => {
  const { runtime, id } = await fixture();
  collect.mockResolvedValue(delivered);
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await runtime.setDailyNewsSettings(id, { ...settings, enabled: false });
  expect((await runtime.getDailyNewsWakeState()).cleanup).toEqual([id]);

  await runtime.setDailyNewsSettings(id, settings);
  await runtime.ackDailyNewsTaskCleanup(id);
  expect(await runtime.getDailyNewsWakeState()).toEqual({
    schedules: [{ workspaceId: id, time: '08:30' }],
    cleanup: [],
    pending: false,
  });
});

it('migrates existing disabled subscribers for cleanup only once', async () => {
  const { runtime, id, open, dataRoot } = await fixture();
  const neverEnabled = await runtime.createWorkspace({ name: 'Never enabled' });
  collect.mockResolvedValue(delivered);
  await runtime.setDailyNewsSettings(neverEnabled.id, { ...settings, enabled: false });
  await runtime.setDailyNewsSettings(id, settings);
  await vi.advanceTimersByTimeAsync(0);
  await runtime.setDailyNewsSettings(id, { ...settings, enabled: false });
  await runtime.close();

  const db = new DatabaseSync(join(dataRoot, 'astrisle.sqlite'));
  try {
    db.exec(
      'ALTER TABLE daily_news_settings DROP COLUMN cleanup_pending; DELETE FROM migrations WHERE version=6;',
    );
  } finally {
    db.close();
  }

  const migrated = open();
  expect((await migrated.getDailyNewsWakeState()).cleanup).toEqual([id]);
  await migrated.ackDailyNewsTaskCleanup(id);
  await migrated.close();
  expect((await open().getDailyNewsWakeState()).cleanup).toEqual([]);
});
