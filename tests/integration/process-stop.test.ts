import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../packages/executor/src/process';

const windows = it.skipIf(process.platform !== 'win32');
const roots: string[] = [];
const tree = resolve('tests/fixtures/process-tree.cjs');
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-job-')));
  roots.push(root);
  return root;
}
async function ready(root: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      if ((await stat(join(root, 'heartbeat'))).size > 0) return;
    } catch {
      /* wait for a real descendant */
    }
    await wait(20);
  }
  throw new Error('Process tree did not become ready');
}
async function pids(root: string) {
  const result: number[] = [];
  for (const role of ['parent', 'child', 'grandchild']) {
    try {
      result.push(Number(await readFile(join(root, `${role}.pid`), 'utf8')));
    } catch {
      /* process never started */
    }
  }
  return result;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function expectTreeStopped(root: string) {
  expect((await pids(root)).filter(alive)).toEqual([]);
  const before = await readFile(join(root, 'heartbeat'), 'utf8');
  await wait(100);
  expect(await readFile(join(root, 'heartbeat'), 'utf8')).toBe(before);
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (const pid of await pids(root)) {
      if (alive(pid))
        await promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
        }).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});
windows(
  'confirms zero active job processes after cancelling a real detached three-generation tree',
  async () => {
    const cwd = await fixture(),
      controller = new AbortController();
    const pending = runProcess(process.execPath, [tree, 'parent', cwd], {
      cwd,
      signal: controller.signal,
      timeoutMs: 10000,
    });
    await ready(cwd);
    controller.abort();
    const receipt = await pending;
    expect(receipt).toMatchObject({
      reason: 'aborted',
      stopStatus: 'stopped',
      termination: {
        mechanism: 'windows_job',
        activeProcesses: 0,
        confirmed: true,
      },
    });
    await expectTreeStopped(cwd);
  },
);
windows('cleans up descendants even when the original process exits successfully', async () => {
  const cwd = await fixture();
  const receipt = await runProcess(process.execPath, [tree, 'parent', cwd, 'exit'], {
    cwd,
    signal: new AbortController().signal,
    timeoutMs: 10000,
  });
  expect(receipt.exitCode).toBe(0);
  expect(receipt.termination).toMatchObject({
    mechanism: 'windows_job',
    activeProcesses: 0,
    confirmed: true,
  });
  await expectTreeStopped(cwd);
});
windows.each(['timeout', 'output_limit'] as const)(
  'confirms tree termination on %s',
  async (reason) => {
    const cwd = await fixture();
    const receipt = await runProcess(
      process.execPath,
      [tree, 'parent', cwd, reason === 'timeout' ? 'hold' : 'flood'],
      {
        cwd,
        signal: new AbortController().signal,
        timeoutMs: reason === 'timeout' ? 3000 : 10000,
        outputLimit: 4096,
      },
    );
    expect(receipt).toMatchObject({
      reason,
      stopStatus: 'stopped',
      termination: { confirmed: true, activeProcesses: 0 },
    });
    expect(Buffer.byteLength(receipt.output)).toBeLessThanOrEqual(4096);
    await expectTreeStopped(cwd);
  },
);
windows(
  'preserves Unicode, empty and quoted arguments, cwd and stdin without a shell',
  async () => {
    const cwd = await fixture(),
      args = ['中文 空格', '', 'quote"end', 'slashes\\\\', '&echo should-not-run'];
    const receipt = await runProcess(
      process.execPath,
      [
        '-e',
        'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify({args:process.argv.slice(1),input:s,cwd:process.cwd()})));',
        '--',
        ...args,
      ],
      {
        cwd,
        signal: new AbortController().signal,
        timeoutMs: 10000,
        input: '输入\nsecond line',
      },
    );
    expect(receipt.exitCode).toBe(0);
    expect(JSON.parse(receipt.output)).toEqual({ args, input: '输入\nsecond line', cwd });
  },
);
windows('fails closed before launching the target when the supervisor is unavailable', async () => {
  const cwd = await fixture();
  await expect(
    runProcess(process.execPath, ['-e', 'require("fs").writeFileSync("unexpected","ran")'], {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 10000,
      supervisorPath: join(cwd, 'missing.exe'),
    }),
  ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED' });
  await expect(stat(join(cwd, 'unexpected'))).rejects.toMatchObject({ code: 'ENOENT' });
});
windows(
  'rejects a pre-aborted call and a nonexistent executable before user code runs',
  async () => {
    const cwd = await fixture();
    await expect(
      runProcess(process.execPath, ['-e', 'process.exit(0)'], {
        cwd,
        signal: AbortSignal.abort(),
        timeoutMs: 10000,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(
      runProcess(join(cwd, 'missing-target.exe'), [], {
        cwd,
        signal: new AbortController().signal,
        timeoutMs: 10000,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED' });
  },
);
