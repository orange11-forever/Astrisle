import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = path.join(
  root,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const result = spawnSync(
  python,
  ['-m', 'pytest', 'workers/office/tests', '-q', '--basetemp=workers/office/.test-tmp'],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
