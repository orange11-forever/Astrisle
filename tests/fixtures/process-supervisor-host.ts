import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../../packages/executor/src/process';

const [root, tree, supervisorPath] = process.argv.slice(2);
const receipt = await runProcess(process.execPath, [tree, 'parent', root], {
  cwd: root,
  signal: new AbortController().signal,
  timeoutMs: 120000,
  supervisorPath,
});
await writeFile(join(root, 'host-receipt.json'), JSON.stringify(receipt));
