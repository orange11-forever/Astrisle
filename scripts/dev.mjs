import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await import('./build-desktop.mjs');
const server = await createServer();
await server.listen();
const require = createRequire(import.meta.url);
const child = spawn(require('electron'), ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ASTRISLE_DEV_URL: 'http://127.0.0.1:5173' },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill());
