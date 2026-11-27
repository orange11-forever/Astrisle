import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createExecutor } from '../../packages/executor/src/index';
import type { ToolContext } from '../../packages/contracts/src/index';
const roots: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'astrisle-process-')));
  roots.push(root);
  const context: ToolContext = {
    commissionId: 'c',
    taskId: 't',
    runId: 'r',
    workPath: root,
    scope: {
      readRoots: [],
      writeRoots: [root],
      allowProcess: true,
      allowNetwork: true,
      allowedHosts: ['127.0.0.1'],
    },
    signal: new AbortController().signal,
  };
  return { context, executor: createExecutor({ projectRoot: process.cwd() }) };
}
it.skipIf(process.platform !== 'win32')(
  'does not advertise process or source publishing without the Windows supervisor',
  async () => {
    const { context } = await fixture();
    const capabilities = await createExecutor({ projectRoot: context.workPath }).capabilities();
    expect(capabilities.find((c) => c.id === 'process')?.available).toBe(false);
    expect(capabilities.find((c) => c.id === 'source_publishing')?.available).toBe(false);
    expect(capabilities.find((c) => c.id === 'safe_apply')?.available).toBe(false);
  },
);
it.skipIf(process.platform !== 'win32')(
  'advertises installed native writeback with its accepted-version boundary',
  async () => {
    const capabilities = await createExecutor({ projectRoot: process.cwd() }).capabilities();
    expect(capabilities.find((c) => c.id === 'safe_apply')?.available).toBe(true);
  },
);
it('executes a real host process with minimal environment and redacted output', async () => {
  const { context, executor } = await fixture();
  process.env.ASTRISLE_TEST_SECRET = 'should-not-be-inherited';
  try {
    const result = await executor.execute(
      'process_run',
      {
        command: process.execPath,
        args: [
          '-e',
          'console.log(process.env.ASTRISLE_TEST_SECRET || "clean"); console.log("api_key=secretvalue")',
        ],
      },
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('clean');
    expect(result.output).not.toContain('secretvalue');
    expect(result.metadata?.mode).toBe('trusted_host');
  } finally {
    delete process.env.ASTRISLE_TEST_SECRET;
  }
});
it('reports cancellation only after the process tree is confirmed stopped', async () => {
  const { context, executor } = await fixture(),
    controller = new AbortController();
  context.signal = controller.signal;
  const result = executor.execute(
    'process_run',
    { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
    context,
  );
  setTimeout(() => controller.abort(), 150);
  const receipt = await result;
  expect(receipt.ok).toBe(false);
  expect(receipt.metadata?.stopStatus).toBe('stopped');
});
it('passes explicit UTF-8 stdin to a supervised process', async () => {
  const { context, executor } = await fixture();
  const result = await executor.execute(
    'process_run',
    {
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      input: '星岛\n{"value":42}\n',
    },
    context,
  );
  expect(result.ok, result.output).toBe(true);
  expect(result.output).toBe('星岛\n{"value":42}\n');
});
it('validates every redirect target before making a cross-host request', async () => {
  const { context, executor } = await fixture();
  let forbiddenRequested = false;
  const server = createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, {
        location: `http://localhost:${(server.address() as { port: number }).port}/secret`,
      });
      res.end();
    } else {
      forbiddenRequested = true;
      res.end('secret');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const result = await executor.execute(
    'web_read',
    { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/start` },
    context,
  );
  expect(result.code).toBe('SCOPE_DENIED');
  expect(forbiddenRequested).toBe(false);
});
it('restricts every redirect hop to pinned sources when given a task URL set', async () => {
  const { context, executor } = await fixture();
  const requests: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/pinned') {
      res.writeHead(302, { location: '/unpinned' });
      res.end();
    } else res.end('final source');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${origin}/pinned`;
  const restricted = await executor.execute('web_read', { url }, {
    ...context,
    pinnedWebReadUrls: new Set([url]),
  } satisfies ToolContext);
  expect(restricted.code).toBe('SCOPE_DENIED');
  expect(requests).toEqual(['/pinned']);

  const normal = await executor.execute('web_read', { url }, context);
  expect(normal).toMatchObject({ ok: true, output: 'final source' });
  expect(requests).toEqual(['/pinned', '/pinned', '/unpinned']);

  const pinnedRedirect = await executor.execute(
    'web_read',
    { url },
    {
      ...context,
      pinnedWebReadUrls: new Set([url, `${origin}/unpinned`]),
    },
  );
  expect(pinnedRedirect).toMatchObject({ ok: true, output: 'final source' });
  expect(requests.slice(3)).toEqual(['/pinned', '/unpinned']);
});
it('rejects missing required write content and oversized input', async () => {
  const { context, executor } = await fixture();
  expect((await executor.execute('workspace_write', { path: 'bad' }, context)).ok).toBe(false);
  expect(
    (
      await executor.execute(
        'workspace_write',
        { path: 'bad', content: 'a'.repeat(1024 * 1024 + 1) },
        context,
      )
    ).ok,
  ).toBe(false);
  expect(await fs.readdir(context.workPath)).toEqual([]);
});
