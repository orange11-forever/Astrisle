import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ApplyChange,
  ApplyOperation,
  ApplyPreview,
  ApplyStatus,
  CommandResult,
  ProjectSnapshot,
  Workspace,
} from '../../contracts/src/index';
import type { RuntimeStore } from '../../persistence/src/index';
import { readArtifact, hash } from '../../artifacts/src/index';
import { assertPlainPath, contained } from '../../executor/src/path-guard';
import { manifestChanges, readManifest, scanWorkspaceManifest, type Manifest } from './index';
import { invokeWriteback, validateWritebackReceipt, type NativeApplyResult } from './native-apply';

interface Plan {
  version: 1;
  operationId: string;
  workspace: Workspace;
  commissionId: string;
  revision: number;
  acceptedVersions: string[];
  createdAt: string;
  expiresAt: string;
  baseline: Manifest;
  candidate: Manifest;
  changes: ApplyChange[];
  directory: string;
  files: {
    path: string;
    action: 'create' | 'modify';
    beforeHash: string | null;
    afterHash: string;
    candidatePath: string;
  }[];
  status: ApplyStatus;
  updatedAt: string;
  message: string;
  native?: NativeApplyResult;
}
const terminal = new Set(['prepared', 'applied', 'rolled_back', 'conflict']);
const idPattern = /^[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
const result = (ok: boolean, message: string, code?: string): CommandResult => ({
  ok,
  message,
  ...(code ? { code } : {}),
});
export class SafeApplyService {
  private rollbackPreviews = new Map<
    string,
    { planId: string; expires: number; inspectionToken: string }
  >();
  private helperPath: string;
  constructor(private options: { dataRoot: string; store: RuntimeStore; helperPath?: string }) {
    this.helperPath = options.helperPath ?? resolve('dist/helpers/safe-apply.exe');
  }
  private load(operationId: string): Plan {
    if (!idPattern.test(operationId)) throw new Error('Unknown writeback operation');
    const row = this.options.store.applyOperation(operationId);
    const plan = row?.data as Plan | undefined;
    const workspace = this.options.store.workspaces().find((w) => w.id === row?.workspaceId);
    if (
      !row ||
      !plan ||
      plan.version !== 1 ||
      plan.operationId !== row.id ||
      plan.status !== row.state ||
      plan.workspace?.id !== row.workspaceId ||
      plan.commissionId !== row.commissionId ||
      plan.directory !== join(this.options.dataRoot, 'apply-operations', row.id) ||
      !workspace ||
      workspace.sourcePath !== plan.workspace.sourcePath ||
      workspace.workPath !== plan.workspace.workPath ||
      !Array.isArray(plan.changes) ||
      !Array.isArray(plan.files) ||
      plan.files.length > 512
    )
      throw new Error('写回记录缺失或损坏，需人工核查');
    return plan;
  }
  private save(plan: Plan) {
    plan.updatedAt = now();
    this.options.store.putApplyOperation({
      id: plan.operationId,
      workspaceId: plan.workspace.id,
      commissionId: plan.commissionId,
      state: plan.status,
      data: plan,
    });
  }
  private public(plan: Plan): ApplyOperation {
    return {
      operationId: plan.operationId,
      workspaceId: plan.workspace.id,
      commissionId: plan.commissionId,
      sourcePath: plan.workspace.sourcePath,
      status: plan.status,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      message: plan.message,
      files: plan.native?.files ?? [],
      conflicts: plan.native?.conflicts ?? [],
      canRollback: plan.native?.canRollback ?? false,
    };
  }
  list(workspaceId: string): ApplyOperation[] {
    return this.options.store.applyOperations(workspaceId).map((row) => {
      try {
        return this.public(this.load(row.id));
      } catch {
        return {
          operationId: row.id,
          workspaceId,
          commissionId: row.commissionId,
          sourcePath: '',
          status: 'unknown',
          createdAt: '',
          updatedAt: '',
          message: '写回记录损坏，请保留备份并人工核查。',
          files: [],
          conflicts: ['记录无法读取'],
          canRollback: false,
        };
      }
    });
  }
  hasPending(workspaceId: string): boolean {
    return this.list(workspaceId).some((op) => !terminal.has(op.status));
  }
  async resolveDirectory(operationId: string): Promise<string> {
    if (!idPattern.test(operationId) || !this.options.store.applyOperation(operationId))
      throw new Error('Unknown writeback operation');
    const directory = join(this.options.dataRoot, 'apply-operations', operationId);
    await assertPlainPath(directory);
    if (!(await stat(directory)).isDirectory()) throw new Error('恢复记录目录不存在');
    return directory;
  }
  binding(previewId: string) {
    const rollback = this.rollbackPreviews.get(previewId);
    const plan = this.load(rollback?.planId ?? previewId);
    return {
      operationId: plan.operationId,
      workspaceId: plan.workspace.id,
      commissionId: plan.commissionId,
    };
  }
  private refused(
    workspace: Workspace,
    reason: string,
    changes: ApplyChange[] = [],
    conflicts: string[] = [],
  ): ApplyPreview {
    return {
      operationId: randomUUID(),
      sourcePath: workspace.sourcePath,
      mode: 'apply',
      changes,
      conflicts,
      supported: false,
      reason,
    };
  }
  private eligible(s: ProjectSnapshot, changes: ApplyChange[]) {
    return (
      s.commission.status === 'accepted' &&
      changes.every(
        (c) =>
          c.action !== 'delete' &&
          s.artifacts.some(
            (a) =>
              a.validity === 'current' &&
              a.relativePath === c.path &&
              a.sha256 === c.afterHash &&
              s.commission.acceptedArtifactIds.includes(a.id) &&
              s.evidence.some(
                (e) =>
                  e.kind === 'review' &&
                  e.status === 'passed' &&
                  e.artifactVersionIds.includes(a.versionId),
              ),
          ),
      )
    );
  }
  async prepare(snapshot: ProjectSnapshot): Promise<ApplyPreview> {
    const workspace = snapshot.workspace;
    try {
      const baseline = await readManifest(join(dirname(workspace.workPath), 'baseline.json'));
      const candidate = await scanWorkspaceManifest(workspace.workPath, workspace.id);
      const changes = manifestChanges(baseline, candidate);
      if (!workspace.sourcePath)
        return this.refused(workspace, '新建项目没有原目录，请导出到新目录。', changes);
      if (
        contained(this.options.dataRoot, workspace.sourcePath) ||
        contained(workspace.sourcePath, this.options.dataRoot)
      )
        return this.refused(workspace, '原目录不能与应用数据目录重叠。', changes);
      if (!this.eligible(snapshot, changes))
        return this.refused(
          workspace,
          '请先验收全部当前成果；未发布改动和未复核删除不能写回。',
          changes,
        );
      if (this.hasPending(workspace.id))
        return this.refused(workspace, '上次写回尚未核清，请先查看写回记录。', changes);
      if (!changes.length) return this.refused(workspace, '当前没有需要写回的更改。');
      if (changes.length > 512)
        return this.refused(workspace, '一次写回最多支持 512 个文件。', changes);
      if (
        process.platform !== 'win32' ||
        !(await stat(this.helperPath).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
        return this.refused(workspace, 'Windows 写回辅助程序不可用，请先构建桌面程序。', changes);
      const current = await scanWorkspaceManifest(workspace.sourcePath, workspace.id);
      const conflicts = changes
        .filter((c) => current.files[c.path] !== baseline.files[c.path])
        .map((c) => c.path);
      if (conflicts.length)
        return this.refused(
          workspace,
          '原文件已变化，请核对冲突后重新导入或调整成果。',
          changes,
          conflicts,
        );
      const operationId = randomUUID(),
        directory = join(this.options.dataRoot, 'apply-operations', operationId);
      await assertPlainPath(directory, true);
      await mkdir(join(directory, 'candidates'), { recursive: true });
      const files: Plan['files'] = [];
      let bytesTotal = 0;
      for (const [index, change] of changes.entries()) {
        const artifact = snapshot.artifacts.find(
          (a) =>
            a.validity === 'current' &&
            a.relativePath === change.path &&
            a.sha256 === change.afterHash,
        )!;
        const bytes = await readArtifact(this.options.dataRoot, artifact);
        bytesTotal += bytes.length;
        if (bytes.length > 32 * 1024 * 1024 || bytesTotal > 256 * 1024 * 1024)
          return this.refused(workspace, '写回文件超过支持的大小。', changes);
        const candidatePath = join(directory, 'candidates', `${index}.bin`);
        await writeFile(candidatePath, bytes, { flag: 'wx' });
        files.push({
          path: change.path,
          action: change.action as 'create' | 'modify',
          beforeHash: change.beforeHash ?? null,
          afterHash: change.afterHash!,
          candidatePath,
        });
        const before =
          change.action === 'modify'
            ? await readFile(join(workspace.sourcePath, change.path))
            : Buffer.alloc(0);
        if (change.action === 'modify' && hash(before) !== change.beforeHash)
          return this.refused(workspace, '原文件在预览期间变化，请重新准备。', changes, [
            change.path,
          ]);
        const binary =
          before.includes(0) ||
          bytes.includes(0) ||
          !/^text\/|^application\/(json|javascript|xml)/.test(artifact.mediaType);
        change.binary = binary;
        if (!binary) {
          change.beforeText = before.subarray(0, 8192).toString('utf8');
          change.afterText = bytes.subarray(0, 8192).toString('utf8');
          change.truncated = before.length > 8192 || bytes.length > 8192;
        }
      }
      const plan: Plan = {
        version: 1,
        operationId,
        workspace,
        commissionId: snapshot.commission.id,
        revision: snapshot.commission.revision,
        acceptedVersions: snapshot.artifacts
          .filter(
            (a) =>
              a.validity === 'current' && snapshot.commission.acceptedArtifactIds.includes(a.id),
          )
          .map((a) => a.versionId)
          .sort(),
        createdAt: now(),
        updatedAt: now(),
        expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
        baseline,
        candidate,
        changes,
        directory,
        files,
        status: 'prepared',
        message: '已准备当前验收版本，尚未写入原项目。',
      };
      this.save(plan);
      return {
        operationId,
        sourcePath: workspace.sourcePath,
        mode: 'apply',
        changes,
        conflicts: [],
        supported: true,
        expiresAt: plan.expiresAt,
      };
    } catch (error) {
      return this.refused(workspace, error instanceof Error ? error.message : '无法准备写回预览');
    }
  }
  private async updateBaseline(plan: Plan, restoring: boolean) {
    const file = join(dirname(plan.workspace.workPath), 'baseline.json');
    const baseline = await readManifest(file);
    if (baseline.workspaceId !== plan.workspace.id)
      throw new Error('Workspace baseline changed identity');
    for (const change of plan.changes) {
      const expected = restoring ? change.afterHash : change.beforeHash;
      const target = restoring ? change.beforeHash : change.afterHash;
      if (baseline.files[change.path] !== expected && baseline.files[change.path] !== target)
        throw new Error('Workspace baseline changed during writeback');
      if (target === undefined) delete baseline.files[change.path];
      else baseline.files[change.path] = target;
    }
    await assertPlainPath(file, true);
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(baseline, null, 2), { flag: 'wx' });
    await rename(temp, file);
  }
  async execute(previewId: string, snapshot: ProjectSnapshot): Promise<CommandResult> {
    let plan: Plan;
    const rollback = this.rollbackPreviews.get(previewId);
    try {
      plan = this.load(rollback?.planId ?? previewId);
    } catch (error) {
      return result(false, String(error), 'UNKNOWN_OPERATION');
    }
    if (snapshot.workspace.id !== plan.workspace.id || snapshot.commission.id !== plan.commissionId)
      return result(false, '写回记录不属于当前委托。', 'stale_apply');
    if (!rollback && plan.status === 'applied') return result(true, '该写回操作此前已完成。');
    if (rollback) {
      if (Date.now() > rollback.expires)
        return result(false, '恢复预览已过期，请重新核查。', 'expired_apply');
      if (this.hasLaterOperation(plan))
        return result(false, '存在更新的写回操作，请重新核查。', 'stale_apply');
      this.rollbackPreviews.delete(previewId);
      plan.status = 'rolling_back';
      plan.message = '正在恢复写回前的文件。';
      this.save(plan);
    } else {
      if (plan.status !== 'prepared')
        return result(false, '此操作需要先核查状态，不能重复写入。', 'recovery_required');
      if (
        Date.now() > Date.parse(plan.expiresAt) ||
        snapshot.commission.revision !== plan.revision ||
        !this.eligible(snapshot, plan.changes) ||
        !isDeepStrictEqual(
          plan.acceptedVersions,
          snapshot.artifacts
            .filter(
              (a) =>
                a.validity === 'current' && snapshot.commission.acceptedArtifactIds.includes(a.id),
            )
            .map((a) => a.versionId)
            .sort(),
        )
      )
        return result(false, '验收版本或预览已变化，请重新准备。', 'stale_apply');
      const baseline = await readManifest(join(dirname(plan.workspace.workPath), 'baseline.json'));
      const candidate = await scanWorkspaceManifest(plan.workspace.workPath, plan.workspace.id);
      if (
        !isDeepStrictEqual(baseline.files, plan.baseline.files) ||
        !isDeepStrictEqual(candidate.files, plan.candidate.files)
      )
        return result(false, '工作副本或写回基线已变化，请重新预览。', 'stale_apply');
      try {
        for (const change of plan.changes) {
          const artifact = snapshot.artifacts.find(
            (a) =>
              a.validity === 'current' &&
              a.relativePath === change.path &&
              a.sha256 === change.afterHash,
          )!;
          await readArtifact(this.options.dataRoot, artifact);
        }
      } catch {
        return result(false, '已验收成果的文件缺失或损坏，请重新核查。', 'invalid_artifact');
      }
      plan.status = 'applying';
      plan.message = '正在写回；结果未确认前请勿重复提交。';
      this.save(plan);
    }
    const native = this.validateNative(
      plan,
      await invokeWriteback(
        this.helperPath,
        rollback
          ? {
              version: 1,
              action: 'rollback',
              operationDirectory: plan.directory,
              inspectionToken: rollback.inspectionToken,
            }
          : {
              version: 1,
              action: 'apply',
              operationId: plan.operationId,
              operationDirectory: plan.directory,
              sourceRoot: plan.workspace.sourcePath,
              files: plan.files,
            },
      ),
      rollback ? 'rollback' : 'apply',
    );
    plan.native = native;
    try {
      if (native.status === 'applied' || native.status === 'rolled_back') {
        await this.updateBaseline(plan, native.status === 'rolled_back');
        plan.status = native.status;
        plan.message =
          native.status === 'applied'
            ? '已写回原项目，备份和逐文件记录已保存。'
            : '已恢复写回前的文件。';
      } else {
        plan.status =
          native.status === 'conflict' ||
          native.status === 'unsupported' ||
          native.status === 'not_started'
            ? 'conflict'
            : native.status === 'interrupted'
              ? 'interrupted'
              : 'unknown';
        plan.message = native.message || '写回尚未完成，请核查逐文件记录。';
      }
    } catch {
      plan.status = 'unknown';
      plan.message = '文件操作已发生，但工作区基线尚未确认，请核查恢复。';
    }
    this.save(plan);
    return result(
      plan.status === 'applied' || plan.status === 'rolled_back',
      plan.message,
      plan.status,
    );
  }
  async inspect(operationId: string): Promise<ApplyOperation> {
    return this.public(await this.inspectPlan(this.load(operationId)));
  }
  private async inspectPlan(plan: Plan): Promise<Plan> {
    const previous = plan.status;
    const native = this.validateNative(
      plan,
      await invokeWriteback(this.helperPath, {
        version: 1,
        action: 'inspect',
        operationDirectory: plan.directory,
      }),
      'inspect',
    );
    plan.native = native;
    if (native.status === 'applied' || native.status === 'rolled_back') {
      try {
        if (previous !== native.status)
          await this.updateBaseline(plan, native.status === 'rolled_back');
        plan.status = native.status;
        plan.message =
          native.status === 'applied'
            ? '记录与文件核对完成，写回已完成。'
            : '记录与文件核对完成，恢复已完成。';
      } catch {
        plan.status = 'unknown';
        plan.message = '源文件状态已知，但基线无法更新，请人工核查。';
      }
    } else if (
      (previous === 'applied' || previous === 'rolled_back') &&
      native.status === 'interrupted' &&
      native.files.length === plan.files.length &&
      native.conflicts.length
    ) {
      plan.message = native.message || '历史操作已完成，当前文件有后续变化。';
    } else {
      plan.status =
        native.status === 'not_started' ||
        native.status === 'conflict' ||
        native.status === 'unsupported'
          ? 'conflict'
          : native.status === 'interrupted'
            ? 'interrupted'
            : 'unknown';
      plan.message = native.message || '记录仍需要核查。';
    }
    this.save(plan);
    return plan;
  }
  async prepareRollback(operationId: string, snapshot: ProjectSnapshot): Promise<ApplyPreview> {
    const plan = this.load(operationId);
    if (plan.workspace.id !== snapshot.workspace.id || plan.commissionId !== snapshot.commission.id)
      return { ...this.refused(snapshot.workspace, '恢复记录不属于当前委托。'), mode: 'rollback' };
    if (this.hasLaterOperation(plan))
      return {
        ...this.refused(plan.workspace, '存在更新的写回操作，请先处理最新记录。'),
        mode: 'rollback',
      };
    const inspectedPlan = await this.inspectPlan(plan);
    const inspected = this.public(inspectedPlan);
    if (!inspected.canRollback || inspected.conflicts.length)
      return {
        ...this.refused(
          plan.workspace,
          '当前文件无法安全恢复；后续修改或未知字节将保留。',
          plan.changes,
          inspected.conflicts,
        ),
        mode: 'rollback',
      };
    const inspectionToken = inspectedPlan.native?.inspectionToken;
    if (!inspectionToken)
      return {
        ...this.refused(plan.workspace, '缺少绑定当前文件状态的恢复凭证，请重新核查。'),
        mode: 'rollback',
      };
    const previewId = randomUUID(),
      expires = Date.now() + 5 * 60000;
    this.rollbackPreviews.set(previewId, { planId: operationId, expires, inspectionToken });
    return {
      operationId: previewId,
      sourcePath: plan.workspace.sourcePath,
      mode: 'rollback',
      changes: plan.changes
        .filter((c) =>
          inspected.files.some(
            (file) => file.path === c.path && ['after', 'reserved'].includes(file.state),
          ),
        )
        .map((c) => ({
          ...c,
          action: c.action === 'create' ? 'delete' : 'modify',
          beforeHash:
            inspected.files.find((file) => file.path === c.path)?.currentHash ?? c.afterHash,
          afterHash: c.beforeHash,
          beforeText:
            inspected.files.find((file) => file.path === c.path)?.state === 'reserved'
              ? ''
              : c.afterText,
          afterText: c.beforeText,
        })),
      conflicts: [],
      supported: true,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  private hasLaterOperation(plan: Plan): boolean {
    const operations = this.options.store.applyOperations(plan.workspace.id);
    const index = operations.findIndex((row) => row.id === plan.operationId);
    return operations
      .slice(0, index)
      .some(
        (row) =>
          row.id !== plan.operationId &&
          ['applied', 'applying', 'rolling_back', 'interrupted', 'unknown'].includes(row.state),
      );
  }
  private validateNative(
    plan: Plan,
    value: unknown,
    phase: 'apply' | 'inspect' | 'rollback',
  ): NativeApplyResult {
    try {
      const native = validateWritebackReceipt(value);
      const complete =
        ['applied', 'rolled_back'].includes(native.status) ||
        native.canRollback ||
        (native.status === 'not_started' && native.files.length > 0);
      if (complete && native.files.length !== plan.files.length)
        throw new Error('Incomplete receipt');
      for (const file of native.files) {
        const expected = plan.files.find((item) => item.path === file.path);
        if (
          !expected ||
          file.action !== expected.action ||
          (file.beforeHash ?? null) !== expected.beforeHash ||
          file.afterHash !== expected.afterHash
        )
          throw new Error('Receipt differs from plan');
        if (file.state === 'before' && file.currentHash !== expected.beforeHash)
          throw new Error('Unverified original bytes');
        if (file.state === 'after' && file.currentHash !== expected.afterHash)
          throw new Error('Unverified candidate bytes');
        if (
          file.state === 'reserved' &&
          (expected.action !== 'create' || file.currentHash !== hash(Buffer.alloc(0)))
        )
          throw new Error('Invalid create reservation');
      }
      if (
        phase === 'apply' &&
        native.status === 'applied' &&
        native.files.some((file) => file.state !== 'after')
      )
        throw new Error('Incomplete application');
      if (
        phase === 'rollback' &&
        native.status === 'rolled_back' &&
        native.files.some((file) => file.state !== 'before')
      )
        throw new Error('Incomplete restoration');
      return native;
    } catch {
      return {
        ok: false,
        status: 'unknown',
        message: '原生回执与已确认计划不一致，请保留现场并核查。',
        files: [],
        conflicts: [],
        canRollback: false,
        inspectionToken: undefined,
      };
    }
  }
}
