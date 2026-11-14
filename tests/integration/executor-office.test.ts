import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor } from '../../packages/executor/src/index';
import type { ToolContext } from '../../packages/contracts/src/index';
const roots: string[] = [];
it
  .skipIf(process.platform !== 'win32')
  .each(['print(\'{"ok":true}\'); sys.exit(7)', 'print("not a worker response")', 'print("null")'])(
  'keeps termination evidence and rejects failed or invalid Office worker responses (%#)',
  async (response) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'astrisle-office-receipt-')));
    roots.push(root);
    await fs.mkdir(join(root, 'workers/office'), { recursive: true });
    await fs.mkdir(join(root, 'dist/helpers'), { recursive: true });
    await fs.copyFile(
      join(process.cwd(), 'dist/helpers/process-supervisor.exe'),
      join(root, 'dist/helpers/process-supervisor.exe'),
    );
    await fs.writeFile(
      join(root, 'workers/office/worker.py'),
      `import sys,json\njson.load(sys.stdin)\n${response}\n`,
    );
    const executor = createExecutor({
      projectRoot: root,
      pythonPath: join(process.cwd(), '.venv/Scripts/python.exe'),
    });
    const receipt = await executor.execute(
      'office_create',
      { format: 'docx', output: 'draft.docx', content: { paragraphs: [] } },
      {
        commissionId: 'c',
        taskId: 't',
        runId: 'r',
        workPath: root,
        scope: {
          readRoots: [],
          writeRoots: [root],
          allowProcess: false,
          allowNetwork: false,
          allowedHosts: [],
        },
        signal: new AbortController().signal,
      },
    );
    expect(receipt).toMatchObject({
      ok: false,
      code: 'WORKER_FAILED',
      metadata: {
        termination: { mechanism: 'windows_job', confirmed: true, activeProcesses: 0 },
      },
    });
    expect(receipt.files ?? []).toEqual([]);
  },
);
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
it('invokes real local Python office worker and reports structural and numeric evidence separately', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'astrisle-office-')));
  roots.push(root);
  const context: ToolContext = {
    commissionId: 'c',
    taskId: 't',
    runId: 'r',
    workPath: root,
    scope: {
      readRoots: [],
      writeRoots: [root],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    signal: new AbortController().signal,
  };
  const executor = createExecutor({ projectRoot: process.cwd() });
  const created = await executor.execute(
    'office_create',
    {
      format: 'xlsx',
      output: 'budget.xlsx',
      content: {
        sheets: [
          {
            name: 'Budget',
            rows: [
              ['Item', 'Amount'],
              ['A', 20],
              ['B', 35],
            ],
            cells: { B4: '=SUM(B2:B3)' },
          },
        ],
      },
    },
    context,
  );
  expect(created.ok, created.output).toBe(true);
  if (process.platform === 'win32')
    expect(created.metadata?.termination).toMatchObject({
      mechanism: 'windows_job',
      activeProcesses: 0,
      confirmed: true,
    });
  expect(created.files).toEqual([join(root, 'budget.xlsx')]);
  expect(created.metadata?.verification).toMatchObject({
    structural: { status: 'passed' },
    numeric: { status: 'not_run' },
    application: { status: 'not_run' },
  });
  const before = await fs.readFile(join(root, 'budget.xlsx'));
  const edited = await executor.execute(
    'office_edit',
    {
      source: 'budget.xlsx',
      output: 'updated.xlsx',
      changes: { cells: [{ sheet: 'Budget', cell: 'B2', value: 25 }] },
      inputVersionIds: ['v1'],
    },
    context,
  );
  expect(edited.ok, edited.output).toBe(true);
  expect(await fs.readFile(join(root, 'budget.xlsx'))).toEqual(before);
  const verified = await executor.execute(
    'office_verify',
    { source: 'updated.xlsx', checks: [{ sheet: 'Budget', range: 'B2:B3', sum: 60 }] },
    context,
  );
  expect(verified.ok, verified.output).toBe(true);
  expect(verified.metadata?.verification).toMatchObject({
    numeric: { status: 'passed' },
    application: { status: 'not_run' },
  });
  const failed = await executor.execute(
    'office_verify',
    { source: 'updated.xlsx', checks: [{ sheet: 'Budget', range: 'B2:B3', sum: 999 }] },
    context,
  );
  expect(failed.ok).toBe(false);
  expect(failed.metadata?.verification).toMatchObject({ numeric: { status: 'failed' } });
  const escaped = await executor.execute(
    'office_create',
    { format: 'docx', output: '../leak.docx', content: { paragraphs: ['unsafe'] } },
    context,
  );
  expect(escaped.ok).toBe(false);
});
it.skipIf(process.platform !== 'win32')(
  'preserves the process termination receipt when an Office worker is cancelled',
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'astrisle-office-stop-')));
    roots.push(root);
    await fs.mkdir(join(root, 'workers/office'), { recursive: true });
    await fs.mkdir(join(root, 'dist/helpers'), { recursive: true });
    await fs.copyFile(
      join(process.cwd(), 'dist/helpers/process-supervisor.exe'),
      join(root, 'dist/helpers/process-supervisor.exe'),
    );
    await fs.writeFile(
      join(root, 'workers/office/worker.py'),
      'import json,sys,time\njson.load(sys.stdin)\nopen("ready", "w").write("ready")\ntime.sleep(60)\n',
    );
    const controller = new AbortController();
    const executor = createExecutor({
      projectRoot: root,
      pythonPath: join(process.cwd(), '.venv/Scripts/python.exe'),
    });
    const pending = executor.execute(
      'office_create',
      { format: 'docx', output: 'draft.docx', content: { paragraphs: ['example'] } },
      {
        commissionId: 'c',
        taskId: 't',
        runId: 'r',
        workPath: root,
        scope: {
          readRoots: [],
          writeRoots: [root],
          allowProcess: false,
          allowNetwork: false,
          allowedHosts: [],
        },
        signal: controller.signal,
      },
    );
    try {
      for (let i = 0; i < 200; i++) {
        if (
          await fs.stat(join(root, 'ready')).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((done) => setTimeout(done, 20));
      }
      expect(await fs.readFile(join(root, 'ready'), 'utf8')).toBe('ready');
    } finally {
      controller.abort();
    }
    const receipt = await pending;
    expect(receipt).toMatchObject({
      ok: false,
      code: 'ABORTED',
      metadata: {
        stopStatus: 'stopped',
        termination: { mechanism: 'windows_job', activeProcesses: 0, confirmed: true },
      },
    });
    expect(receipt.files ?? []).toEqual([]);
  },
);
