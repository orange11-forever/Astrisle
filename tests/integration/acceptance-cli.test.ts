import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-cli-test-')));
  await build({
    entryPoints: ['tests/acceptance/cli.ts'],
    outfile: join(root, 'cli.cjs'),
    platform: 'node',
    format: 'cjs',
    bundle: true,
    target: 'node22',
    logLevel: 'silent',
  });
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function run(
  args: string[],
  env: Record<string, string> = {},
  input = '',
  cwd = process.cwd(),
) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv))
      if (key.startsWith('ASTRISLE_PROVIDER_')) delete childEnv[key];
    const child = spawn(process.execPath, [join(root, 'cli.cjs'), ...args], {
      cwd,
      env: { ...childEnv, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}
it('lists scenarios without a provider or a network request', async () => {
  const result = await run(['--list']);
  expect(result.code).toBe(0);
  expect(result.output).toContain('code-new');
  expect(result.output).toContain('source-publishing');
});
it('preflight accepts hidden-stdin credentials without exposing them or contacting the endpoint', async () => {
  const result = await run(
    ['--check', '--scenario', 'code-new', '--allow-process', '--key-stdin'],
    {
      ASTRISLE_PROVIDER_URL: 'https://unreachable.invalid',
      ASTRISLE_PROVIDER_MODEL: 'fixture',
    },
    'fixture-stdin-private-key\n',
  );
  expect(result.code).toBe(0);
  expect(result.output).toContain('Preflight only');
  expect(result.output).not.toContain('fixture-stdin-private-key');
});
it('retains separate not_run reports for repeats without configuration and exits nonzero', async () => {
  const output = join(root, 'reports');
  const result = await run(['--scenario', 'continuity', '--repeat', '2', '--output', output]);
  expect(result.code).toBe(2);
  const samples = await readdir(output);
  expect(samples).toHaveLength(2);
  for (const sample of samples) {
    const report = JSON.parse(await readFile(join(output, sample, 'report.json'), 'utf8'));
    expect(report.status).toBe('not_run');
    expect(report.stages).toEqual([]);
  }
});
it('rejects invalid command options before creating a sample', async () => {
  const result = await run(['--scenario', 'unknown']);
  expect(result.code).toBe(2);
  expect(result.output).toContain('Unknown scenario');
});
it.skipIf(process.platform !== 'win32')(
  'preflight is not ready without the required Windows supervisor',
  async () => {
    const result = await run(
      ['--check', '--allow-process'],
      {
        ASTRISLE_PROVIDER_URL: 'https://unreachable.invalid',
        ASTRISLE_PROVIDER_MODEL: 'fixture',
        ASTRISLE_PROVIDER_API_KEY: 'fixture',
      },
      '',
      root,
    );
    expect(result.code).toBe(2);
    expect(result.output).toContain('"processAvailable":false');
  },
);
