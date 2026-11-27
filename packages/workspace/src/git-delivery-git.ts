import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPlainPath, contained, validatePath } from '../../executor/src/path-guard';

export const objectId = /^[a-f0-9]{40}$/;
export const maxGitFile = 32 * 1024 * 1024;
const maxDiff = 48 * 1024;
const github = /^https:\/\/github\.com\/([a-zA-Z0-9-]{1,39})\/([a-zA-Z0-9_.-]{1,100})$/i;

type GitRemote = { transport: 'https' | 'file'; url: string; display: string };
type GitOptions = {
  input?: Buffer;
  acceptMissing?: boolean;
  maxBytes?: number;
  truncate?: boolean;
  transport?: GitRemote['transport'];
  date?: string;
};

export class GitDeliveryError extends Error {}

export class DeliveryGit {
  private constructor(private directory: string) {}

  static async inTemporaryRepository<T>(
    root: string,
    action: (git: DeliveryGit) => Promise<T>,
  ): Promise<T> {
    await assertPlainPath(root, true);
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'git-'));
    try {
      const git = new DeliveryGit(directory);
      await mkdir(join(directory, 'no-hooks'));
      await writeFile(join(directory, 'empty-config'), '');
      await git.run(['init', '--bare', '--template=', '--object-format=sha1']);
      return await action(git);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private run(args: string[], options: GitOptions = {}) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(GIT|GCM)_/i.test(key)),
    );
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: join(this.directory, 'empty-config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: options.transport ?? '',
      GCM_INTERACTIVE: '0',
      GCM_PRESERVE: '1',
    });
    if (options.date) {
      env.GIT_AUTHOR_DATE = options.date;
      env.GIT_COMMITTER_DATE = options.date;
    }
    const command = [
      '--git-dir',
      join(this.directory, 'repository.git'),
      '-c',
      'core.hooksPath=' + join(this.directory, 'no-hooks').replaceAll('\\', '/'),
      '-c',
      'core.attributesFile=' + join(this.directory, 'empty-config').replaceAll('\\', '/'),
      '-c',
      'core.protectNTFS=true',
      '-c',
      'core.protectHFS=true',
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      '-c',
      'user.name=Astrisle',
      '-c',
      'user.email=astrisle@users.noreply.github.com',
    ];
    if (options.transport === 'https')
      command.push(
        '-c',
        'credential.helper=manager',
        '-c',
        'http.followRedirects=false',
        '-c',
        'http.sslVerify=true',
      );

    // Diagnostics can contain URLs and credential-helper output. Return bounded stdout only.
    return new Promise<{ bytes: Buffer; truncated: boolean }>((resolve, reject) => {
      const child = spawn('git', [...command, ...args], {
        cwd: this.directory,
        windowsHide: true,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const maxBytes = options.maxBytes ?? maxGitFile;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Git 操作超时。'));
      }, 45_000);
      child.stdout.on('data', (chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, maxBytes - size));
        if (kept.length) chunks.push(kept);
        size += kept.length;
        if (kept.length !== chunk.length) {
          truncated = true;
          if (!options.truncate) child.kill();
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('无法启动 Git。请检查 Git for Windows 是否已安装并在 PATH 中。'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (truncated && !options.truncate) {
          reject(new Error('Git 输出超出交付支持的大小。'));
        } else if (code !== 0 && !(code === 1 && options.acceptMissing)) {
          reject(new Error('Git 操作失败。请检查远端状态、网络和 Git 凭据。'));
        } else {
          resolve({ bytes: Buffer.concat(chunks, size), truncated });
        }
      });
    });
  }

  async bytes(args: string[], options?: GitOptions): Promise<Buffer> {
    return (await this.run(args, options)).bytes;
  }

  async text(args: string[], options?: GitOptions): Promise<string> {
    return (await this.bytes(args, options)).toString('utf8').trimEnd();
  }

  async diff(base: string, commit: string) {
    const { bytes, truncated } = await this.run(
      [
        'diff-tree',
        '-p',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        base,
        commit,
        '--',
      ],
      { maxBytes: maxDiff, truncate: true },
    );
    // When clipped, ignore a trailing partial UTF-8 code point.
    return {
      diff: new TextDecoder().decode(bytes, { stream: truncated }),
      diffTruncated: truncated,
    };
  }

  async origin(source: string, localRemoteRoot?: string): Promise<GitRemote> {
    const config = join(source, '.git', 'config');
    await assertPlainPath(config);
    if (!(await lstat(config).catch(() => null))?.isFile())
      throw new GitDeliveryError('导入目录必须是带有 origin 远端的 Git 仓库根目录。');
    const options = { maxBytes: 2048, acceptMissing: true };
    const prefix = ['config', '--no-includes', '--file', config, '--null', '--get-all'];
    const urls = (await this.bytes([...prefix, 'remote.origin.url'], options)).toString('utf8');
    const pushUrls = await this.bytes([...prefix, 'remote.origin.pushurl'], options);
    if (!urls.endsWith('\0') || urls.indexOf('\0') !== urls.length - 1 || pushUrls.length)
      throw new GitDeliveryError('请为 origin 保留一个远端地址并移除独立的推送地址。');
    return this.remote(urls.slice(0, -1), localRemoteRoot);
  }

  async remote(value: string, localRemoteRoot?: string): Promise<GitRemote> {
    const remote = await resolveGitRemote(value, localRemoteRoot);
    if (remote.transport === 'file') {
      const config = (
        await this.bytes(
          ['config', '--no-includes', '--file', join(remote.display, 'config'), '--null', '--list'],
          { maxBytes: 4096 },
        )
      )
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      if (
        !config.includes('core.bare\ntrue') ||
        config.some(
          (entry) =>
            !/^core\.(bare|repositoryformatversion|filemode|symlinks|ignorecase)\n[^\n]+$/.test(
              entry,
            ),
        )
      )
        throw new GitDeliveryError('测试用远端必须由标准 git init --bare 创建。');
      await assertPlainPath(join(remote.display, 'refs', 'heads', 'astrisle'));
      for (const name of ['alternates', 'http-alternates']) {
        const entry = await lstat(join(remote.display, 'objects', 'info', name)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          },
        );
        if (entry) throw new GitDeliveryError('测试用远端不能引用外部 Git 对象。');
      }
    }
    return remote;
  }

  async refs(remote: GitRemote, targetBranch: string) {
    const targetRef = 'refs/heads/' + targetBranch;
    const lines = (
      await this.text(['ls-remote', '--symref', '--', remote.url, 'HEAD', targetRef], {
        maxBytes: 4096,
        transport: remote.transport,
      })
    ).split('\n');
    let baseBranch: string | undefined;
    let baseCommit: string | undefined;
    let targetCommit: string | null = null;
    for (const line of lines) {
      if (!line) continue;
      const [value, ref] = line.trimEnd().split('\t');
      if (ref === 'HEAD') {
        if (objectId.test(value)) baseCommit = value;
        else baseBranch = value.match(/^ref: refs\/heads\/(.+)$/)?.[1];
      } else if (ref === targetRef) {
        targetCommit = value;
      }
    }
    if (targetCommit !== null && !objectId.test(targetCommit))
      throw new Error('无法核查远端目标分支。');
    return { baseBranch, baseCommit, targetCommit };
  }

  async fetchBase(remote: GitRemote, baseBranch: string, baseCommit: string) {
    await this.run(['check-ref-format', 'refs/heads/' + baseBranch]);
    await this.run(
      [
        'fetch',
        '--depth=1',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--',
        remote.url,
        'refs/heads/' + baseBranch + ':refs/astrisle/delivery-base',
      ],
      { transport: remote.transport },
    );
    if ((await this.text(['rev-parse', 'refs/astrisle/delivery-base^{commit}'])) !== baseCommit)
      throw new GitDeliveryError('远端默认分支已更新，请重新准备交付。');
  }

  private async assertDeliveryAttributes(paths: Set<string>) {
    const values = (
      await this.bytes(['check-attr', '--cached', '--all', '-z', '--stdin'], {
        input: Buffer.from([...paths].join('\0') + '\0'),
      })
    )
      .toString('utf8')
      .split('\0');
    if (values.length % 3 !== 1 || values.at(-1) !== '')
      throw new Error('无法确认交付路径的 Git 属性。');
    for (let offset = 0; offset < values.length - 1; offset += 3) {
      const [path, attribute] = values.slice(offset, offset + 2);
      if (!paths.has(path)) throw new Error('无法确认交付路径的 Git 属性。');
      if (attribute === 'filter' || attribute === 'working-tree-encoding')
        throw new GitDeliveryError(
          '交付路径声明了 Git ' + attribute + '，请使用原仓库流程交付：' + path,
        );
    }
  }

  async createCommit(
    base: string,
    indexEntries: string[],
    paths: string[],
    operationId: string,
    date: string,
  ) {
    const acceptedPaths = new Set(paths);
    await this.run(['read-tree', base]);
    await this.assertDeliveryAttributes(acceptedPaths);
    await this.run(['update-index', '-z', '--index-info'], {
      input: Buffer.from(indexEntries.map((entry) => entry + '\0').join('')),
    });
    // An accepted .gitattributes change can introduce a conversion in the candidate tree.
    await this.assertDeliveryAttributes(acceptedPaths);
    const tree = await this.text(['write-tree']);
    const commit = await this.text(
      ['commit-tree', tree, '-p', base, '-m', 'Astrisle delivery ' + operationId],
      { date },
    );
    if (!objectId.test(commit)) throw new Error('无法确认 Git 提交标识。');
    return commit;
  }

  async push(remote: GitRemote, branch: string, commit: string): Promise<void> {
    const ref = 'refs/heads/' + branch;
    await this.run(
      [
        'push',
        '--porcelain',
        '--no-verify',
        '--force-with-lease=' + ref + ':',
        '--',
        remote.url,
        commit + ':' + ref,
      ],
      { transport: remote.transport },
    );
  }
}

