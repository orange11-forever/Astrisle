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
async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'astrisle-executor-'));
  roots.push(root);
  const work = join(root, 'work');
  await fs.mkdir(work);
  const context: ToolContext = {
    commissionId: 'c',
    taskId: 't',
    runId: 'r',
    workPath: work,
    scope: {
      readRoots: [],
      writeRoots: [work],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    signal: new AbortController().signal,
  };
  return { root, work, context, executor: createExecutor({ projectRoot: process.cwd() }) };
}

it('executes generic file edits and bounded search inside granted roots', async () => {
  const { work, context, executor } = await setup();
  expect(
    (
      await executor.execute(
        'workspace_write',
        { path: 'src/a.txt', content: 'alpha beta' },
        context,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await executor.execute(
        'workspace_patch',
        { path: 'src/a.txt', search: 'beta', replacement: 'gamma' },
        context,
      )
    ).ok,
  ).toBe(true);
  expect(
    (await executor.execute('workspace_search', { query: 'gamma' }, context)).output,
  ).toContain('src/a.txt');
  expect(await fs.readFile(join(work, 'src', 'a.txt'), 'utf8')).toBe('alpha gamma');
});
it('rejects traversal, cross-project writes and junctions without changing targets', async () => {
  const { root, work, context, executor } = await setup();
  expect(
    (await executor.execute('workspace_write', { path: '../escape.txt', content: 'bad' }, context))
      .ok,
  ).toBe(false);
  expect(
    (
      await executor.execute(
        'workspace_write',
        { path: join(root, 'other.txt'), content: 'bad' },
        context,
      )
    ).ok,
  ).toBe(false);
  const outside = join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, join(work, 'link'), 'junction');
  expect(
    (await executor.execute('workspace_write', { path: 'link/leak.txt', content: 'bad' }, context))
      .ok,
  ).toBe(false);
  expect(await fs.readdir(outside)).toEqual([]);
});
it('keeps read-only grants read-only and denies ungranted host process/network', async () => {
  const { root, context, executor } = await setup();
  const read = join(root, 'read');
  await fs.mkdir(read);
  await fs.writeFile(join(read, 'data.txt'), 'readable');
  context.scope.readRoots = [read];
  expect(
    (await executor.execute('workspace_read', { path: join(read, 'data.txt') }, context)).output,
  ).toBe('readable');
  expect(
    (
      await executor.execute(
        'workspace_write',
        { path: join(read, 'data.txt'), content: 'bad' },
        context,
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await executor.execute(
        'process_run',
        { command: process.execPath, args: ['-e', 'console.log(1)'] },
        context,
      )
    ).ok,
  ).toBe(false);
  expect((await executor.execute('web_read', { url: 'https://example.com' }, context)).ok).toBe(
    false,
  );
});
it('honors already aborted invocations', async () => {
  const { context, executor } = await setup();
  const controller = new AbortController();
  controller.abort();
  context.signal = controller.signal;
  expect(
    (await executor.execute('workspace_write', { path: 'a', content: 'bad' }, context)).code,
  ).toBe('ABORTED');
});
