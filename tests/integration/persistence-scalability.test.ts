import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../../packages/persistence/src/index';
import type {
  CommissionStatus,
  ProjectEvent,
  ProjectSnapshot,
  Workspace,
} from '../../packages/contracts/src/index';

const cleanup: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function createDataRoot(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-persistence-scale-')));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

function openStore(dataRoot: string): { store: RuntimeStore; close: () => void } {
  const store = new RuntimeStore(dataRoot);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    store.close();
  };
  cleanup.push(close);
  return { store, close };
}

function openDb(path: string): { db: DatabaseSync; close: () => void } {
  const db = new DatabaseSync(path);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  cleanup.push(close);
  return { db, close };
}

function makeWorkspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    sourcePath: `E:/fixtures/${id}/source`,
    workPath: `E:/fixtures/${id}/work`,
    createdAt: '2026-11-27T08:00:00.000Z',
  };
}

function makeEvent(commissionId: string, sequence: number): ProjectEvent {
  return {
    id: `${commissionId}-evt-${sequence}`,
    commissionId,
    sequence,
    type: 'task.step',
    message: `Event step ${sequence}`,
    taskId: 'task-1',
    agentId: 'mori',
    createdAt: new Date(Date.UTC(2026, 10, 27, 8, 0, sequence)).toISOString(),
  };
}

function makeSnapshot(
  workspace: Workspace,
  commissionId: string,
  status: CommissionStatus,
  options: {
    title?: string;
    stepsUsed?: number;
    updatedAt?: string;
    summary?: string;
    heavyEvidenceBytes?: number;
    eventCount?: number;
  } = {},
): ProjectSnapshot {
  const eventCount = options.eventCount ?? 0;
  const events = Array.from({ length: eventCount }, (_, idx) => makeEvent(commissionId, idx + 1));
  return {
    commission: {
      id: commissionId,
      workspaceId: workspace.id,
      title: options.title ?? `Commission ${commissionId}`,
      goal: `Deliver goal for ${commissionId}`,
      status,
      criteria: [{ id: 'c1', description: 'Verified output' }],
      scope: {
        readRoots: [workspace.workPath],
        writeRoots: [workspace.workPath],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 100, maxMinutes: 30, maxRework: 2 },
      revision: 1,
      budgetRevision: 2,
      activeMilliseconds: 4500,
      planningMode: 'auto',
      stepsUsed: options.stepsUsed ?? eventCount,
      createdAt: '2026-11-27T08:00:00.000Z',
      updatedAt: options.updatedAt ?? '2026-11-27T08:05:00.000Z',
      acceptedArtifactIds: status === 'accepted' ? ['art-1'] : [],
      summary: options.summary ?? `Summary for ${commissionId}`,
    },
    workspace,
    agents: [
      { id: 'mori', name: 'Mori', temperament: 'explorer' },
      { id: 'luma', name: 'Luma', temperament: 'organizer' },
    ],
    tasks: [],
    artifacts: [],
    evidence: options.heavyEvidenceBytes
      ? [
          {
            id: `${commissionId}-ev-1`,
            kind: 'tool',
            summary: 'Large historical output',
            detail: 'x'.repeat(options.heavyEvidenceBytes),
            status: 'passed',
            taskId: 'task-1',
            artifactVersionIds: [],
            createdAt: '2026-11-27T08:01:00.000Z',
          },
        ]
      : [],
    events,
    requests: [],
    lastSequence: eventCount,
  };
}

