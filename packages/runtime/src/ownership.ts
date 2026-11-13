import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** OS-backed lifetime lock; never expires and must never be recovered by deleting the file. */
export class RuntimeOwnership {
  private db: DatabaseSync | undefined;

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    const db = new DatabaseSync(join(realpathSync(dataRoot), 'runtime-owner.sqlite'));
    try {
      // A separate database keeps business transactions and readers independent of the lock.
      // No PID or heartbeat takeover: an unresponsive owner can still have live tool processes.
      db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
      this.db = db;
    } catch (error) {
      db.close();
      const code = (error as { errcode?: number }).errcode;
      if (code !== undefined && [5, 6].includes(code & 255))
        throw Object.assign(
          new Error('此数据目录已有工作运行时占用。请退出原实例并等待其停止后再启动。', {
            cause: error,
          }),
          { code: 'runtime_in_use' },
        );
      throw error;
    }
  }

  release(): void {
    if (!this.db) return;
    this.db.close(); // Rolls back the lock transaction; process death releases the same OS lock.
    this.db = undefined;
  }
}
