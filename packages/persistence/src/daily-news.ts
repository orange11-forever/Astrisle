import type { DatabaseSync } from 'node:sqlite';
import type {
  DailyNewsEntry,
  DailyNewsIssue,
  DailyNewsItem,
  DailyNewsSettings,
} from '../../contracts/src/index';

export interface DailyNewsJob {
  workspaceId: string;
  date: string;
  attempts: number;
  manual: boolean;
}

interface PendingDailyNewsJob extends DailyNewsJob {
  status: 'queued' | 'running';
  retryAt: number | null;
}

interface DailyNewsUpdate {
  job: DailyNewsJob;
  status: DailyNewsEntry['status'];
  updatedAt: string;
  message: string;
  retryAt?: number;
  items?: DailyNewsItem[];
}

interface StoredDailyNewsSettings {
  settings: DailyNewsSettings;
  scheduledThrough: string | null;
}

export interface DailyNewsSubscription {
  settings: DailyNewsSettings;
  scheduledThrough: string;
}

function entry(row: Record<string, unknown>): DailyNewsEntry {
  return {
    date: row.date as string,
    status: row.status as DailyNewsEntry['status'],
    updatedAt: row.updated_at as string,
    message: row.message as string,
    itemCount: row.item_count as number,
  };
}

export class DailyNewsStore {
  constructor(private db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_news_settings (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
        enabled INTEGER NOT NULL,
        data TEXT NOT NULL,
        scheduled_through TEXT,
        cleanup_pending INTEGER NOT NULL DEFAULT 0,
        CHECK(enabled=0 OR scheduled_through IS NOT NULL)
      );
      CREATE TABLE IF NOT EXISTS daily_news_issues (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        date TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        items TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        manual INTEGER NOT NULL,
        retry_at INTEGER,
        PRIMARY KEY(workspace_id, date)
      );
      CREATE INDEX IF NOT EXISTS pending_daily_news ON daily_news_issues(retry_at, date, workspace_id)
        WHERE status IN ('queued', 'running');
      INSERT OR IGNORE INTO migrations VALUES(5);
    `);
    const columns = this.db.prepare('PRAGMA table_info(daily_news_settings)').all();
    if (!columns.some((column) => column.name === 'cleanup_pending')) {
      this.db.exec(`
        ALTER TABLE daily_news_settings ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0;
        UPDATE daily_news_settings SET cleanup_pending=1
          WHERE enabled=0 AND scheduled_through IS NOT NULL;
      `);
    }
    this.db.exec('INSERT OR IGNORE INTO migrations VALUES(6)');
  }

  settings(workspaceId: string): StoredDailyNewsSettings | undefined {
    const row = this.db
      .prepare('SELECT data, scheduled_through FROM daily_news_settings WHERE workspace_id=?')
      .get(workspaceId);
    return row
      ? {
          settings: JSON.parse(row.data as string),
          scheduledThrough: row.scheduled_through as string | null,
        }
      : undefined;
  }

  subscriptions(): Map<string, DailyNewsSubscription> {
    return new Map(
      this.db
        .prepare(
          'SELECT workspace_id, data, scheduled_through FROM daily_news_settings WHERE enabled=1',
        )
        .all()
        .map((row) => [
          row.workspace_id as string,
          {
            settings: JSON.parse(row.data as string),
            scheduledThrough: row.scheduled_through as string,
          },
        ]),
    );
  }

  saveSettings(
    workspaceId: string,
    settings: DailyNewsSettings,
    scheduledThrough: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO daily_news_settings(workspace_id, enabled, data, scheduled_through) VALUES(?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled, data=excluded.data,
          scheduled_through=excluded.scheduled_through,
          cleanup_pending=CASE
            WHEN excluded.enabled=1 THEN 0
            WHEN daily_news_settings.enabled=1 THEN 1
            ELSE daily_news_settings.cleanup_pending
          END`,
      )
      .run(workspaceId, Number(settings.enabled), JSON.stringify(settings), scheduledThrough);
  }

  pendingTaskCleanup(): string[] {
    return this.db
      .prepare(
        'SELECT workspace_id FROM daily_news_settings WHERE enabled=0 AND cleanup_pending=1 ORDER BY workspace_id',
      )
      .all()
      .map((row) => row.workspace_id as string);
  }

  ackTaskCleanup(workspaceId: string): void {
    this.db
      .prepare(
        'UPDATE daily_news_settings SET cleanup_pending=0 WHERE workspace_id=? AND enabled=0 AND cleanup_pending=1',
      )
      .run(workspaceId);
  }

  advanceSchedule(workspaceId: string, date: string): void {
    this.db
      .prepare(
        'UPDATE daily_news_settings SET scheduled_through=? WHERE workspace_id=? AND scheduled_through<?',
      )
      .run(date, workspaceId, date);
  }

  entries(workspaceId: string): DailyNewsEntry[] {
    return this.db
      .prepare(
        `SELECT date, status, updated_at, message, item_count FROM daily_news_issues
         WHERE workspace_id=? ORDER BY date DESC`,
      )
      .all(workspaceId)
      .map(entry);
  }

  status(workspaceId: string, date: string): DailyNewsEntry['status'] | undefined {
    return this.db
      .prepare('SELECT status FROM daily_news_issues WHERE workspace_id=? AND date=?')
      .get(workspaceId, date)?.status as DailyNewsEntry['status'] | undefined;
  }

  issue(workspaceId: string, date: string): DailyNewsIssue | undefined {
    const row = this.db
      .prepare(
        `SELECT date, status, updated_at, message, item_count, items FROM daily_news_issues
         WHERE workspace_id=? AND date=?`,
      )
      .get(workspaceId, date);
    return row ? { ...entry(row), items: JSON.parse(row.items as string) } : undefined;
  }

  pendingJobs(): PendingDailyNewsJob[] {
    return this.db
      .prepare(
        `SELECT workspace_id, date, status, attempts, manual, retry_at FROM daily_news_issues
         WHERE status IN ('queued', 'running') ORDER BY retry_at, date, workspace_id`,
      )
      .all()
      .map((row) => ({
        workspaceId: row.workspace_id as string,
        date: row.date as string,
        status: row.status as PendingDailyNewsJob['status'],
        attempts: row.attempts as number,
        manual: row.manual === 1,
        retryAt: row.retry_at as number | null,
      }));
  }

  saveIssue({ job, status, updatedAt, message, retryAt, items = [] }: DailyNewsUpdate): void {
    this.db
      .prepare(
        `INSERT INTO daily_news_issues
          (workspace_id, date, status, updated_at, message, item_count, items, attempts, manual, retry_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, date) DO UPDATE SET
          status=excluded.status, updated_at=excluded.updated_at, message=excluded.message,
          item_count=excluded.item_count, items=excluded.items, attempts=excluded.attempts,
          manual=excluded.manual, retry_at=excluded.retry_at
         WHERE daily_news_issues.status NOT IN ('delivered', 'empty')`,
      )
      .run(
        job.workspaceId,
        job.date,
        status,
        updatedAt,
        message,
        items.length,
        JSON.stringify(items),
        job.attempts,
        Number(job.manual),
        retryAt ?? null,
      );
  }
}