describe('persistence scalability and summary index', () => {
  it('migrates a v4 database without summary_data, backfills summaries, and preserves exact rowid order in commissions()', async () => {
    const dataRoot = await createDataRoot();
    const wsA = makeWorkspace('ws-z', 'Island Z');
    const wsB = makeWorkspace('ws-a', 'Island A');
    // Insert IDs in reverse-lexicographical order to verify ORDER BY rowid (not PRIMARY KEY id).
    const snap1 = makeSnapshot(wsA, 'comm-zeta', 'accepted', {
      title: 'First inserted commission',
      stepsUsed: 12,
      heavyEvidenceBytes: 64_000,
      eventCount: 3,
    });
    const snap2 = makeSnapshot(wsA, 'comm-alpha', 'paused', {
      title: 'Second inserted commission',
      stepsUsed: 5,
      heavyEvidenceBytes: 64_000,
      eventCount: 2,
    });
    const snap3 = makeSnapshot(wsB, 'comm-middle', 'active', {
      title: 'Third inserted commission',
      stepsUsed: 19,
      heavyEvidenceBytes: 64_000,
      eventCount: 4,
    });

    const { db: legacyDb, close: closeLegacyDb } = openDb(join(dataRoot, 'astrisle.sqlite'));
    legacyDb.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE migrations(version INTEGER PRIMARY KEY);
      INSERT INTO migrations VALUES(1), (2), (3), (4);
      CREATE TABLE workspaces(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE projects(
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        writable INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX one_writable_project ON projects(workspace_id) WHERE writable=1;
      CREATE TABLE receipts(request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE outbox(
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        sequence INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(project_id, sequence)
      );
      CREATE TABLE calls(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT,
        state TEXT NOT NULL,
        data TEXT NOT NULL,
        request_data TEXT,
        runtime_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX calls_by_task ON calls(project_id, task_id);
      CREATE TABLE task_paths(task_id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE apply_operations(
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        commission_id TEXT NOT NULL REFERENCES projects(id),
        state TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX applies_by_workspace ON apply_operations(workspace_id);
      CREATE TABLE runtime_generation(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);
      INSERT INTO runtime_generation VALUES(1, 0);
    `);
    const insertWs = legacyDb.prepare('INSERT INTO workspaces VALUES(?, ?)');
    insertWs.run(wsA.id, JSON.stringify(wsA));
    insertWs.run(wsB.id, JSON.stringify(wsB));

    const insertProject = legacyDb.prepare('INSERT INTO projects VALUES(?, ?, ?, ?)');
    insertProject.run(snap1.commission.id, wsA.id, 0, JSON.stringify(snap1));
    insertProject.run(snap2.commission.id, wsA.id, 1, JSON.stringify(snap2));
    insertProject.run(snap3.commission.id, wsB.id, 1, JSON.stringify(snap3));
    closeLegacyDb();

    const { store, close: closeStore } = openStore(dataRoot);
    const commissions = store.commissions();
    const projectCommissions = store.projects().map((project) => project.commission);
    expect(commissions.map((c) => c.id)).toEqual(['comm-zeta', 'comm-alpha', 'comm-middle']);
    expect(commissions).toEqual(projectCommissions);
    closeStore();

    const { db: inspectDb, close: closeInspectDb } = openDb(join(dataRoot, 'astrisle.sqlite'));
    const columns = inspectDb.prepare('PRAGMA table_info(projects)').all();
    expect(columns.some((col) => col.name === 'summary_data')).toBe(true);

    const versions = inspectDb
      .prepare('SELECT version FROM migrations ORDER BY version')
      .all()
      .map((row) => row.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const rows = inspectDb.prepare('SELECT id, summary_data FROM projects ORDER BY rowid').all();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(typeof row.summary_data).toBe('string');
    }
    expect(rows.map((r) => JSON.parse(r.summary_data as string))).toEqual([
      snap1.commission,
      snap2.commission,
      snap3.commission,
    ]);

    // Verify commissions() reads summary_data without parsing full data when summary_data exists,
    // and falls back to data.commission if summary_data is NULL.
    inspectDb
      .prepare('UPDATE projects SET data=? WHERE id=?')
      .run('not-parsed-by-commissions', 'comm-zeta');
    inspectDb.prepare('UPDATE projects SET summary_data=NULL WHERE id=?').run('comm-alpha');
    closeInspectDb();

    const { store: reopened } = openStore(dataRoot);
    expect(reopened.commissions()).toEqual([snap1.commission, snap2.commission, snap3.commission]);
  });

  it('appends 50 incremental outbox events without re-inserting contiguous historical events and keeps commissions() fresh', async () => {
    const dataRoot = await createDataRoot();
    const { store } = openStore(dataRoot);

    const workspace = makeWorkspace('ws-inc', 'Incremental Island');
    store.addWorkspace(workspace);

    const { db: auditDb } = openDb(join(dataRoot, 'astrisle.sqlite'));
    auditDb.exec(`
      CREATE TABLE outbox_insert_attempts(seq INTEGER NOT NULL);
      CREATE TRIGGER count_outbox_insert_attempts
      BEFORE INSERT ON outbox
      BEGIN
        INSERT INTO outbox_insert_attempts VALUES(NEW.sequence);
      END;
    `);

    const snapshot = makeSnapshot(workspace, 'comm-50', 'active', {
      stepsUsed: 0,
      updatedAt: '2026-11-27T09:00:00.000Z',
      summary: 'Initial',
    });

    for (let seq = 1; seq <= 50; seq++) {
      snapshot.events.push(makeEvent(snapshot.commission.id, seq));
      snapshot.lastSequence = seq;
      snapshot.commission.stepsUsed = seq;
      snapshot.commission.updatedAt = new Date(Date.UTC(2026, 10, 27, 9, 0, seq)).toISOString();
      snapshot.commission.status = seq === 50 ? 'awaiting_acceptance' : 'active';
      snapshot.commission.summary = `Step ${seq} complete`;
      store.transaction(() => store.save(snapshot));
    }

    // Also save a non-event checkpoint update (e.g., acceptance) to verify 0 extra outbox inserts.
    snapshot.commission.status = 'accepted';
    snapshot.commission.acceptedArtifactIds = ['art-final'];
    snapshot.commission.updatedAt = '2026-11-27T09:10:00.000Z';
    snapshot.commission.summary = 'Accepted all 50 steps';
    store.transaction(() => store.save(snapshot));

    expect(store.busy(workspace.id)).toBe(false);
    expect(store.commissions()).toEqual([
      expect.objectContaining({
        id: 'comm-50',
        status: 'accepted',
        stepsUsed: 50,
        updatedAt: '2026-11-27T09:10:00.000Z',
        acceptedArtifactIds: ['art-final'],
        summary: 'Accepted all 50 steps',
      }),
    ]);

    const persistedOutbox = auditDb
      .prepare('SELECT event_id, sequence, data FROM outbox WHERE project_id=? ORDER BY sequence')
      .all('comm-50');
    expect(persistedOutbox).toHaveLength(50);
    expect(persistedOutbox.map((row) => row.sequence)).toEqual(
      Array.from({ length: 50 }, (_, idx) => idx + 1),
    );
    expect(JSON.parse(persistedOutbox[49].data as string)).toEqual(snapshot.events[49]);

    // Without incremental optimization, 51 saves would trigger 1+2+...+50 + 50 = 1,325 BEFORE INSERT attempts.
    // With contiguous incremental persistence, each sequence 1..50 is attempted exactly once!
    const attemptedSequences = auditDb
      .prepare('SELECT seq FROM outbox_insert_attempts ORDER BY rowid')
      .all()
      .map((row) => row.seq);
    expect(attemptedSequences).toEqual(Array.from({ length: 50 }, (_, idx) => idx + 1));

    // Verify fallback safety if an outbox gap ever exists: missing sequence is repaired, then O(1) resumes.
    auditDb.exec(
      "DELETE FROM outbox WHERE project_id='comm-50' AND sequence=25; DELETE FROM outbox_insert_attempts;",
    );
    snapshot.events.push(makeEvent(snapshot.commission.id, 51));
    snapshot.lastSequence = 51;
    store.transaction(() => store.save(snapshot));

    const repairedCount = auditDb
      .prepare('SELECT count(*) AS cnt FROM outbox WHERE project_id=?')
      .get('comm-50')!.cnt;
    expect(repairedCount).toBe(51);
    const fallbackAttempts = auditDb
      .prepare('SELECT count(*) AS cnt FROM outbox_insert_attempts')
      .get()!.cnt;
    expect(fallbackAttempts).toBe(51);

    auditDb.exec('DELETE FROM outbox_insert_attempts');
    snapshot.events.push(makeEvent(snapshot.commission.id, 52));
    snapshot.lastSequence = 52;
    store.transaction(() => store.save(snapshot));
    const resumedAttempts = auditDb
      .prepare('SELECT seq FROM outbox_insert_attempts ORDER BY rowid')
      .all()
      .map((row) => row.seq);
    expect(resumedAttempts).toEqual([52]);
  });
});
