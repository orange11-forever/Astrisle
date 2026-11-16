import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('.superpowers/acceptance-build/cli.cjs');
await mkdir(resolve('.superpowers/acceptance-build'), { recursive: true });
await build({
  entryPoints: ['tests/acceptance/cli.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'silent',
});
const child = spawn(process.execPath, [output, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', () => {
  console.error('Could not start acceptance runner');
  process.exitCode = 2;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 130;
});
