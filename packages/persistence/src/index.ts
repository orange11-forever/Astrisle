import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult, ProjectSnapshot, Workspace } from '../../contracts/src/index';
export interface StoredCall {
  id: string;
  runtimeEpoch: number;
  projectId: string;
  taskId?: string;
  state: 'running' | 'finished' | 'outcome_unknown' | 'reconciled';
  request: { kind?: string; name?: string; args?: Record<string, unknown>; revision?: number };
  result?: unknown;
}
/** Runtime is the sole database writer. Every snapshot and its outbox are one transaction. */
export class RuntimeStore {
  private db: DatabaseSync;
  private runtimeEpoch = 0;
  constructor(dataRoot: string) {
    mkdirSync(dataRoot, {
      recursive: true,
    });
    this.db = new DatabaseSync(join(dataRoot, 'astrisle.sqlite'));
    try {
      this.initialize();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private initialize(): void {
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), writable INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_writable_project ON projects(workspace_id) WHERE writable=1;
      CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), sequence INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,sequence));
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_paths(task_id TEXT PRIMARY KEY, path TEXT NOT NULL);`);
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(calls)').all();
      if (!columns.some((column) => column.name === 'request_data')) {
        this.db.exec(`ALTER TABLE calls ADD COLUMN request_data TEXT;
          UPDATE calls SET request_data=data WHERE state='running';`);
        // Version 1 overwrote requests on completion; tool evidence retains their identity.
        const restore = this.db.prepare(
          'UPDATE calls SET request_data=? WHERE id=? AND project_id=? AND task_id=? AND request_data IS NULL',
        );
        for (const snapshot of this.projects()) {
          for (const evidence of snapshot.evidence) {
            if (evidence.kind !== 'tool' || !evidence.taskId) continue;
            try {
              const detail = JSON.parse(evidence.detail);
              if (typeof detail.runId === 'string' && typeof detail.name === 'string') {
                restore.run(
                  JSON.stringify({ kind: 'tool', name: detail.name, args: detail.args }),
                  detail.runId,
                  snapshot.commission.id,
                  evidence.taskId,
                );
              }
            } catch {
              /* Older free-text evidence cannot reconstruct a request. */
            }
          }
        }
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS calls_by_task ON calls(project_id,task_id);
        INSERT OR IGNORE INTO migrations VALUES(2);`);
      if (!columns.some((column) => column.name === 'runtime_epoch'))
        this.db.exec('ALTER TABLE calls ADD COLUMN runtime_epoch INTEGER NOT NULL DEFAULT 0');
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS runtime_generation(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);
        INSERT OR IGNORE INTO runtime_generation VALUES(1,0);
        INSERT OR IGNORE INTO migrations VALUES(3);`);
    });
    this.runtimeEpoch = this.db.prepare('SELECT epoch FROM runtime_generation WHERE id=1').get()!
      .epoch as number;
  }
  /** Called only after acquiring exclusive runtime ownership, before recovering old calls. */
  beginRuntime(): number {
    this.runtimeEpoch = this.transaction(() => {
      const row = this.db
        .prepare('UPDATE runtime_generation SET epoch=epoch+1 WHERE id=1 RETURNING epoch')
        .get()!;
      return row.epoch as number;
    });
    return this.runtimeEpoch;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  workspaces(): Workspace[] {
    return this.db
      .prepare('SELECT data FROM workspaces ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  addWorkspace(workspace: Workspace): void {
    this.db
      .prepare('INSERT INTO workspaces VALUES(?,?)')
      .run(workspace.id, JSON.stringify(workspace));
  }
  projects(): ProjectSnapshot[] {
    return this.db
      .prepare('SELECT data FROM projects ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  get(id: string): ProjectSnapshot {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    if (!row) throw new Error('Commission not found');
    return JSON.parse(row.data as string);
  }
  busy(workspaceId: string): boolean {
    return !!this.db
      .prepare('SELECT id FROM projects WHERE workspace_id=? AND writable=1')
      .get(workspaceId);
  }
  save(snapshot: ProjectSnapshot): void {
    const writable = ['accepted', 'cancelled', 'failed'].includes(snapshot.commission.status)
      ? 0
      : 1;
    this.db
      .prepare(
        'INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET writable=excluded.writable,data=excluded.data',
      )
      .run(snapshot.commission.id, snapshot.workspace.id, writable, JSON.stringify(snapshot));
    const insert = this.db.prepare('INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)');
    for (const event of snapshot.events)
      insert.run(event.id, event.commissionId, event.sequence, JSON.stringify(event));
  }
  receipt(id: string):
    | {
        payload: string;
        result: CommandResult;
      }
    | undefined {
    const row = this.db.prepare('SELECT payload,result FROM receipts WHERE request_id=?').get(id);
    return row
      ? {
          payload: row.payload as string,
          result: JSON.parse(row.result as string),
        }
      : undefined;
  }
  addReceipt(id: string, payload: string, result: CommandResult): void {
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(id, payload, JSON.stringify(result));
  }
  startCall(id: string, projectId: string, taskId: string | undefined, data: unknown): void {
    this.db
      .prepare(
        'INSERT INTO calls(id,project_id,task_id,state,data,request_data,runtime_epoch) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        id,
        projectId,
        taskId ?? null,
        'running',
        JSON.stringify(data),
        JSON.stringify(data),
        this.runtimeEpoch,
      );
  }
  endCall(id: string, data: unknown, runtimeEpoch = this.runtimeEpoch): void {
    const outcome = data as { code?: string; metadata?: { stopStatus?: string } } | null;
    const unknown =
      outcome?.code?.toLowerCase() === 'outcome_unknown' ||
      outcome?.metadata?.stopStatus === 'outcome_unknown';
    const changes =
      runtimeEpoch === this.runtimeEpoch
        ? this.db
            .prepare(
              "UPDATE calls SET state=?,data=? WHERE id=? AND runtime_epoch=? AND state='running' AND runtime_epoch=(SELECT epoch FROM runtime_generation WHERE id=1)",
            )
            .run(unknown ? 'outcome_unknown' : 'finished', JSON.stringify(data), id, runtimeEpoch)
            .changes
        : 0;
    if (changes !== 1)
      throw Object.assign(
        new Error('Call result belongs to an inactive runtime or completed call'),
        {
          code: 'stale_runtime_call',
        },
      );
  }
  /** Recovery is deliberately separate from accepting a worker's completion receipt. */
  interruptCall(id: string, reason: 'interrupted' | 'outcome_unknown'): void {
    this.db
      .prepare(
        "UPDATE calls SET state=?,data=? WHERE id=? AND state IN ('running','outcome_unknown')",
      )
      .run(
        reason === 'interrupted' ? 'finished' : 'outcome_unknown',
        JSON.stringify({
          ok: false,
          code: reason,
          output:
            reason === 'interrupted'
              ? 'Model request interrupted; no returned actions were dispatched.'
              : 'Runtime stopped before a durable tool receipt.',
        }),
        id,
      );
  }
  private callRow(row: Record<string, unknown>): StoredCall {
    return {
      id: row.id as string,
      runtimeEpoch: row.runtime_epoch as number,
      projectId: row.project_id as string,
      taskId: (row.task_id as string | null) ?? undefined,
      state: row.state as StoredCall['state'],
      request: row.request_data ? JSON.parse(row.request_data as string) : {},
      result: row.state === 'running' ? undefined : JSON.parse(row.data as string),
    };
  }
  unknownCalls(): StoredCall[] {
    return this.db
      .prepare(
        `SELECT * FROM calls WHERE state IN ('running','outcome_unknown') OR (state='finished' AND
          (lower(json_extract(data,'$.code'))='outcome_unknown' OR json_extract(data,'$.metadata.stopStatus')='outcome_unknown'))`,
      )
      .all()
      .map((r) => this.callRow(r));
  }
  recentTaskCalls(projectId: string, taskId: string, limit = 24): StoredCall[] {
    return this.db
      .prepare(
        `SELECT * FROM calls WHERE project_id=? AND task_id=?
      AND coalesce(json_extract(request_data,'$.kind'),'legacy') NOT IN ('model','plan')
      ORDER BY rowid DESC LIMIT ?`,
      )
      .all(projectId, taskId, limit)
      .map((r) => this.callRow(r))
      .reverse();
  }
  reconcileCalls(projectId: string, taskId: string | undefined, answer: string): void {
    for (const call of this.unknownCalls()) {
      if (call.projectId !== projectId || call.taskId !== taskId) continue;
      this.db
        .prepare('UPDATE calls SET state=?,data=? WHERE id=?')
        .run(
          'reconciled',
          JSON.stringify({ previousResult: call.result, reconciliation: answer }),
          call.id,
        );
    }
  }
  taskPath(taskId: string): string | undefined {
    return this.db.prepare('SELECT path FROM task_paths WHERE task_id=?').get(taskId)?.path as
      | string
      | undefined;
  }
  setTaskPath(taskId: string, path: string): void {
    this.db.prepare('INSERT INTO task_paths VALUES(?,?)').run(taskId, path);
  }
  close(): void {
    this.db.close();
  }
}
