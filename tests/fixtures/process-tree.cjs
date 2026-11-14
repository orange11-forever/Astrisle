// Real descendants with ignored stdio: parent pipe closure cannot prove they stopped.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [role, root, mode = 'hold'] = process.argv.slice(2);
fs.writeFileSync(path.join(root, `${role}.pid`), String(process.pid));
if (role !== 'grandchild') {
  const child = spawn(
    process.execPath,
    [__filename, role === 'parent' ? 'child' : 'grandchild', root, mode],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
}
const interval = setInterval(() => {
  if (role === 'grandchild') fs.appendFileSync(path.join(root, 'heartbeat'), '.');
  if (role === 'parent' && fs.existsSync(path.join(root, 'heartbeat'))) {
    if (mode === 'exit') process.exit(0);
    if (mode === 'flood') process.stdout.write('x'.repeat(8192));
  }
}, 20);
