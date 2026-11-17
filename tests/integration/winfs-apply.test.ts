import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  writeFile,
  rename,
  link,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const hash = (data: string) => createHash('sha256').update(data).digest('hex');
const binary = path.resolve('dist/helpers/safe-apply.exe');
const roots: string[] = [];
const activeChildren = new Set<ChildProcess>();
let fixtureBinary: string;
let reparseBinary: string;
let mappedBinary: string;
type Result = {
  ok: boolean;
  status: string;
  canRollback: boolean;
  inspectionToken?: string | null;
  files: { path: string; state: string }[];
  conflicts: string[];
};
type Request = Record<string, unknown>;

async function scenario(count = 2) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'astrisle-winfs-')));
  roots.push(dir);
  const sourceRoot = path.join(dir, 'source');
  const operationDirectory = path.join(dir, 'operation');
  await mkdir(sourceRoot);
  await mkdir(operationDirectory);
  const files = [];
  for (let index = 0; index < count; index++) {
    const file = `file${index}.txt`;
    const candidatePath = path.join(operationDirectory, `${index}.candidate`);
    await writeFile(path.join(sourceRoot, file), `before${index}`);
    await writeFile(candidatePath, `after${index}`);
    files.push({
      path: file,
      action: 'modify',
      beforeHash: hash(`before${index}`),
      afterHash: hash(`after${index}`),
      candidatePath,
    });
  }
  return {
    dir,
    sourceRoot,
    operationDirectory,
    version: 1,
    action: 'apply',
    operationId: 'test-operation',
    files,
  };
}

