import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, readArtifact } from '../../artifacts/src/index';
import type { Artifact, ProjectSnapshot } from '../../contracts/src/index';
import type {
  GitDeliveryChange,
  GitDeliveryPreview,
  GitDeliveryReceipt,
} from '../../contracts/src/git-delivery';
import { assertPlainPath, contained, validatePath } from '../../executor/src/path-guard';
import {
  DeliveryGit,
  GitDeliveryError,
  maxGitFile,
  objectId,
  resolveGitRemote,
} from './git-delivery-git';
import { readManifest } from './index';

const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const active = new Map<string, Promise<unknown>>();
const maxFiles = 512;
const maxTotal = 256 * 1024 * 1024;
const now = () => new Date().toISOString();
const branchFor = (operationId: string) => 'astrisle/delivery-' + operationId;

type Remote = Awaited<ReturnType<typeof resolveGitRemote>>;
type ArtifactPin = Pick<Artifact, 'relativePath' | 'id' | 'versionId' | 'sha256' | 'size'>;
type Plan = {
  version: 1;
  generation?: number;
  sourcePath: string;
  workPath: string;
  revision: number;
  artifacts: ArtifactPin[];
  createdAt: string;
  expectedCommit: string;
  receipt: GitDeliveryReceipt;
};
type TreeEntry = { path: string; mode: string; object: string };

function acceptedArtifacts(snapshot: ProjectSnapshot): Artifact[] {
  const { commission } = snapshot;
  const current = snapshot.artifacts.filter((a) => a.validity === 'current');
  const acceptedIds = new Set(commission.acceptedArtifactIds);
  const reviewedVersions = new Set(
    snapshot.evidence
      .filter((e) => e.kind === 'review' && e.status === 'passed')
      .flatMap((e) => e.artifactVersionIds),
  );
  if (
    commission.status !== 'accepted' ||
    commission.workspaceId !== snapshot.workspace.id ||
    !current.length ||
    current.some(
      (a) =>
        a.commissionId !== commission.id ||
        !acceptedIds.has(a.id) ||
        !reviewedVersions.has(a.versionId),
    )
  )
    throw new GitDeliveryError('请先完成所有当前成果版本的复核与验收。');
  return current.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : a.versionId.localeCompare(b.versionId),
  );
}

function artifactPins(artifacts: Artifact[]): ArtifactPin[] {
  return artifacts.map(({ relativePath, id, versionId, sha256, size }) => ({
    relativePath,
    id,
    versionId,
    sha256,
    size,
  }));
}

function assertCurrent(snapshot: ProjectSnapshot, plan: Plan): Artifact[] {
  if (
    snapshot.commission.id !== plan.receipt.preview.commissionId ||
    snapshot.commission.revision !== plan.revision ||
    snapshot.workspace.sourcePath !== plan.sourcePath ||
    snapshot.workspace.workPath !== plan.workPath
  )
    throw new GitDeliveryError('委托或项目目录已变化，请重新准备交付。');
  const current = acceptedArtifacts(snapshot);
  if (!isDeepStrictEqual(artifactPins(current), plan.artifacts))
    throw new GitDeliveryError('当前验收版本已变化，请重新准备交付。');
  return current;
}

function fold(value: string) {
  return value.normalize('NFC').toLowerCase();
}

function pathParts(value: string) {
  validatePath(value);
  const parts = value.split('/');
  if (
    /[:\\\x7f]/.test(value) ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        /[. ]$/.test(part) ||
        /^(\.git|git~[0-9]+)$/i.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part),
    )
  )
    throw new GitDeliveryError('成果包含不受支持的 Git 路径。');
  return parts;
}

class BaseTree {
  private directories = new Map<string, Map<string, TreeEntry | null>>();

  constructor(
    private git: DeliveryGit,
    private commit: string,
  ) {}

  private async entries(tree: string) {
    const cached = this.directories.get(tree);
    if (cached) return cached;
    const entries = new Map<string, TreeEntry | null>();
    const output = await this.git.bytes(['ls-tree', '-z', tree]);
    for (const record of output.toString('utf8').split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const [mode, , object] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      if (tab < 1 || !mode || !objectId.test(object) || !path)
        throw new Error('无法读取远端 Git 目录。');
      const key = fold(path);
      entries.set(key, entries.has(key) ? null : { path, mode, object });
    }
    this.directories.set(tree, entries);
    return entries;
  }

