import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform === 'win32') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = path.join(root, 'workers/process/ProcessSupervisor.cs');
  const output = path.join(root, 'dist/helpers/process-supervisor.exe');
  const hash = createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
  const previous = await readFile(`${output}.sha256`, 'utf8').catch(() => '');
  const binary = await readFile(output).catch(() => null);
  if (!binary || previous !== `${hash}:${createHash('sha256').update(binary).digest('hex')}`) {
    await mkdir(path.dirname(output), { recursive: true });
    const compiler = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    );
    execFileSync(
      compiler,
      [
        '/nologo',
        '/optimize+',
        '/target:exe',
        '/platform:x64',
        '/r:System.Web.Extensions.dll',
        `/out:${output}`,
        source,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    await writeFile(
      `${output}.sha256`,
      `${hash}:${createHash('sha256')
        .update(await readFile(output))
        .digest('hex')}`,
    );
  }
}