export async function resolveGitRemote(
  value: string,
  localRemoteRoot?: string,
): Promise<GitRemote> {
  const match = github.exec(value);
  if (match) {
    const repo = match[2].replace(/\.git$/i, '');
    if (repo && repo !== '.' && repo !== '..') {
      const display = 'https://github.com/' + match[1] + '/' + repo;
      return { transport: 'https', url: display + '.git', display };
    }
  }
  if (localRemoteRoot) {
    try {
      // The application never sets this root. It is an explicit local-fixture capability.
      const root = await realpath(localRemoteRoot);
      const local = value.startsWith('file:///') ? fileURLToPath(value) : value;
      validatePath(local);
      if (!isAbsolute(local) || !contained(root, local) || !relative(root, local))
        throw new Error('Outside the fixture');
      await assertPlainPath(local);
      const canonical = await realpath(local);
      if (!contained(root, canonical) || !relative(root, canonical))
        throw new Error('Outside the fixture');
      for (const entry of ['HEAD', 'config', 'objects', 'refs'])
        await assertPlainPath(join(canonical, entry));
      if (
        (await lstat(join(canonical, 'HEAD'))).isFile() &&
        (await lstat(join(canonical, 'config'))).isFile() &&
        (await lstat(join(canonical, 'objects'))).isDirectory() &&
        (await lstat(join(canonical, 'refs'))).isDirectory()
      )
        return { transport: 'file', url: pathToFileURL(canonical).href, display: canonical };
    } catch {
      throw new GitDeliveryError('本地远端必须是已授权测试目录中的 bare 仓库。');
    }
  }
  throw new GitDeliveryError('origin 必须是无内嵌凭据的 GitHub HTTPS 仓库地址。');
}