function start(request: Request, hooked = false) {
  const exe = hooked ? fixtureBinary : binary;
  if (!existsSync(exe)) throw new Error(`Native helper is missing: ${exe}`);
  const child = spawn(exe, [], { windowsHide: true, stdio: 'pipe' });
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
  let stdout = '';
  let stderr = '';
  const listeners: (() => void)[] = [];
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    listeners.forEach((fn) => fn());
  });
  child.stdin.write(`${JSON.stringify(request)}\n`);
  if (!hooked) child.stdin.end();
  const done = new Promise<Result>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      try {
        resolve(JSON.parse(stdout.trim()) as Result);
      } catch {
        reject(new Error(`No result: ${stdout} ${stderr}`));
      }
    });
  });
  // Tests which deliberately kill the helper consume this rejection explicitly.
  void done.catch(() => {});
  return {
    done,
    checkpoint: (name: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Missing checkpoint ${name}: ${stderr} ${stdout}`)),
          8000,
        );
        const check = () => {
          if (stderr.includes(`checkpoint:${name}\n`)) {
            clearTimeout(timer);
            resolve();
          }
        };
        listeners.push(check);
        check();
      }),
    next: () => child.stdin.write('\n'),
    kill: () => child.kill(),
  };
}
const run = (request: Request) => start(request).done;
const recover = async (request: Request, action = 'inspect') => {
  const inspect = { version: 1, action: 'inspect', operationDirectory: request.operationDirectory };
  if (action !== 'rollback') return run({ ...inspect, action });
  const snapshot = await run(inspect);
  return run({ ...inspect, action, inspectionToken: snapshot.inspectionToken ?? '0'.repeat(64) });
};

describe.skipIf(process.platform !== 'win32')('native NTFS safe apply', () => {
  beforeAll(async () => {
    execFileSync(process.execPath, ['scripts/build-safe-apply.mjs'], { windowsHide: true });
    const fixtureRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'astrisle-winfs-fixture-')),
    );
    roots.push(fixtureRoot);
    fixtureBinary = path.join(fixtureRoot, 'safe-apply-test.exe');
    execFileSync(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ),
      [
        '/nologo',
        '/define:TEST_HOOKS',
        '/r:System.Web.Extensions.dll',
        `/out:${fixtureBinary}`,
        path.resolve('workers/winfs/SafeApply.cs'),
      ],
      { windowsHide: true },
    );
    reparseBinary = path.join(fixtureRoot, 'reparse-writer.exe');
    execFileSync(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ),
      ['/nologo', `/out:${reparseBinary}`, path.resolve('tests/fixtures/winfs-reparse-writer.cs')],
      { windowsHide: true },
    );
    mappedBinary = path.join(fixtureRoot, 'mapped-writer.exe');
    execFileSync(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ),
      ['/nologo', `/out:${mappedBinary}`, path.resolve('tests/fixtures/winfs-mapped-writer.cs')],
      { windowsHide: true },
    );
  });
  afterAll(async () => {
    for (const dir of roots.filter((dir) => dir.includes('winfs-fixture')))
      await rm(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    await Promise.all(
      [...activeChildren].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once('close', resolve);
            child.kill();
          }),
      ),
    );
    // Keep the fixture binary until the suite ends; all other roots contain only test data.
    for (const dir of roots.filter((dir) => !dir.includes('winfs-fixture')))
      await rm(dir, { recursive: true, force: true });
  });

  it('applies real files, durably backs up originals, inspects and rolls back', async () => {
    const request = await scenario();
    expect((await run(request)).status).toBe('applied');
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('after0');
    expect(
      await readFile(path.join(request.operationDirectory, 'native-backup-0.bin'), 'utf8'),
    ).toBe('before0');
    expect((await recover(request)).canRollback).toBe(true);
    expect((await recover(request, 'rollback')).status).toBe('rolled_back');
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('before0');
  });

  it('rejects a changed baseline before changing any existing original', async () => {
    const request = await scenario();
    await writeFile(path.join(request.sourceRoot, 'file1.txt'), 'user edit');
    expect((await run(request)).status).toBe('conflict');
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('before0');
  });

  it('never overwrites a foreign newly created file and removes own completed creates on rollback', async () => {
    const request = await scenario(1);
    request.files[0]!.action = 'create';
    request.files[0]!.beforeHash = null as unknown as string;
    expect((await run(request)).status).toBe('conflict');
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('before0');
    const second = await scenario(1);
    second.files[0]!.path = 'new.txt';
    second.files[0]!.action = 'create';
    second.files[0]!.beforeHash = null as unknown as string;
    expect((await run(second)).status).toBe('applied');
    expect((await recover(second, 'rollback')).status).toBe('rolled_back');
    expect(existsSync(path.join(second.sourceRoot, 'new.txt'))).toBe(false);
  });

  it('rejects candidate tampering, traversal, case collisions, alternate streams and hardlinks', async () => {
    for (const mode of ['candidate', 'traversal', 'case', 'ads', 'hardlink']) {
      const request = await scenario();
      if (mode === 'candidate') await writeFile(request.files[0]!.candidatePath, 'tampered');
      if (mode === 'traversal') request.files[0]!.path = '../outside.txt';
      if (mode === 'case') request.files[1]!.path = 'FILE0.txt';
      if (mode === 'ads') request.files[0]!.path = 'file0.txt:stream';
      if (mode === 'hardlink')
        await link(
          path.join(request.sourceRoot, 'file0.txt'),
          path.join(request.sourceRoot, 'alias.txt'),
        );
      expect((await run(request)).ok, mode).toBe(false);
      expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('before0');
    }
  });

  it('rejects a junction ancestor', async () => {
    const request = await scenario(1);
    const external = path.join(request.dir, 'external');
    await mkdir(external);
    await writeFile(path.join(external, 'original.txt'), 'before0');
    await symlink(external, path.join(request.sourceRoot, 'junction'), 'junction');
    request.files[0]!.path = 'junction/original.txt';
    expect((await run(request)).status).toBe('unsupported');
    expect(await readFile(path.join(external, 'original.txt'), 'utf8')).toBe('before0');
  });

  it('rejects Windows device names and overlong full target paths before creation', async () => {
    for (const name of ['COM¹.txt', 'CONIN$.txt', `${'x'.repeat(200)}.txt`]) {
      const request = await scenario(1);
      request.files[0]!.path = name;
      request.files[0]!.action = 'create';
      request.files[0]!.beforeHash = null as unknown as string;
      expect((await run(request)).status, name).toBe('unsupported');
      expect(existsSync(path.join(request.sourceRoot, name))).toBe(false);
    }
  });

  it('preserves Unicode filenames and result paths through the UTF-8 JSON protocol', async () => {
    const request = await scenario(1);
    await rename(
      path.join(request.sourceRoot, 'file0.txt'),
      path.join(request.sourceRoot, '现有文件.ts'),
    );
    const candidate = path.join(request.operationDirectory, '候选文件.bin');
    await rename(request.files[0]!.candidatePath, candidate);
    request.files[0]!.path = '现有文件.ts';
    request.files[0]!.candidatePath = candidate;
    expect(await run(request)).toMatchObject({
      status: 'applied',
      files: [{ path: '现有文件.ts', state: 'after' }],
    });
    expect(await readFile(path.join(request.sourceRoot, '现有文件.ts'), 'utf8')).toBe('after0');
    expect((await recover(request, 'rollback')).status).toBe('rolled_back');
  });

  it('rejects an actual attribute-only junction replacement before writing any redirected file', async () => {
    const request = await scenario(1);
    const target = path.join(request.dir, 'external');
    await mkdir(target);
    const control = path.join(request.dir, 'control');
    await mkdir(control);
    const attempt = (directory: string, access: string) =>
      execFileSync(reparseBinary, [directory, target, access], {
        windowsHide: true,
        encoding: 'utf8',
      });
    expect(attempt(control, 'write')).toBe('set');
    request.files[0]!.path = 'nested/new.txt';
    request.files[0]!.action = 'create';
    request.files[0]!.beforeHash = null as unknown as string;
    const child = start(request, true);
    await child.checkpoint('prepared');
    const directory = path.join(request.sourceRoot, 'nested');
    try {
      expect(attempt(directory, 'write')).toBe('open_error:32');
      expect(attempt(directory, 'attributes')).toBe('set');
      child.next();
      await child.checkpoint('locked');
      child.next();
      expect((await child.done).status).toBe('unsupported');
    } finally {
      child.kill();
      await child.done.catch(() => {});
    }
    expect(existsSync(path.join(target, 'new.txt'))).toBe(false);
  });

  it('anchors a CREATE_NEW lookup when a junction is installed after the last parent reparse check', async () => {
    const request = await scenario(1);
    const target = path.join(request.dir, 'external');
    await mkdir(target);
    const directory = path.join(request.sourceRoot, 'nested');
    request.files[0]!.path = 'nested/new.txt';
    request.files[0]!.action = 'create';
    request.files[0]!.beforeHash = null as unknown as string;
    const child = start(
      { ...request, testPauseBeforeNativeOpen: path.join(directory, 'new.txt') },
      true,
    );
    try {
      for (const point of ['prepared', 'locked']) {
        await child.checkpoint(point);
        child.next();
      }
      await child.checkpoint('before_native_open');
      expect(
        execFileSync(reparseBinary, [directory, target, 'attributes'], {
          windowsHide: true,
          encoding: 'utf8',
        }),
      ).toBe('set');
      child.next();
      // OBJ_DONT_REPARSE rejects the raced reparse root during the native open,
      // even though the parent's last userspace attribute check already passed.
      expect((await child.done).status).toBe('unsupported');
      expect(existsSync(path.join(target, 'new.txt'))).toBe(false);
      expect(
        execFileSync(reparseBinary, [directory, target, 'remove'], {
          windowsHide: true,
          encoding: 'utf8',
        }),
      ).toBe('removed');
      expect(existsSync(path.join(directory, 'new.txt'))).toBe(false);
    } finally {
      child.kill();
      await child.done.catch(() => {});
    }
  });

  it('never follows a candidate-directory junction installed immediately before its anchored open', async () => {
    const request = await scenario(1);
    const candidates = path.join(request.operationDirectory, 'candidates');
    await mkdir(candidates);
    const candidate = path.join(candidates, 'result.txt');
    await rename(request.files[0]!.candidatePath, candidate);
    request.files[0]!.candidatePath = candidate;
    const target = path.join(request.dir, 'external');
    await mkdir(target);
    await writeFile(path.join(target, 'result.txt'), 'after0');
    const child = start({ ...request, testPauseBeforeNativeOpen: candidate }, true);
    try {
      await child.checkpoint('before_native_open');
      await rm(candidate);
      expect(
        execFileSync(reparseBinary, [candidates, target, 'attributes'], {
          windowsHide: true,
          encoding: 'utf8',
        }),
      ).toBe('set');
      child.next();
      expect((await child.done).status).toBe('unsupported');
      expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('before0');
      expect(existsSync(path.join(target, 'native-plan.json'))).toBe(false);
    } finally {
      child.kill();
      await child.done.catch(() => {});
    }
  });

  it('keeps private state safe when an external process attempts an operation-directory junction race', async () => {
    const request = await scenario(1);
    const target = path.join(request.dir, 'external');
    await mkdir(target);
    const journal = path.join(request.operationDirectory, 'native-journal.ndjson');
    const child = start({ ...request, testPauseBeforeNativeOpen: journal }, true);
    try {
      await child.checkpoint('prepared');
      child.next();
      await child.checkpoint('before_native_open');
      // The exclusive native-lock makes this directory nonempty and prevents
      // removing its last owned entry; NTFS refuses a junction on that directory.
      expect(
        execFileSync(reparseBinary, [request.operationDirectory, target, 'attributes'], {
          windowsHide: true,
          encoding: 'utf8',
        }),
      ).toBe('io_error:145');
      await expect(rm(path.join(request.operationDirectory, 'native-lock'))).rejects.toThrow();
      child.next();
      for (const point of ['locked', 'mid_write:0', 'after_write:0']) {
        await child.checkpoint(point);
        child.next();
      }
      expect((await child.done).status).toBe('applied');
      expect(existsSync(path.join(target, 'native-journal.ndjson'))).toBe(false);
      expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('after0');
      expect((await recover(request)).status).toBe('applied');
    } finally {
      child.kill();
      await child.done.catch(() => {});
    }
  });

  it('holds real exclusive locks against an external writer, competing helper and directory rename', async () => {
    const request = await scenario();
    const child = start(request, true);
    await child.checkpoint('prepared');
    child.next();
    await child.checkpoint('locked');
    expect((await run(request)).status).toBe('busy');
    expect(() =>
      execFileSync(
        process.execPath,
        [
          '-e',
          'require("fs").writeFileSync(process.argv[1], "external")',
          path.join(request.sourceRoot, 'file0.txt'),
        ],
        { windowsHide: true, stdio: 'pipe' },
      ),
    ).toThrow();
    await expect(rename(request.sourceRoot, `${request.sourceRoot}-moved`)).rejects.toThrow();
    await expect(
      link(
        path.join(request.sourceRoot, 'file0.txt'),
        path.join(request.sourceRoot, 'late-hardlink.txt'),
      ),
    ).rejects.toThrow();
    child.kill();
    await child.done.catch(() => {});
    expect((await recover(request)).status).toBe('not_started');
  });

  it('refuses an original with a live writable mapping after the external file handle closes', async () => {
    for (const mode of ['view', 'section']) {
      const request = await scenario(1);
      const mapper = spawn(mappedBinary, [path.join(request.sourceRoot, 'file0.txt'), mode], {
        windowsHide: true,
      });
      activeChildren.add(mapper);
      mapper.once('close', () => activeChildren.delete(mapper));
      const exited = new Promise<void>((resolve) => mapper.once('close', () => resolve()));
      try {
        await new Promise<void>((resolve, reject) => {
          mapper.stdout.once('data', (data) =>
            data.toString().includes('ready') ? resolve() : reject(new Error(data.toString())),
          );
          mapper.once('error', reject);
        });
        expect((await run(request)).status).toBe('busy');
        expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('before0');
      } finally {
        mapper.stdin.end('edit\n');
        await exited;
      }
      expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('user000');
    }
  });

  it('rechecks the baseline inside locks after preparation', async () => {
    const request = await scenario();
    const child = start(request, true);
    await child.checkpoint('prepared');
    await writeFile(path.join(request.sourceRoot, 'file1.txt'), 'late user edit');
    child.next();
    expect((await child.done).status).toBe('conflict');
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('before0');
  });

  it('reconciles an actual crash after one write and never silently resumes', async () => {
    const request = await scenario();
    const child = start(request, true);
    for (const point of ['prepared', 'locked', 'mid_write:0']) {
      await child.checkpoint(point);
      child.next();
    }
    await child.checkpoint('after_write:0');
    child.kill();
    await child.done.catch(() => {});
    const inspected = await recover(request);
    expect(inspected.status).toBe('interrupted');
    expect(inspected.canRollback).toBe(true);
    expect((await run(request)).status).toBe('interrupted');
    expect(await readFile(path.join(request.sourceRoot, 'file1.txt'), 'utf8')).toBe('before1');
    expect((await recover(request, 'rollback')).status).toBe('rolled_back');
  });

  it('preserves later user edits and replacement identities during rollback', async () => {
    for (const replace of [false, true]) {
      const request = await scenario();
      expect((await run(request)).status).toBe('applied');
      const destination = path.join(request.sourceRoot, 'file0.txt');
      if (replace) {
        await rename(destination, `${destination}.old`);
        await writeFile(destination, 'after0');
      } else await writeFile(destination, 'later user edit');
      expect((await recover(request, 'rollback')).status).toBe('interrupted');
      expect(await readFile(destination, 'utf8')).toBe(replace ? 'after0' : 'later user edit');
      expect(await readFile(path.join(request.sourceRoot, 'file1.txt'), 'utf8')).toBe('after1');
    }
  });

  it('rejects an inspection token when an unpreviewed baseline file becomes restorable before confirmation', async () => {
    const request = await scenario();
    expect((await run(request)).status).toBe('applied');
    await writeFile(path.join(request.sourceRoot, 'file1.txt'), 'before1');
    const snapshot = await recover(request);
    expect(snapshot.files.map((file) => file.state)).toEqual(['after', 'before']);
    const journal = path.join(request.operationDirectory, 'native-journal.ndjson');
    const journalBefore = await readFile(journal);
    await writeFile(path.join(request.sourceRoot, 'file1.txt'), 'after1');
    const result = await run({
      version: 1,
      action: 'rollback',
      operationDirectory: request.operationDirectory,
      inspectionToken: snapshot.inspectionToken ?? '0'.repeat(64),
    });
    expect(result).toMatchObject({ status: 'interrupted', canRollback: false });
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('after0');
    expect(await readFile(path.join(request.sourceRoot, 'file1.txt'), 'utf8')).toBe('after1');
    expect(snapshot.inspectionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inspectionToken).toBeNull();
    expect((await readFile(journal)).equals(journalBefore)).toBe(true);
    expect((await recover(request, 'rollback')).status).toBe('rolled_back');
  });

  it('rejects an inspection token after matching-byte identity replacement without restoring any file', async () => {
    const request = await scenario();
    expect((await run(request)).status).toBe('applied');
    const snapshot = await recover(request);
    const file = path.join(request.sourceRoot, 'file1.txt');
    await rename(file, `${file}.original`);
    await writeFile(file, 'after1');
    const result = await run({
      version: 1,
      action: 'rollback',
      operationDirectory: request.operationDirectory,
      inspectionToken: snapshot.inspectionToken ?? '0'.repeat(64),
    });
    expect(result).toMatchObject({ status: 'interrupted', canRollback: false });
    expect(result.conflicts).toContain('file1.txt');
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('after0');
    expect(await readFile(file, 'utf8')).toBe('after1');
    expect(snapshot.inspectionToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires an inspection token bound to the same immutable operation before any rollback', async () => {
    const first = await scenario(1);
    const second = await scenario(1);
    expect((await run(first)).status).toBe('applied');
    expect((await run(second)).status).toBe('applied');
    const snapshot = await recover(first);
    expect(snapshot.inspectionToken).toMatch(/^[a-f0-9]{64}$/);
    for (const inspectionToken of [undefined, snapshot.inspectionToken ?? '0'.repeat(64)]) {
      expect(
        await run({
          version: 1,
          action: 'rollback',
          operationDirectory: second.operationDirectory,
          inspectionToken,
        }),
      ).toMatchObject({ status: 'interrupted', canRollback: false });
      expect(await readFile(path.join(second.sourceRoot, 'file0.txt'), 'utf8')).toBe('after0');
    }
  });

  it('retains durable backups and reports divergent bytes after a mid-write process kill', async () => {
    const request = await scenario();
    const child = start(request, true);
    for (const point of ['prepared', 'locked']) {
      await child.checkpoint(point);
      child.next();
    }
    await child.checkpoint('mid_write:0');
    child.kill();
    await child.done.catch(() => {});
    expect((await recover(request)).files[0]?.state).toBe('diverged');
    expect((await recover(request, 'rollback')).status).toBe('interrupted');
    expect(
      await readFile(path.join(request.operationDirectory, 'native-backup-0.bin'), 'utf8'),
    ).toBe('before0');
  });

  it('is idempotent and treats malformed journal as unknown without changing originals', async () => {
    const request = await scenario();
    expect((await run(request)).status).toBe('applied');
    expect(await run(request)).toMatchObject({ status: 'applied' });
    await writeFile(path.join(request.operationDirectory, 'native-journal.ndjson'), '{broken');
    expect((await recover(request, 'rollback')).status).toBe('unknown');
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('after0');
  });

  it('creates safe nested parents and retains empty directories after rollback', async () => {
    const request = await scenario(1);
    request.files[0]!.path = 'new/nested/result.txt';
    request.files[0]!.action = 'create';
    request.files[0]!.beforeHash = null as unknown as string;
    expect((await run(request)).status).toBe('applied');
    expect(await readFile(path.join(request.sourceRoot, 'new/nested/result.txt'), 'utf8')).toBe(
      'after0',
    );
    expect((await recover(request, 'rollback')).status).toBe('rolled_back');
    expect(existsSync(path.join(request.sourceRoot, 'new/nested'))).toBe(true);
    expect(existsSync(path.join(request.sourceRoot, 'new/nested/result.txt'))).toBe(false);
  });

  it('removes owned empty reservations after an actual crash before data writes', async () => {
    const request = await scenario(1);
    request.files[0]!.path = 'new.txt';
    request.files[0]!.action = 'create';
    request.files[0]!.beforeHash = null as unknown as string;
    const child = start(request, true);
    for (const point of ['prepared', 'locked']) {
      await child.checkpoint(point);
      child.next();
    }
    await child.checkpoint('reserved:0');
    child.kill();
    await child.done.catch(() => {});
    expect((await recover(request)).files[0]?.state).toBe('reserved');
    expect((await recover(request, 'rollback')).status).toBe('rolled_back');
    expect(existsSync(path.join(request.sourceRoot, 'new.txt'))).toBe(false);
  });

  it('rejects a racing CREATE_NEW collision after locking without changing any existing original', async () => {
    const request = await scenario(2);
    request.files[1]!.path = 'foreign.txt';
    request.files[1]!.action = 'create';
    request.files[1]!.beforeHash = null as unknown as string;
    const child = start(request, true);
    for (const point of ['prepared']) {
      await child.checkpoint(point);
      child.next();
    }
    await child.checkpoint('locked');
    await writeFile(path.join(request.sourceRoot, 'foreign.txt'), 'racing external file');
    child.next();
    expect((await child.done).status).toBe('conflict');
    expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('before0');
    expect(await readFile(path.join(request.sourceRoot, 'foreign.txt'), 'utf8')).toBe(
      'racing external file',
    );
    expect((await recover(request)).status).toBe('not_started');
  });

  it('cleans earlier owned reservations when a later CREATE_NEW collides', async () => {
    const request = await scenario(3);
    request.files[0]!.path = 'owned-new.txt';
    request.files[0]!.action = 'create';
    request.files[0]!.beforeHash = null as unknown as string;
    request.files[2]!.action = 'create';
    request.files[2]!.beforeHash = null as unknown as string;
    expect((await run(request)).status).toBe('conflict');
    expect(existsSync(path.join(request.sourceRoot, 'owned-new.txt'))).toBe(false);
    expect(await readFile(path.join(request.sourceRoot, 'file1.txt'), 'utf8')).toBe('before1');
    expect(await readFile(path.join(request.sourceRoot, 'file2.txt'), 'utf8')).toBe('before2');
    expect((await recover(request)).status).toBe('not_started');
  });

  it('preserves an unproven empty creation after a crash before its identity receipt', async () => {
    const request = await scenario(1);
    request.files[0]!.path = 'new.txt';
    request.files[0]!.action = 'create';
    request.files[0]!.beforeHash = null as unknown as string;
    const child = start({ ...request, testPauseCreatedBeforeIdentity: true }, true);
    for (const point of ['prepared', 'locked']) {
      await child.checkpoint(point);
      child.next();
    }
    await child.checkpoint('created_unrecorded:0');
    child.kill();
    await child.done.catch(() => {});
    const inspected = await recover(request);
    expect(inspected).toMatchObject({
      status: 'interrupted',
      canRollback: false,
      files: [{ path: 'new.txt', state: 'diverged' }],
    });
    expect((await recover(request, 'rollback')).status).toBe('interrupted');
    expect(await readFile(path.join(request.sourceRoot, 'new.txt'), 'utf8')).toBe('');
  });

  it('refuses malformed sequence/plan state and tampered backup bytes without rollback writes', async () => {
    for (const mode of ['sequence', 'backup', 'orphan']) {
      const request = await scenario(1);
      expect((await run(request)).status).toBe('applied');
      if (mode === 'sequence') {
        const journal = path.join(request.operationDirectory, 'native-journal.ndjson');
        const lines = (await readFile(journal, 'utf8')).trimEnd().split('\n');
        const record = JSON.parse(lines[1]!) as { seq: number };
        record.seq = 99;
        lines[1] = JSON.stringify(record);
        await writeFile(journal, lines.join('\n') + '\n');
      }
      if (mode === 'backup')
        await writeFile(
          path.join(request.operationDirectory, 'native-backup-0.bin'),
          'wrong backup',
        );
      if (mode === 'orphan') await rm(path.join(request.operationDirectory, 'native-plan.json'));
      const result = await recover(request, 'rollback');
      expect(['unknown', 'interrupted']).toContain(result.status);
      expect(result.canRollback).toBe(false);
      expect(await readFile(path.join(request.sourceRoot, 'file0.txt'), 'utf8')).toBe('after0');
    }
  });
});
