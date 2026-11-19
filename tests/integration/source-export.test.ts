import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobPath, publishArtifact } from '../../packages/artifacts/src/index';
import type { ToolExecutor, Workspace } from '../../packages/contracts/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { saveSourceExport } from '../../packages/runtime/src/source-export';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-source-export-')));
  roots.push(root);
  const data = join(root, 'data');
  const work = join(data, 'work');
  const original = join(root, 'original');
  await mkdir(work, { recursive: true });
  await mkdir(original);
  const workspace: Workspace = {
    id: 'w',
    name: 'export',
    workPath: work,
    sourcePath: original,
    createdAt: new Date().toISOString(),
  };
  const path = join(work, 'totals.tsv');
  await writeFile(path, 'item\tcount\nboats\t12\n');
  const source = await publishArtifact(data, work, 'totals.tsv', {
    name: 'Totals',
    commissionId: 'c',
    taskId: 't',
    inputVersions: [],
    mediaType: 'text/tab-separated-values',
  });
  const executor = createExecutor({ projectRoot: process.cwd() });
  return { root, data, path, workspace, source, executor, target: join(root, 'totals.xlsx') };
}

it('exports a historical source from its immutable bytes to a user-selected spreadsheet', async () => {
  const { root, data, path, workspace, source, executor, target } = await setup();
  source.validity = 'stale';
  await writeFile(path, 'item\tcount\nboats\t28\n');
  await writeFile(target, 'previous export');
  const saved = await saveSourceExport(data, executor, source, 'xlsx', target, [workspace]);
  expect(saved.ok, saved.message).toBe(true);
  const checked = await executor.execute(
    'inspect_delivery',
    { source: 'totals.xlsx' },
    {
      commissionId: 'c',
      taskId: 'r',
      runId: 'read',
      workPath: root,
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      signal: new AbortController().signal,
    },
  );
  expect(checked.ok, checked.output).toBe(true);
  expect(checked.metadata?.document).toMatchObject({
    sheets: [
      {
        rows: [
          ['item', 'count'],
          ['boats', 12],
        ],
      },
    ],
  });
  expect(await readFile(path, 'utf8')).toContain('28');
  expect((await readdir(root)).filter((name) => name.startsWith('.astrisle-export-'))).toEqual([]);
});

it('keeps managed paths, original projects and existing exports intact when a source cannot be rendered', async () => {
  const { data, workspace, source, executor, target } = await setup();
  for (const destination of [join(workspace.sourcePath, 'x.xlsx'), join(data, 'x.xlsx')]) {
    expect(
      await saveSourceExport(data, executor, source, 'xlsx', destination, [workspace]),
    ).toMatchObject({ ok: false, code: 'managed_destination' });
  }
  await writeFile(target, 'existing result');
  // Simulate a missing immutable blob without changing the working source.
  await rm(blobPath(data, source.sha256));
  expect(await saveSourceExport(data, executor, source, 'xlsx', target, [workspace])).toMatchObject(
    { ok: false, code: 'source_unavailable' },
  );
  expect(await readFile(target, 'utf8')).toBe('existing result');
});

it('preserves changes made to a chosen destination during conversion', async () => {
  const { data, workspace, source, executor, target } = await setup();
  await writeFile(target, 'before');
  const concurrent: ToolExecutor = {
    ...executor,
    async execute(...args) {
      const result = await executor.execute(...args);
      await writeFile(target, 'edited by another application');
      return result;
    },
  };
  expect(
    await saveSourceExport(data, concurrent, source, 'xlsx', target, [workspace]),
  ).toMatchObject({ ok: false, code: 'destination_changed' });
  expect(await readFile(target, 'utf8')).toBe('edited by another application');
});

it('retains the destination and explains a missing converter without leaking the worker protocol', async () => {
  const { root, data, workspace, source, executor, target } = await setup();
  const unavailable: ToolExecutor = {
    ...executor,
    async execute() {
      return { ok: false, code: 'WORKER_UNAVAILABLE', output: '{"ok":false}' };
    },
  };
  await writeFile(target, 'previously saved');
  const saved = await saveSourceExport(data, unavailable, source, 'xlsx', target, [workspace]);
  expect(saved).toMatchObject({ ok: false, code: 'render_failed' });
  expect(saved.message).toContain('依赖');
  expect(await readFile(target, 'utf8')).toBe('previously saved');
  expect((await readdir(root)).filter((name) => name.startsWith('.astrisle-export-'))).toEqual([]);
});
