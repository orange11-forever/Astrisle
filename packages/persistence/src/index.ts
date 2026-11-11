import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult, ProjectSnapshot, Workspace } from '../../contracts/src/index';
/** Runtime is the sole database writer. Every snapshot and its outbox are one transaction. */
export class RuntimeStore {
  private db: DatabaseSync;
  constructor(dataRoot: string) {
    mkdirSync(dataRoot, {
      recursive: true,
    });
    this.db = new DatabaseSync(join(dataRoot, 'astrisle.sqlite'));
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
      .prepare('INSERT INTO calls VALUES(?,?,?,?,?)')
      .run(id, projectId, taskId ?? null, 'running', JSON.stringify(data));
  }
  endCall(id: string, data: unknown): void {
    this.db
      .prepare('UPDATE calls SET state=?,data=? WHERE id=?')
      .run('finished', JSON.stringify(data), id);
  }
  unknownCalls(): {
    id: string;
    projectId: string;
    taskId?: string;
  }[] {
    return this.db
      .prepare("SELECT id,project_id,task_id FROM calls WHERE state='running'")
      .all()
      .map((r) => ({
        id: r.id as string,
        projectId: r.project_id as string,
        taskId: r.task_id as string | undefined,
      }));
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
