import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
    await fs.writeFile(join(root, 'draft.md'), '# Draft');
    const executor = createExecutor({
      projectRoot: root,
      pythonPath: join(process.cwd(), '.venv/Scripts/python.exe'),
    });
    const receipt = await executor.execute(
      'render_source',
      { source: 'draft.md', output: 'draft.docx' },
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
async function fixture() {
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
  return { root, context, executor };
}
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

it('publishes a genuine workbook, preserving identifiers and literal spreadsheet formulas', async () => {
  const { root, context, executor } = await fixture();
  expect(
    (await executor.capabilities()).find(({ id }) => id === 'source_publishing'),
  ).toMatchObject({
    available: true,
  });
  const source = 'Item,Amount,Notes\n001,20,"=SUM(B2:B3)"\n002,35.5,"+DDE()"\n';
  await fs.writeFile(join(root, 'budget.csv'), source);
  const created = await executor.execute(
    'render_source',
    { source: 'budget.csv', output: 'exports/budget.xlsx' },
    context,
  );
  expect(created.ok, created.output).toBe(true);
  if (process.platform === 'win32')
    expect(created.metadata?.termination).toMatchObject({
      mechanism: 'windows_job',
      activeProcesses: 0,
      confirmed: true,
    });
  const file = join(root, 'exports/budget.xlsx');
  expect(created.files).toEqual([file]);
  const before = await fs.readFile(file);
  expect(before.subarray(0, 2).toString()).toBe('PK');
  expect(created.metadata).toMatchObject({
    sourceSha256: sha256(source),
    outputSha256: sha256(before),
  });
  expect(created.metadata?.verification).toMatchObject({
    structural: { status: 'passed' },
    numeric: { status: 'not_run' },
    application: { status: 'not_run' },
  });
  const verified = await executor.execute(
    'inspect_delivery',
    { source: 'exports/budget.xlsx', checks: [{ sheet: 'Data', range: 'B2:B3', sum: 55.5 }] },
    context,
  );
  expect(verified.ok, verified.output).toBe(true);
  expect(verified.metadata?.verification).toMatchObject({
    numeric: { status: 'passed' },
    application: { status: 'not_run' },
  });
  expect(verified.metadata?.document).toMatchObject({
    sheets: [
      {
        name: 'Data',
        rows: [
          ['Item', 'Amount', 'Notes'],
          ['001', 20, '=SUM(B2:B3)'],
          ['002', 35.5, '+DDE()'],
        ],
      },
    ],
  });
  const failed = await executor.execute(
    'inspect_delivery',
    { source: 'exports/budget.xlsx', checks: [{ sheet: 'Data', range: 'B2:B3', sum: 999 }] },
    context,
  );
  expect(failed.ok).toBe(false);
  expect(failed.metadata?.verification).toMatchObject({ numeric: { status: 'failed' } });
  await fs.writeFile(join(root, 'budget.csv'), source.replace('35.5', '40.5'));
  const updated = await executor.execute(
    'render_source',
    { source: 'budget.csv', output: 'exports/budget.xlsx' },
    context,
  );
  expect(updated.ok, updated.output).toBe(true);
  const current = await fs.readFile(file);
  expect(current).not.toEqual(before);
  expect(updated.metadata?.outputSha256).toBe(sha256(current));
  await fs.writeFile(join(root, 'budget.csv'), '"unterminated');
  const corrupt = await executor.execute(
    'render_source',
    { source: 'budget.csv', output: 'exports/budget.xlsx' },
    context,
  );
  expect(corrupt.ok).toBe(false);
  expect(await fs.readFile(file)).toEqual(current);
}, 15_000);

it('renders Markdown to genuine editable Word and PowerPoint from the same immutable input', async () => {
  const { root, context, executor } = await fixture();
  const source =
    '# Progress\n\n## Results\n\nHere are **tested** results. See [documentation](https://pandoc.org/).\n\n## Next steps\n\n- Review\n- Publish\n';
  await fs.writeFile(join(root, 'progress.md'), source);
  for (const extension of ['docx', 'pptx']) {
    const filename = `progress.${extension}`;
    const published = await executor.execute(
      'render_source',
      { source: 'progress.md', output: filename },
      context,
    );
    expect(published.ok, published.output).toBe(true);
    const bytes = await fs.readFile(join(root, filename));
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(published.metadata).toMatchObject({
      sourceSha256: sha256(source),
      outputSha256: sha256(bytes),
    });
    const checked = await executor.execute('inspect_delivery', { source: filename }, context);
    expect(checked.ok, checked.output).toBe(true);
    expect(checked.metadata?.document).toMatchObject({ format: extension });
    expect(JSON.stringify(checked.metadata?.document)).toContain('Next steps');
  }
  expect(await fs.readFile(join(root, 'progress.md'), 'utf8')).toBe(source);
}, 20_000);

it('refuses unsupported formats, resources, and writes outside the task copy', async () => {
  const { root, context, executor } = await fixture();
  await fs.writeFile(join(root, 'with-resource.md'), '![image](file:///missing.png)');
  const file = join(root, 'existing.docx');
  await fs.writeFile(file, 'existing data');
  const resource = await executor.execute(
    'render_source',
    { source: 'with-resource.md', output: 'existing.docx' },
    context,
  );
  expect(resource.ok, resource.output).toBe(false);
  expect(await fs.readFile(file, 'utf8')).toBe('existing data');
  const escaped = await executor.execute(
    'render_source',
    { source: 'with-resource.md', output: '../leak.docx' },
    context,
  );
  expect(escaped).toMatchObject({ ok: false, code: 'PATH_DENIED' });
  const invalid = await executor.execute(
    'render_source',
    { source: 'with-resource.md', output: 'existing.xlsx' },
    context,
  );
  expect(invalid.ok).toBe(false);
  expect(
    executor.definitions().filter((definition) => definition.name.startsWith('office_')),
  ).toEqual([]);
  await expect(executor.execute('office_create', {}, context)).resolves.toMatchObject({
    code: 'UNKNOWN_TOOL',
  });
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
    await fs.writeFile(join(root, 'draft.md'), '# Draft');
    const controller = new AbortController();
    const executor = createExecutor({
      projectRoot: root,
      pythonPath: join(process.cwd(), '.venv/Scripts/python.exe'),
    });
    const pending = executor.execute(
      'render_source',
      { source: 'draft.md', output: 'draft.docx' },
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
