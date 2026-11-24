import {
  defaultDailyNewsSettings,
  parseDailyNewsSettings,
  type DailyNewsEntry,
  type DailyNewsIssue,
  type DailyNewsItem,
  type DailyNewsMailbox,
  type DailyNewsSettings,
  type RuntimeOptions,
} from '../../contracts/src/index';
import type { RuntimeStore } from '../../persistence/src/index';
import type { DailyNewsJob, DailyNewsSubscription } from '../../persistence/src/daily-news';
import { collectDailyNews, DailyNewsCollectionError } from './daily-news-collector';

const retryDelays = [5 * 60_000, 15 * 60_000];
const maxAttempts = retryDelays.length + 1;
const clockCheck = 60_000;
const historicalBatchSize = 3;

export interface DailyNewsWakeState {
  schedules: { workspaceId: string; time: string }[];
  cleanup: string[];
  pending: boolean;
}

interface ActiveCollection {
  job: DailyNewsJob;
  controller: AbortController;
}

type CollectionOutcome =
  | { ok: true; result: Awaited<ReturnType<typeof collectDailyNews>> }
  | { ok: false; error: unknown };

function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function dueTime(now: Date, time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return new Date(now).setHours(hour, minute, 0, 0);
}

function shiftDate(date: string, days: number): string {
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

function mailboxError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class DailyNewsScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: ActiveCollection;
  private closed = false;

  constructor(
    private store: RuntimeStore,
    private getCredentials: RuntimeOptions['getCredentials'],
  ) {
    this.refresh();
  }

  mailbox(workspaceId: string): DailyNewsMailbox {
    this.requireWorkspace(workspaceId);
    return {
      settings: this.settings(workspaceId),
      issues: this.store.dailyNews.entries(workspaceId),
    };
  }

  issue(workspaceId: string, date: string): DailyNewsIssue {
    this.requireWorkspace(workspaceId);
    const issue = this.store.dailyNews.issue(workspaceId, date);
    if (!issue) throw mailboxError('daily_news_issue_not_found', '找不到这一天的新闻日报。');
    return issue;
  }

  updateSettings(workspaceId: string, input: DailyNewsSettings): DailyNewsMailbox {
    this.requireWorkspace(workspaceId);
    const next = parseDailyNewsSettings(input);
    const saved = this.store.dailyNews.settings(workspaceId);
    const previous = saved?.settings ?? defaultDailyNewsSettings();
    const sourcesChanged =
      previous.topic !== next.topic ||
      JSON.stringify(previous.feeds) !== JSON.stringify(next.feeds);
    if (next.enabled === previous.enabled && next.time === previous.time && !sourcesChanged)
      return this.mailbox(workspaceId);

    const now = new Date();
    const enabledNow = next.enabled && !previous.enabled;
    const date = localDate(now);
    this.store.transaction(() => {
      this.store.dailyNews.saveSettings(
        workspaceId,
        next,
        enabledNow ? date : (saved?.scheduledThrough ?? null),
      );
      if (!next.enabled || sourcesChanged) {
        for (const job of this.store.dailyNews.pendingJobs()) {
          if (job.workspaceId !== workspaceId) continue;
          if (next.enabled) this.queue({ ...job, attempts: 0 }, now);
          else this.save(job, 'failed', now, '自动收集已停用。');
        }
      }

      if (enabledNow) {
        const status = this.store.dailyNews.status(workspaceId, date);
        if (!status || status === 'failed')
          this.queue({ workspaceId, date, attempts: 0, manual: false }, now);
      }
    });
    if (!next.enabled || sourcesChanged) this.cancelActive(workspaceId);
    this.refresh();
    return this.mailbox(workspaceId);
  }

  retry(workspaceId: string, date: string): DailyNewsMailbox {
    this.requireWorkspace(workspaceId);
    if (!this.settings(workspaceId).enabled)
      throw mailboxError('daily_news_disabled', '请先启用自动收集，再重试这份日报。');
    if (this.issue(workspaceId, date).status !== 'failed')
      throw mailboxError('daily_news_not_retryable', '只有收集失败的日报可以重试。');
    this.queue({ workspaceId, date, attempts: 0, manual: true }, new Date());
    this.refresh();
    return this.mailbox(workspaceId);
  }

  resume(): void {
    this.refresh();
  }

  wakeState(): DailyNewsWakeState {
    const subscriptions = this.store.dailyNews.subscriptions();
    const now = new Date();
    const today = localDate(now);
    const yesterday = shiftDate(today, -1);
    const schedules: DailyNewsWakeState['schedules'] = [];
    let missingDueDate = false;
    for (const [workspaceId, subscription] of subscriptions) {
      const time = subscription.settings.time;
      schedules.push({ workspaceId, time });
      const latestDue = dueTime(now, time) <= now.getTime() ? today : yesterday;
      if (subscription.scheduledThrough < latestDue) missingDueDate = true;
    }
    schedules.sort(
      (a, b) => a.time.localeCompare(b.time) || a.workspaceId.localeCompare(b.workspaceId),
    );
    const pending =
      missingDueDate ||
      this.store.dailyNews.pendingJobs().some((job) => subscriptions.has(job.workspaceId));
    return { schedules, cleanup: this.store.dailyNews.pendingTaskCleanup(), pending };
  }

  ackTaskCleanup(workspaceId: string): void {
    this.store.dailyNews.ackTaskCleanup(workspaceId);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    const active = this.active;
    if (!active) return;
    this.cancelActive(active.job.workspaceId);
    try {
      this.queue({ ...active.job, attempts: active.job.attempts - 1 }, new Date());
    } catch {
      // The persisted running job will be recovered next time if parking it failed.
      console.error('Could not park the daily news collection during shutdown.');
    }
  }

  private requireWorkspace(workspaceId: string): void {
    if (!this.store.workspaceExists(workspaceId))
      throw mailboxError('workspace_not_found', '找不到这个岛屿的项目空间。');
  }

  private settings(workspaceId: string): DailyNewsSettings {
    return this.store.dailyNews.settings(workspaceId)?.settings ?? defaultDailyNewsSettings();
  }

  private save(
    job: DailyNewsJob,
    status: DailyNewsEntry['status'],
    at: Date,
    message: string,
    options?: { retryAt?: number; items?: DailyNewsItem[] },
  ): void {
    this.store.dailyNews.saveIssue({
      job,
      status,
      updatedAt: at.toISOString(),
      message,
      ...options,
    });
  }

  private queue(job: DailyNewsJob, now: Date): void {
    this.save(job, 'queued', now, '等待收集这份新闻日报。', { retryAt: now.getTime() });
  }

  private cancelActive(workspaceId: string): void {
    const active = this.active;
    if (active?.job.workspaceId !== workspaceId) return;
    this.active = undefined;
    active.controller.abort();
  }

  private refresh(): void {
    clearTimeout(this.timer);
    if (this.closed) return;
    const subscriptions = this.store.dailyNews.subscriptions();
    if (!subscriptions.size) return;

    const now = new Date();
    const today = localDate(now);
    const yesterday = shiftDate(today, -1);
    const currentTime = now.getTime();
    const midnight = new Date(now).setHours(24, 0, 0, 0);
    let nextWake = Math.min(currentTime + clockCheck, midnight);
    const historicalCounts = new Map<string, number>();
    for (const job of this.store.dailyNews.pendingJobs()) {
      if (job.manual || job.date >= today) continue;
      historicalCounts.set(job.workspaceId, (historicalCounts.get(job.workspaceId) ?? 0) + 1);
    }
    for (const [workspaceId, subscription] of subscriptions) {
      const scheduled = dueTime(now, subscription.settings.time);
      const dueToday = scheduled <= currentTime;
      if (!dueToday) nextWake = Math.min(nextWake, scheduled);
      this.enroll(
        workspaceId,
        subscription,
        dueToday ? today : yesterday,
        today,
        historicalCounts.get(workspaceId) ?? 0,
        now,
      );
    }

    let next: { job: DailyNewsJob; settings: DailyNewsSettings } | undefined;
    for (const job of this.store.dailyNews.pendingJobs()) {
      const subscription = subscriptions.get(job.workspaceId);
      if (!subscription) continue;
      if (this.active?.job.workspaceId === job.workspaceId && this.active.job.date === job.date)
        continue;
      if (job.attempts >= maxAttempts) {
        this.save(job, 'failed', now, '收集多次未完成，可以手动重试。');
        continue;
      }
      if (job.status === 'running') this.queue(job, now);
      if (!job.manual && job.date > today) continue;
      const retryAt = job.retryAt ?? currentTime;
      if (retryAt > currentTime) nextWake = Math.min(nextWake, retryAt);
      else if (!next || (job.date === today && next.job.date !== today))
        next = { job, settings: subscription.settings };
    }

    if (!this.active && next) this.start(next.job, next.settings, now);
    this.armTimer(Math.max(0, nextWake - Date.now()));
  }

  private enroll(
    workspaceId: string,
    subscription: DailyNewsSubscription,
    latestDue: string,
    today: string,
    historicalCount: number,
    now: Date,
  ): void {
    let through = subscription.scheduledThrough;
    if (through >= latestDue) return;
    this.store.transaction(() => {
      // Today may be ready even while the contiguous catch-up cursor is still behind it.
      if (latestDue === today && !this.store.dailyNews.status(workspaceId, today))
        this.queue({ workspaceId, date: today, attempts: 0, manual: false }, now);

      for (let scanned = 0; through < latestDue && scanned < historicalBatchSize; scanned++) {
        const date = shiftDate(through, 1);
        if (!this.store.dailyNews.status(workspaceId, date)) {
          if (historicalCount >= historicalBatchSize) break;
          this.queue({ workspaceId, date, attempts: 0, manual: false }, now);
          historicalCount++;
        }
        through = date;
      }
      this.store.dailyNews.advanceSchedule(workspaceId, through);
    });
  }

  private armTimer(delay: number): void {
    this.timer = setTimeout(() => this.refreshInBackground(), delay);
    this.timer.unref();
  }

  private refreshInBackground(): void {
    try {
      this.refresh();
    } catch {
      console.error('Could not refresh the daily news schedule.');
      if (!this.closed) this.armTimer(clockCheck);
    }
  }

  private start(job: DailyNewsJob, settings: DailyNewsSettings, now: Date): void {
    const active = {
      job: { ...job, attempts: job.attempts + 1 },
      controller: new AbortController(),
    };
    this.save(active.job, 'running', now, '正在收集并整理这份新闻日报。');
    this.active = active;

    // Defer external callbacks until the claim and active controller are both in place.
    void Promise.resolve()
      .then(() => {
        if (this.active !== active) return;
        return collectDailyNews({
          date: job.date,
          settings,
          getCredentials: this.getCredentials,
          signal: active.controller.signal,
        });
      })
      .then(
        (result) => {
          if (result) this.finish(active, { ok: true, result });
        },
        (error: unknown) => this.finish(active, { ok: false, error }),
      )
      .catch(() => console.error('Could not save the daily news result.'));
  }

  private finish(active: ActiveCollection, outcome: CollectionOutcome): void {
    if (this.active !== active) return;
    this.active = undefined;
    const { job } = active;
    const now = new Date();
    try {
      if (outcome.ok) {
        const { items, message } = outcome.result;
        this.save(job, items.length ? 'delivered' : 'empty', now, message, { items });
        return;
      }
      const { error } = outcome;
      const failure = error instanceof DailyNewsCollectionError ? error : undefined;
      const delay = retryDelays[job.attempts - 1];
      const retryAt = now.getTime() + (delay ?? 0);
      const message = failure?.message ?? '新闻收集未完成，请检查来源和模型服务。';
      if (delay && failure?.retryable !== false)
        this.save(job, 'queued', now, `${message} 稍后自动重试。`, { retryAt });
      else this.save(job, 'failed', now, message);
    } finally {
      this.refreshInBackground();
    }
  }
}
