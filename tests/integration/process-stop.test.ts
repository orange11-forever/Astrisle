import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, realpath, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { minimalEnvironment, runProcess } from '../../packages/executor/src/process';
import { runWindowsProcess } from '../../packages/executor/src/windows-process';

const windows = it.skipIf(process.platform !== 'win32');
const roots: string[] = [];
const hosts: ChildProcess[] = [];
const tree = resolve('tests/fixtures/process-tree.cjs');
windows.each([false, true])(
  'rejects an inconsistent confirmed receipt with no exit code (cancel=%s)',
  async (cancel) => {
    const cwd = await fixture(),
      stub = join(cwd, 'inconsistent-receipt.cjs'),
      controller = new AbortController();
    const stream =
      [
        { version: 1, type: 'started', pid: 5 },
        {
          version: 1,
          type: 'receipt',
          pid: 5,
          confirmed: true,
          activeProcesses: 0,
          exitCode: null,
          reason: null,
        },
      ]
        .map((message) => JSON.stringify(message))
        .join('\n') + '\n';
    await writeFile(
      stub,
      `require('fs').writeFileSync(${JSON.stringify(join(cwd, 'stub-ran'))},'ran');process.stdout.write(${JSON.stringify(stream)},()=>process.exit(0));`,
    );
    const pending = runWindowsProcess(
      process.execPath,
      [],
      {
        cwd,
        signal: controller.signal,
        timeoutMs: 5000,
        supervisorPath: process.execPath,
      },
      { ...minimalEnvironment(), NODE_OPTIONS: `--require="${stub.replaceAll('\\', '/')}"` },
    );
    if (cancel) controller.abort();
    const receipt = await pending;
    expect(await readFile(join(cwd, 'stub-ran'), 'utf8')).toBe('ran');
    expect(receipt.termination?.rootPid, receipt.output).toBe(5);
    expect(receipt).toMatchObject({
      stopStatus: 'outcome_unknown',
      termination: { confirmed: false },
    });
  },
);
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
  for (const host of hosts.splice(0)) {
    if (host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit');
      host.kill('SIGKILL');
      await exited;
    }
  }
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
async function waitForTreeStop(root: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (!(await pids(root)).some(alive)) return;
    await wait(20);
  }
  throw new Error('Process tree remained alive');
}
windows(
  'kills the job if the supervisor crashes but keeps its missing receipt unknown',
  async () => {
    const cwd = await fixture();
    const pending = runProcess(process.execPath, [tree, 'parent', cwd], {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 10000,
    });
    await ready(cwd);
    process.kill(Number(await readFile(join(cwd, 'supervisor.pid'), 'utf8')), 'SIGKILL');
    const receipt = await pending;
    expect(receipt).toMatchObject({
      stopStatus: 'outcome_unknown',
      termination: { confirmed: false },
    });
    await waitForTreeStop(cwd);
    await expectTreeStopped(cwd);
  },
);
windows('stops the job when its owning Node runtime dies and closes the control pipe', async () => {
  const cwd = await fixture(),
    hostFile = join(cwd, 'host.mjs');
  await build({
    entryPoints: ['tests/fixtures/process-supervisor-host.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: hostFile,
    logLevel: 'silent',
  });
  const host = spawn(
    process.execPath,
    [hostFile, cwd, tree, resolve('dist/helpers/process-supervisor.exe')],
    { windowsHide: true, stdio: 'ignore' },
  );
  hosts.push(host);
  await ready(cwd);
  const exited = once(host, 'exit');
  host.kill('SIGKILL');
  await exited;
  await waitForTreeStop(cwd);
  await expectTreeStopped(cwd);
  await expect(stat(join(cwd, 'host-receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
windows.each([
  '',
  'not json\n',
  JSON.stringify({
    version: 1,
    type: 'receipt',
    pid: 5,
    confirmed: true,
    activeProcesses: 0,
    exitCode: 0,
    reason: null,
  }) + '\n',
  JSON.stringify({ version: 1, type: 'started', pid: 5 }) +
    '\n' +
    JSON.stringify({
      version: 1,
      type: 'receipt',
      pid: 6,
      confirmed: true,
      activeProcesses: 0,
      exitCode: 0,
      reason: null,
    }) +
    '\n',
])('does not trust a missing or invalid supervisor stream (%#)', async (stream) => {
  const cwd = await fixture(),
    stub = join(cwd, 'protocol-stub.cjs');
  await writeFile(stub, `process.stdout.write(${JSON.stringify(stream)},()=>process.exit(0));`);
  const receipt = await runWindowsProcess(
    process.execPath,
    [],
    {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 5000,
      supervisorPath: process.execPath,
    },
    { ...minimalEnvironment(), NODE_OPTIONS: `--require="${stub.replaceAll('\\', '/')}"` },
  );
  expect(receipt).toMatchObject({
    stopStatus: 'outcome_unknown',
    termination: { confirmed: false },
  });
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
windows(
  'can cancel a process tree even while the target never consumes its piped input',
  async () => {
    const cwd = await fixture(),
      controller = new AbortController();
    const pending = runProcess(process.execPath, [tree, 'parent', cwd], {
      cwd,
      signal: controller.signal,
      timeoutMs: 10000,
      input: 'x'.repeat(512 * 1024),
    });
    await ready(cwd);
    controller.abort();
    expect(await pending).toMatchObject({
      reason: 'aborted',
      stopStatus: 'stopped',
      termination: { confirmed: true, activeProcesses: 0 },
    });
    await expectTreeStopped(cwd);
  },
);
windows('treats receipt-shaped target output as data instead of termination evidence', async () => {
  const cwd = await fixture();
  const text = JSON.stringify({
    version: 1,
    type: 'receipt',
    pid: 5,
    confirmed: true,
    activeProcesses: 0,
    exitCode: 0,
    reason: null,
  });
  const receipt = await runProcess(
    process.execPath,
    ['-e', `console.log(${JSON.stringify(text)});setInterval(()=>{},1000)`],
    {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 1500,
    },
  );
  expect(receipt).toMatchObject({
    reason: 'timeout',
    stopStatus: 'stopped',
    termination: { confirmed: true },
  });
  expect(receipt.output).toContain(text);
  expect(receipt.termination?.rootPid).not.toBe(5);
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