  async file(parts: string[]): Promise<TreeEntry | undefined> {
    let tree = this.commit;
    for (const [index, part] of parts.entries()) {
      const entry = (await this.entries(tree)).get(fold(part));
      if (entry === undefined) return;
      const last = index === parts.length - 1;
      if (
        !entry ||
        entry.path !== part ||
        !(last ? /^100(644|755)$/.test(entry.mode) : entry.mode === '040000')
      )
        throw new GitDeliveryError('远端路径有目录、文件类型或大小写冲突：' + parts.join('/'));
      if (last) return entry;
      tree = entry.object;
    }
  }
}

function baselineMatches(bytes: Buffer, expected: string) {
  if (hash(bytes) === expected) return true;
  if (bytes.includes(0) || !bytes.includes(10)) return false;
  // A Windows text checkout can have CRLF where the committed blob has LF.
  const checkout = bytes.toString('latin1').replace(/(?<!\r)\n/g, '\r\n');
  return hash(Buffer.from(checkout, 'latin1')) === expected;
}

export class GitDeliveryService {
  private readonly dataRoot: string;
  private readonly operations: string;

  constructor(
    dataRoot: string,
    private readonly options: { localRemoteRoot?: string } = {},
  ) {
    this.dataRoot = resolve(dataRoot);
    this.operations = join(this.dataRoot, 'git-delivery');
  }

  private planDirectory(snapshot: ProjectSnapshot) {
    return join(
      this.operations,
      'receipts',
      hash(Buffer.from(JSON.stringify([snapshot.workspace.id, snapshot.commission.id]))),
    );
  }

  private planFile(snapshot: ProjectSnapshot, operationId: string) {
    if (!operationIdPattern.test(operationId)) throw new Error('未知的 Git 交付操作。');
    return join(this.planDirectory(snapshot), operationId + '.json');
  }

  private async load(snapshot: ProjectSnapshot, operationId: string): Promise<Plan> {
    const file = this.planFile(snapshot, operationId);
    await assertPlainPath(file);
    const plan = JSON.parse(await readFile(file, 'utf8')) as Plan;
    const preview = plan?.receipt?.preview;
    if (
      plan?.version !== 1 ||
      preview?.operationId !== operationId ||
      preview?.commissionId !== snapshot.commission.id ||
      preview?.targetBranch !== branchFor(operationId) ||
      !objectId.test(preview?.baseCommit ?? '') ||
      !objectId.test(plan.expectedCommit) ||
      !Array.isArray(plan.artifacts) ||
      plan.sourcePath !== snapshot.workspace.sourcePath ||
      plan.workPath !== snapshot.workspace.workPath
    )
      throw new Error('Git 交付记录与当前项目不匹配。');
    preview.revision ??= plan.revision;
    preview.acceptedVersionIds ??= plan.artifacts.map((artifact) => artifact.versionId).sort();
    return plan;
  }

  private async save(snapshot: ProjectSnapshot, plan: Plan) {
    const file = this.planFile(snapshot, plan.receipt.preview.operationId);
    const temporary = file + '.' + randomUUID() + '.tmp';
    await assertPlainPath(file, true);
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(plan), { flag: 'wx', flush: true });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async record(
    snapshot: ProjectSnapshot,
    plan: Plan,
    status: GitDeliveryReceipt['status'],
    message: string | null,
    remote?: Remote,
  ) {
    const { baseBranch, targetBranch } = plan.receipt.preview;
    plan.receipt = {
      preview: plan.receipt.preview,
      status,
      updatedAt: now(),
      message,
      commit: status === 'published' ? plan.expectedCommit : null,
      compareUrl:
        status === 'published' && remote?.transport === 'https'
          ? remote.display +
            '/compare/' +
            encodeURIComponent(baseBranch) +
            '...' +
            encodeURIComponent(targetBranch) +
            '?expand=1'
          : null,
    };
    await this.save(snapshot, plan);
    return plan.receipt;
  }

  private withGit<T>(action: (git: DeliveryGit) => Promise<T>) {
    return DeliveryGit.inTemporaryRepository(join(this.operations, 'temporary'), action);
  }

