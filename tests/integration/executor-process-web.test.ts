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
  'does not advertise process or Office capability without the Windows supervisor',
  async () => {
    const { context } = await fixture();
    const capabilities = await createExecutor({ projectRoot: context.workPath }).capabilities();
    expect(capabilities.find((c) => c.id === 'process')?.available).toBe(false);
    expect(capabilities.find((c) => c.id === 'office')?.available).toBe(false);
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
