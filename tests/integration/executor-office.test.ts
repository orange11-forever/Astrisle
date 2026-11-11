import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor } from '../../packages/executor/src/index';
import type { ToolContext } from '../../packages/contracts/src/index';
const roots: string[] = [];
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