  private async commit(
    git: DeliveryGit,
    snapshot: ProjectSnapshot,
    baseCommit: string,
    operationId: string,
    createdAt: string,
    artifacts: Artifact[],
  ) {
    const baselinePath = join(dirname(snapshot.workspace.workPath), 'baseline.json');
    await assertPlainPath(baselinePath);
    const baseline = await readManifest(baselinePath);
    if (baseline.schemaVersion !== 1 || baseline.workspaceId !== snapshot.workspace.id)
      throw new GitDeliveryError('项目导入基线与当前工作区不匹配。');
    const exclusions = new Set(baseline.excluded.map(fold));
    const tree = new BaseTree(git, baseCommit);
    const changes: GitDeliveryChange[] = [];
    const entries: string[] = [];
    const paths = new Map<string, string>();
    const files = new Set<string>();
    let total = 0;
    for (const artifact of artifacts) {
      const path = artifact.relativePath;
      const parts = pathParts(path);
      const before = Object.hasOwn(baseline.files, path) ? baseline.files[path] : undefined;
      if (before === artifact.sha256) continue;
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > maxGitFile)
        throw new GitDeliveryError('单个交付文件超过支持的大小。');
      if (
        parts.some((_, index) => {
          const prefix = parts.slice(0, index + 1).join('/');
          const key = fold(prefix);
          const known = paths.get(key);
          paths.set(key, prefix);
          return exclusions.has(key) || (known !== undefined && known !== prefix) || files.has(key);
        }) ||
        Array.from(files).some((file) => file.startsWith(fold(path) + '/'))
      )
        throw new GitDeliveryError('成果路径重复、位于导入排除目录或与其他成果冲突：' + path);
      files.add(fold(path));

      const old = await tree.file(parts);
      const baselineConflict =
        '远端文件与导入基线不匹配。请将本地项目更新到远端基线后重新导入：' + path;
      if ((old === undefined) !== (before === undefined))
        throw new GitDeliveryError(baselineConflict);
      if (old) {
        const size = Number(await git.text(['cat-file', '-s', old.object]));
        if (!Number.isSafeInteger(size) || size < 0 || size > maxGitFile)
          throw new GitDeliveryError('远端文件超过支持的大小：' + path);
        const oldBytes = await git.bytes(['cat-file', 'blob', old.object]);
        if (!baselineMatches(oldBytes, before!)) throw new GitDeliveryError(baselineConflict);
        if (hash(oldBytes) === artifact.sha256) continue;
      }

      const bytes = await readArtifact(this.dataRoot, artifact);
      total += bytes.length;
      if (artifact.size !== bytes.length || total > maxTotal || changes.length >= maxFiles)
        throw new GitDeliveryError('交付超出支持的文件数量或大小。');
      const blob = await git.text(['hash-object', '-w', '--no-filters', '--stdin'], {
        input: bytes,
      });
      if (!objectId.test(blob)) throw new Error('无法确认 Git 文件标识。');
      changes.push({
        path,
        action: old ? 'modify' : 'add',
        size: bytes.length,
        artifactId: artifact.id,
        versionId: artifact.versionId,
      });
      entries.push((old?.mode ?? '100644') + ' ' + blob + '\t' + path);
    }
    if (!changes.length) throw new GitDeliveryError('当前验收成果没有可交付的 Git 文件改动。');
    const commit = await git.createCommit(
      baseCommit,
      entries,
      artifacts.map((artifact) => artifact.relativePath),
      operationId,
      createdAt,
    );
    return { commit, changes };
  }

  async prepare(snapshot: ProjectSnapshot): Promise<GitDeliveryPreview> {
    return this.exclusive(snapshot, async () => {
      const artifacts = acceptedArtifacts(snapshot);
      const previous = await this.latestPlan(snapshot);
      if (previous) {
        const versionsMatch = isDeepStrictEqual(artifactPins(artifacts), previous.artifacts);
        const revisionMatches = snapshot.commission.revision === previous.revision;
        const receipt = await this.inspectPlan(snapshot, previous);
        if (receipt.status === 'unknown') {
          if (versionsMatch && revisionMatches) return receipt.preview;
          throw new GitDeliveryError('上次 Git 推送仍待核查，核清后才能准备新的交付。');
        }
        if (
          versionsMatch &&
          (receipt.status === 'published' || (receipt.status === 'prepared' && revisionMatches))
        )
          return receipt.preview;
      }
      return this.prepareNew(snapshot, artifacts, (previous?.generation ?? 0) + 1);
    });
  }

  private async prepareNew(snapshot: ProjectSnapshot, artifacts: Artifact[], generation: number) {
    const { sourcePath, workPath } = snapshot.workspace;
    if (!sourcePath || contained(sourcePath, this.dataRoot) || contained(this.dataRoot, sourcePath))
      throw new GitDeliveryError('Git 交付需要一个独立于 Astrisle 数据目录的导入仓库。');
    const operationId = randomUUID();
    const targetBranch = branchFor(operationId);
    const createdAt = now();
    return this.withGit(async (git) => {
      const remote = await git.origin(sourcePath, this.options.localRemoteRoot);
      const { baseBranch, baseCommit, targetCommit } = await git.refs(remote, targetBranch);
      if (!baseBranch || !baseCommit || targetCommit)
        throw new GitDeliveryError('无法确认远端的默认分支或交付分支已存在。');
      await git.fetchBase(remote, baseBranch, baseCommit);
      const { commit, changes } = await this.commit(
        git,
        snapshot,
        baseCommit,
        operationId,
        createdAt,
        artifacts,
      );
      const preview: GitDeliveryPreview = {
        operationId,
        commissionId: snapshot.commission.id,
        revision: snapshot.commission.revision,
        acceptedVersionIds: artifacts.map((artifact) => artifact.versionId).sort(),
        remote: remote.display,
        baseBranch,
        baseCommit,
        targetBranch,
        changes,
        ...(await git.diff(baseCommit, commit)),
      };
      await this.save(snapshot, {
        version: 1,
        generation,
        sourcePath,
        workPath,
        revision: snapshot.commission.revision,
        artifacts: artifactPins(artifacts),
        createdAt,
        expectedCommit: commit,
        receipt: {
          preview,
          status: 'prepared',
          commit: null,
          compareUrl: null,
          message: null,
          updatedAt: createdAt,
        },
      });
      return preview;
    });
  }

  private async exclusive<T>(snapshot: ProjectSnapshot, action: () => Promise<T>) {
    const key = this.planDirectory(snapshot);
    const preceding = active.get(key) ?? Promise.resolve();
    const next = preceding.catch(() => {}).then(action);
    active.set(key, next);
    try {
      return await next;
    } finally {
      if (active.get(key) === next) active.delete(key);
    }
  }

  private async observe(snapshot: ProjectSnapshot, plan: Plan, git: DeliveryGit, remote: Remote) {
    const refs = await git.refs(remote, plan.receipt.preview.targetBranch);
    if (refs.targetCommit === plan.expectedCommit)
      return { refs, receipt: await this.record(snapshot, plan, 'published', null, remote) };
    if (refs.targetCommit)
      return {
        refs,
        receipt: await this.record(snapshot, plan, 'blocked', '目标分支已被其他提交占用。'),
      };
    return { refs };
  }

  async publish(
    snapshot: ProjectSnapshot,
    operationId: string,
    getCurrent?: () => ProjectSnapshot,
  ): Promise<GitDeliveryReceipt> {
    return this.exclusive(snapshot, async () => {
      const plan = await this.latestPlan(snapshot);
      if (!plan || plan.receipt.preview.operationId !== operationId)
        throw new GitDeliveryError('此确认对应的预览已失效，请查看最新交付操作。');
      if (plan.receipt.status === 'published' || plan.receipt.status === 'blocked')
        return plan.receipt;
      const previousPushUncertain = plan.receipt.status === 'unknown';
      const {
        remote: destination,
        baseBranch,
        baseCommit,
        targetBranch,
        changes,
      } = plan.receipt.preview;
      try {
        return await this.withGit(async (git) => {
          const remote = await git.remote(destination, this.options.localRemoteRoot);
          const observed = await this.observe(snapshot, plan, git, remote);
          if (observed.receipt) return observed.receipt;
          const artifacts = assertCurrent(getCurrent?.() ?? snapshot, plan);
          if ((await git.origin(plan.sourcePath, this.options.localRemoteRoot)).url !== remote.url)
            throw new GitDeliveryError('origin 远端已变化，请重新准备交付。');
          if (observed.refs.baseBranch !== baseBranch || observed.refs.baseCommit !== baseCommit)
            throw new GitDeliveryError('远端默认分支已更新，请重新准备交付。');
          await git.fetchBase(remote, baseBranch, baseCommit);
          const candidate = await this.commit(
            git,
            snapshot,
            baseCommit,
            operationId,
            plan.createdAt,
            artifacts,
          );
          if (
            candidate.commit !== plan.expectedCommit ||
            !isDeepStrictEqual(candidate.changes, changes)
          )
            throw new GitDeliveryError('交付内容已变化，请重新准备交付。');
          if ((await git.origin(plan.sourcePath, this.options.localRemoteRoot)).url !== remote.url)
            throw new GitDeliveryError('origin 远端已变化，请重新准备交付。');
          const rechecked = await this.observe(snapshot, plan, git, remote);
          if (rechecked.receipt) return rechecked.receipt;
          if (rechecked.refs.baseBranch !== baseBranch || rechecked.refs.baseCommit !== baseCommit)
            throw new GitDeliveryError('远端默认分支已更新，请重新准备交付。');
          // Persist the uncertain outcome before sending the only remote write.
          await this.record(snapshot, plan, 'unknown', '正在等待远端分支核查。');
          assertCurrent(getCurrent?.() ?? snapshot, plan);
          await git.push(remote, targetBranch, candidate.commit).catch(() => {});
          const result = await this.observe(snapshot, plan, git, remote);
          return (
            result.receipt ??
            this.record(snapshot, plan, 'unknown', '远端暂未显示目标分支。可以核查后重试原操作。')
          );
        });
      } catch (error) {
        if (error instanceof GitDeliveryError)
          return previousPushUncertain
            ? this.record(snapshot, plan, 'unknown', '上次推送仍待核查。' + error.message)
            : this.record(snapshot, plan, 'blocked', error.message);
        return this.record(
          snapshot,
          plan,
          plan.receipt.status,
          plan.receipt.status === 'unknown'
            ? '推送结果尚未核清，请检查远端和 Git 凭据后重新核查。'
            : '交付失败，请检查验收文件、网络和 Git 凭据后重试。',
        );
      }
    });
  }

  async inspect(snapshot: ProjectSnapshot, operationId: string): Promise<GitDeliveryReceipt> {
    return this.exclusive(snapshot, async () =>
      this.inspectPlan(snapshot, await this.load(snapshot, operationId)),
    );
  }

  async matchesPublishedHead(snapshot: ProjectSnapshot, operationId: string): Promise<boolean> {
    const plan = await this.load(snapshot, operationId);
    if (plan.receipt.status !== 'published') throw new Error('请先完成并核查分支推送。');
    return this.withGit(async (git) => {
      const remote = await git.remote(plan.receipt.preview.remote, this.options.localRemoteRoot);
      const refs = await git.refs(remote, plan.receipt.preview.targetBranch);
      return refs.targetCommit === plan.expectedCommit;
    });
  }

  private async inspectPlan(snapshot: ProjectSnapshot, plan: Plan): Promise<GitDeliveryReceipt> {
    if (plan.receipt.status !== 'unknown') return plan.receipt;
    try {
      return await this.withGit(async (git) => {
        const remote = await git.remote(plan.receipt.preview.remote, this.options.localRemoteRoot);
        const observed = await this.observe(snapshot, plan, git, remote);
        return (
          observed.receipt ??
          this.record(snapshot, plan, 'unknown', '远端暂未显示目标分支。可以核查后重试原操作。')
        );
      });
    } catch {
      return this.record(
        snapshot,
        plan,
        'unknown',
        '暂时无法读取远端，请检查网络和 Git 凭据后重试。',
      );
    }
  }

  private async latestPlan(snapshot: ProjectSnapshot): Promise<Plan | undefined> {
    const directory = this.planDirectory(snapshot);
    await assertPlainPath(directory);
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    let latest: Plan | undefined;
    for (const file of files) {
      const id = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!operationIdPattern.test(id)) continue;
      const plan = await this.load(snapshot, id);
      if (
        !latest ||
        (plan.generation ?? 0) > (latest.generation ?? 0) ||
        (plan.generation === latest.generation && plan.createdAt > latest.createdAt)
      )
        latest = plan;
    }
    return latest;
  }

  async latest(snapshot: ProjectSnapshot): Promise<GitDeliveryReceipt | null> {
    return (await this.latestPlan(snapshot))?.receipt ?? null;
  }
}
