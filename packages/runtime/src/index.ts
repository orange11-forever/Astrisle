import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  Artifact,
  ArtifactComparison,
  ArtifactComparisonInput,
  ArtifactPreview,
  ArtifactReworkInput,
  ApplyPreview,
  ApplyOperation,
  Bootstrap,
  Budget,
  CommandResult,
  NewWorkspaceInput,
  ProjectSnapshot,
  RuntimeOptions,
  Scope,
  SubmitInput,
  Task,
  Workspace,
} from '../../contracts/src/index';
import { RuntimeStore } from '../../persistence/src/index';
import { agents, invalidateLineage, ready, validatePlan } from '../../domain/src/index';
import { blobPath, hash, publishArtifact, readArtifact } from '../../artifacts/src/index';
import { compareArtifactVersions } from '../../artifacts/src/compare';
import { saveSourceExport } from './source-export';
import { findArtifactVersion } from '../../contracts/src/index';
import type { SourceExportInput } from '../../contracts/src/index';
import {
  createWorkspaceStorage,
  createTaskWorkspace,
  integrateTaskWorkspace,
  previewTaskWorkspaceChanges,
  exportWorkspace as exportWorkspaceStorage,
} from '../../workspace/src/index';
import { SafeApplyService } from '../../workspace/src/apply';
import { assertPlainPath } from '../../executor/src/path-guard';
import { complete, validateArguments, type Call, type Message } from './provider';
import { planTool, runtimeTools } from './tools';
import { buildTaskContinuation, summarizeTaskEvidence } from './task-context';
import { budgetExhausted, validBudget } from './budget';
import { RuntimeOwnership } from './ownership';
import {
  directedReworkOutputs,
  pathComparisonKey,
  previousTaskIds,
  previousTaskOutputs,
  scheduleArtifactRework,
} from './artifact-rework';
export interface RuntimeService {
  bootstrap(): Promise<Bootstrap>;
  createWorkspace(input: NewWorkspaceInput): Promise<Workspace>;
  submit(input: SubmitInput): Promise<CommandResult>;
  snapshot(id: string): Promise<ProjectSnapshot>;
  control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<CommandResult>;
  updateBudget(id: string, budget: Budget, expectedBudgetRevision: number): Promise<CommandResult>;
  answer(requestId: string, answer: string, approve?: boolean): Promise<CommandResult>;
  revise(id: string, instruction: string, expectedRevision: number): Promise<CommandResult>;
  requestArtifactRework(input: ArtifactReworkInput): Promise<CommandResult>;
  accept(id: string, artifactIds: string[]): Promise<CommandResult>;
  artifact(id: string): Promise<ArtifactPreview>;
  compareArtifacts(input: ArtifactComparisonInput): Promise<ArtifactComparison>;
  exportSourceArtifact(input: SourceExportInput, destination: string): Promise<CommandResult>;
  resolveArtifactPath(id: string): Promise<string>;
  exportWorkspace(id: string, destination: string): Promise<CommandResult>;
  prepareApply(id: string): Promise<ApplyPreview>;
  apply(operationId: string): Promise<CommandResult>;
  inspectApply(operationId: string): Promise<ApplyOperation>;
  prepareRollback(operationId: string): Promise<ApplyPreview>;
  resolveApplyDirectory(operationId: string): Promise<string>;
  subscribe(listener: (snapshot: ProjectSnapshot) => void): () => void;
  testProvider(): Promise<CommandResult>;
  close(): Promise<void>;
}
const now = () => new Date().toISOString();
function executionEnvironment(scope: Scope) {
  return {
    platform: process.platform,
    nodeExecutable: process.versions.electron ? undefined : process.execPath,
    allowProcess: scope.allowProcess,
    allowNetwork: scope.allowNetwork,
    note: 'Use only confirmed absolute executable paths. Do not guess paths from another OS. process_run accepts input as UTF-8 stdin. Tool permissions still apply.',
  };
}
function grantedTool(effect: string, scope: Scope) {
  return (
    (effect !== 'process' || scope.allowProcess) && (effect !== 'network' || scope.allowNetwork)
  );
}
const result = (ok: boolean, message: string, code?: string): CommandResult => ({
  ok,
  message,
  ...(code
    ? {
        code,
      }
    : {}),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function createRuntime(options: RuntimeOptions): RuntimeService {
  const runtime = new Runtime(options);
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const closingError = () =>
    Object.assign(new Error('工作运行时正在关闭，无法受理新操作'), { code: 'runtime_closing' });
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    return { promise, resolve, reject };
  }
  function command<A extends unknown[], T>(method: (...args: A) => Promise<T>) {
    return (...args: A): Promise<T> => {
      if (closing) return Promise.reject(closingError());
      const { promise, resolve, reject } = deferred<T>();
      // Register before invoking callbacks, which may synchronously initiate shutdown.
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      void method.apply(runtime, args).then(resolve, reject);
      return promise;
    };
  }
  return {
    bootstrap: command(runtime.bootstrap),
    createWorkspace: command(runtime.createWorkspace),
    submit: command(runtime.submit),
    snapshot: command(runtime.snapshot),
    control: command(runtime.control),
    updateBudget: command(runtime.updateBudget),
    answer: command(runtime.answer),
    revise: command(runtime.revise),
    requestArtifactRework: command(runtime.requestArtifactRework),
    accept: command(runtime.accept),
    artifact: command(runtime.artifact),
    compareArtifacts: command(runtime.compareArtifacts),
    exportSourceArtifact: command(runtime.exportSourceArtifact),
    resolveArtifactPath: command(runtime.resolveArtifactPath),
    exportWorkspace: command(runtime.exportWorkspace),
    prepareApply: command(runtime.prepareApply),
    apply: command(runtime.apply),
    inspectApply: command(runtime.inspectApply),
    prepareRollback: command(runtime.prepareRollback),
    resolveApplyDirectory: command(runtime.resolveApplyDirectory),
    testProvider: command(runtime.testProvider),
    subscribe: (listener) => {
      if (closing) throw closingError();
      return runtime.subscribe(listener);
    },
    close: () => {
      if (!closing) {
        const completion = deferred<void>();
        // Abort listeners can call close again before runtime.close returns its Promise.
        closing = completion.promise;
        void runtime.close([...pending]).then(completion.resolve, completion.reject);
      }
      return closing;
    },
  };
}
class OutcomeUnknownError extends Error {}
const interruptedTitle = 'Inspect interrupted task';
const artifactInspectionTools = new Set([
  'workspace_read',
  'inspect_delivery',
  // Saved evidence can refer to tools that are no longer offered for new calls.
  'office_inspect',
  'office_verify',
]);
type RenderedOutput = { path: string; sha256: string; sourceVersionId: string };

function renderedPublication(
  snapshot: ProjectSnapshot,
  taskId: string,
  workPath: string,
  outputPath: string,
): RenderedOutput | null | undefined {
  let attempted = false;
  for (const evidence of snapshot.evidence.slice().reverse()) {
    if (evidence.taskId !== taskId || evidence.kind !== 'tool') continue;
    try {
      const detail = JSON.parse(evidence.detail);
      if (
        detail?.name !== 'render_source' ||
        typeof detail.args?.output !== 'string' ||
        relative(workPath, resolve(workPath, detail.args.output)).replaceAll('\\', '/') !==
          outputPath
      )
        continue;
      attempted = true;
      if (evidence.status === 'passed' && detail.renderedOutput?.path === outputPath)
        return detail.renderedOutput;
    } catch {
      // Older tool evidence may contain only free text.
    }
  }
  return attempted ? null : undefined;
}
function pendingTaskRequest(snapshot: ProjectSnapshot, taskId: string) {
  const requests = snapshot.requests.filter((r) => r.taskId === taskId && r.status === 'open');
  return requests.find((r) => r.kind === 'approval') ?? requests[0];
}
function waitForTaskRequests(snapshot: ProjectSnapshot, task: Task): boolean {
  const request = pendingTaskRequest(snapshot, task.id);
  if (!request) return false;
  task.status = request.kind === 'approval' ? 'waiting_approval' : 'waiting_input';
  task.step = request.title;
  return true;
}
class Runtime implements RuntimeService {
  private waitingForAgent = new Set<string>();
  private store: RuntimeStore;
  private ownership: RuntimeOwnership;
  private listeners = new Set<(snapshot: ProjectSnapshot) => void>();
  private running = new Map<
    string,
    {
      commissionId: string;
      controller: AbortController;
      promise: Promise<void>;
    }
  >();
  private planning = new Set<string>();
  private writebacks: SafeApplyService;
  private writebackBusy = new Set<string>();
  private closing = false;
  private closed = false;
  private activeSince = new Map<string, number>();
  private budgetTimer: ReturnType<typeof setInterval>;
  constructor(private options: RuntimeOptions) {
    this.ownership = new RuntimeOwnership(options.dataRoot);
    let store: RuntimeStore | undefined;
    try {
      this.store = store = new RuntimeStore(options.dataRoot);
      this.store.beginRuntime();
      this.recover();
      this.writebacks = new SafeApplyService({
        dataRoot: options.dataRoot,
        store: this.store,
        helperPath: options.applyHelperPath,
      });
      this.budgetTimer = setInterval(() => this.checkpointBudgets(), 1000);
      this.budgetTimer.unref();
    } catch (error) {
      try {
        store?.close();
      } finally {
        this.ownership.release();
      }
      throw error;
    }
  }
  private recover(): void {
    const unknown = this.store.unknownCalls();
    for (const snapshot of this.store.projects()) {
      const calls = unknown.filter((call) => call.projectId === snapshot.commission.id);
      const uncertain = calls.filter(
        (call) => !['model', 'plan'].includes(call.request.kind ?? ''),
      );
      if (['accepted', 'cancelled'].includes(snapshot.commission.status)) continue;
      if (
        ['active', 'cancelling'].includes(snapshot.commission.status) ||
        calls.length ||
        snapshot.tasks.some((t) => t.status === 'running')
      ) {
        snapshot.commission.status = 'paused';
        snapshot.commission.summary =
          'Runtime restarted. Saved actions are available; inspect any unknown outcomes before resuming.';
        let changed = calls.some(
          (call) => call.state === 'running' || ['model', 'plan'].includes(call.request.kind ?? ''),
        );
        for (const task of snapshot.tasks) {
          const taskCalls = calls.filter((call) => call.taskId === task.id);
          const unresolved = uncertain.filter((call) => call.taskId === task.id);
          const legacyUnknown =
            task.status === 'running' &&
            !taskCalls.length &&
            !this.store.recentTaskCalls(snapshot.commission.id, task.id).length;
          if (unresolved.length || legacyUnknown) {
            if (task.status !== 'waiting_approval' || task.error !== 'outcome_unknown')
              changed = true;
            task.status = 'waiting_approval';
            task.error = 'outcome_unknown';
            task.step = 'Inspect previous tool output before resuming';
            if (
              !snapshot.requests.some(
                (r) => r.taskId === task.id && r.status === 'open' && r.title === interruptedTitle,
              )
            ) {
              changed = true;
              snapshot.requests.push({
                id: randomUUID(),
                commissionId: snapshot.commission.id,
                taskId: task.id,
                kind: 'approval',
                title: 'Inspect interrupted task',
                detail: `Previous execution outcome is unknown. Inspect calls ${unresolved.map((call) => `${call.id} (${call.request.name ?? 'unknown tool'})`).join(', ') || 'without a saved receipt'}, processes and files. Describe the observed state before approving continuation; old calls will not be replayed.`,
                status: 'open',
                createdAt: now(),
              });
            }
          } else if (task.status === 'running') {
            changed = true;
            task.status = 'queued';
            delete task.error;
            task.step = 'Ready to continue from saved actions';
            waitForTaskRequests(snapshot, task);
          }
        }
        for (const call of uncertain.filter(
          (call) => !snapshot.tasks.some((task) => task.id === call.taskId),
        )) {
          if (
            !snapshot.requests.some(
              (r) =>
                r.status === 'open' && r.title === interruptedTitle && r.taskId === call.taskId,
            )
          ) {
            changed = true;
            snapshot.requests.push({
              id: randomUUID(),
              commissionId: snapshot.commission.id,
              taskId: call.taskId,
              kind: 'approval',
              title: interruptedTitle,
              detail: `Inspect interrupted call ${call.id} before continuing.`,
              status: 'open',
              createdAt: now(),
            });
          }
        }
        const original = this.store.get(snapshot.commission.id);
        if (!changed && original.commission.status === 'paused') continue;
        this.event(
          snapshot,
          'recovery',
          'Paused after restart; no interrupted tool call was replayed',
        );
        this.store.transaction(() => {
          this.store.save(snapshot);
          for (const call of calls) {
            if (['model', 'plan'].includes(call.request.kind ?? ''))
              this.store.interruptCall(call.id, 'interrupted');
            else if (call.state === 'running') this.store.interruptCall(call.id, 'outcome_unknown');
          }
        });
      }
    }
  }
  private elapsed(s: ProjectSnapshot): number {
    const since = this.activeSince.get(s.commission.id);
    return (
      (s.commission.activeMilliseconds ?? 0) +
      (since === undefined ? 0 : Math.max(0, Date.now() - since))
    );
  }
  private settleTime(s: ProjectSnapshot): void {
    s.commission.activeMilliseconds = this.elapsed(s);
    if (this.activeSince.has(s.commission.id)) this.activeSince.set(s.commission.id, Date.now());
  }
  private syncClock(s: ProjectSnapshot): void {
    if (s.commission.status !== 'active') this.activeSince.delete(s.commission.id);
    else if (!this.activeSince.has(s.commission.id))
      this.activeSince.set(s.commission.id, Date.now());
  }
  private markBudgetPaused(s: ProjectSnapshot): void {
    s.commission.status = 'paused';
    s.commission.summary = 'Budget reached; adjust the total limits before continuing';
    this.event(s, 'budget_paused', 'Budget reached; no new model turns will start');
  }
  private checkpointBudgets(): void {
    if (this.closing || this.closed) return;
    for (const id of this.activeSince.keys()) {
      let paused = false;
      const s = this.store.transaction(() => {
        const s = this.store.get(id);
        this.settleTime(s);
        // Step limits are checked at request boundaries; a reserved final turn may finish.
        if (
          s.commission.status === 'active' &&
          s.commission.activeMilliseconds! >= s.commission.budget.maxMinutes * 60000 &&
          ![...this.running.values()].some((run) => run.commissionId === id)
        ) {
          this.markBudgetPaused(s);
          paused = true;
        }
        this.store.save(s);
        return s;
      });
      this.syncClock(s);
      if (paused) this.emit(s);
    }
  }
  private reserveStep(id: string, callId: string, taskId?: string): boolean {
    let reserved = false;
    const s = this.store.transaction(() => {
      const s = this.store.get(id);
      this.settleTime(s);
      if (s.commission.status === 'active') {
        if (!budgetExhausted(s.commission)) {
          this.store.startCall(callId, id, taskId, { kind: taskId ? 'model' : 'plan' });
          s.commission.stepsUsed++;
          this.event(
            s,
            'model_step',
            taskId ? 'Agent requested next action' : 'Requested a project plan',
          );
          reserved = true;
        }
      }
      this.store.save(s);
      return s;
    });
    this.syncClock(s);
    this.emit(s);
    return reserved;
  }
  private event(
    s: ProjectSnapshot,
    type: string,
    message: string,
    task?: Task,
    version?: string,
  ): void {
    s.lastSequence++;
    s.events.push({
      id: randomUUID(),
      commissionId: s.commission.id,
      sequence: s.lastSequence,
      type,
      message,
      taskId: task?.id,
      agentId: task?.agentId,
      artifactVersionId: version,
      createdAt: now(),
    });
    s.commission.updatedAt = now();
  }
  private emit(s: ProjectSnapshot): void {
    const applyOperations = this.writebacks?.list(s.workspace.id) ?? [];
    for (const listener of this.listeners)
      try {
        listener(structuredClone(applyOperations.length ? { ...s, applyOperations } : s));
      } catch {
        /* Listener failures never roll back committed state. */
      }
  }
  private change(
    id: string,
    type: string,
    message: string,
    mutate: (s: ProjectSnapshot) => void = () => {},
    metadata?: {
      taskId: string;
      artifactVersionId?: string;
    },
  ): ProjectSnapshot {
    const s = this.store.transaction(() => {
      const s = this.store.get(id);
      this.settleTime(s);
      mutate(s);
      this.event(
        s,
        type,
        message,
        metadata ? s.tasks.find((t) => t.id === metadata.taskId) : undefined,
        metadata?.artifactVersionId,
      );
      this.store.save(s);
      return s;
    });
    this.syncClock(s);
    this.emit(s);
    return s;
  }
  async bootstrap(): Promise<Bootstrap> {
    const p = await this.options.getCredentials();
    return {
      workspaces: this.store.workspaces(),
      commissions: this.store.projects().map((s) => s.commission),
      provider: {
        kind: p?.kind ?? 'openai-compatible',
        baseUrl: p?.baseUrl ?? '',
        model: p?.model ?? '',
        hasApiKey: !!p?.apiKey,
        configured: !!p?.model && !!p.baseUrl,
      },
      capabilities: await this.options.executor.capabilities(),
      version: '0.1.0-dev',
    };
  }
  async createWorkspace(input: NewWorkspaceInput): Promise<Workspace> {
    if (!input.name?.trim()) throw new Error('Workspace name is required');
    const workspace = await createWorkspaceStorage(input, this.options.dataRoot);
    this.store.addWorkspace(workspace);
    return workspace;
  }
  async exportWorkspace(id: string, destination: string): Promise<CommandResult> {
    await exportWorkspaceStorage(this.store.get(id).workspace, destination);
    return result(true, '项目候选版本已导出到新目录');
  }
  async exportSourceArtifact(
    input: SourceExportInput,
    destination: string,
  ): Promise<CommandResult> {
    const snapshot = this.store.get(input.commissionId);
    const source = findArtifactVersion(snapshot, input.versionId);
    return saveSourceExport(
      this.options.dataRoot,
      this.options.executor,
      source,
      input.format,
      destination,
      this.store.workspaces(),
    );
  }
  async prepareApply(id: string): Promise<ApplyPreview> {
    const snapshot = this.store.get(id);
    if (
      this.writebackBusy.has(snapshot.workspace.id) ||
      (snapshot.commission.status === 'accepted' && this.store.busy(snapshot.workspace.id))
    )
      return {
        operationId: randomUUID(),
        sourcePath: snapshot.workspace.sourcePath,
        changes: [],
        conflicts: [],
        supported: false,
        reason: '该工作区仍有写入活动，请等待结束后再预览。',
      };
    return this.writebacks.prepare(snapshot);
  }
  async apply(operationId: string): Promise<CommandResult> {
    let binding: ReturnType<SafeApplyService['binding']>;
    try {
      binding = this.writebacks.binding(operationId);
    } catch {
      return result(false, '写回预览不存在或已过期，请重新准备。', 'unknown_apply');
    }
    if (this.writebackBusy.has(binding.workspaceId) || this.store.busy(binding.workspaceId))
      return result(false, '工作区仍有写入活动，不能同时写回。', 'writeback_busy');
    if (
      this.writebacks
        .list(binding.workspaceId)
        .some(
          (op) =>
            op.operationId !== binding.operationId &&
            !['prepared', 'applied', 'rolled_back', 'conflict'].includes(op.status),
        )
    )
      return result(false, '工作区有其他待核查写回，请先处理。', 'writeback_pending');
    this.writebackBusy.add(binding.workspaceId);
    try {
      const response = await this.writebacks.execute(
        operationId,
        this.store.get(binding.commissionId),
      );
      this.change(binding.commissionId, 'writeback_result', response.message);
      return response;
    } finally {
      this.writebackBusy.delete(binding.workspaceId);
    }
  }
  async inspectApply(operationId: string): Promise<ApplyOperation> {
    const binding = this.writebacks.binding(operationId);
    if (this.writebackBusy.has(binding.workspaceId) || this.store.busy(binding.workspaceId))
      throw new Error('工作区仍有写入活动，请稍后核查。');
    this.writebackBusy.add(binding.workspaceId);
    try {
      const operation = await this.writebacks.inspect(operationId);
      this.change(binding.commissionId, 'writeback_inspected', operation.message);
      return operation;
    } finally {
      this.writebackBusy.delete(binding.workspaceId);
    }
  }
  async prepareRollback(operationId: string): Promise<ApplyPreview> {
    const binding = this.writebacks.binding(operationId),
      snapshot = this.store.get(binding.commissionId);
    if (this.writebackBusy.has(binding.workspaceId) || this.store.busy(binding.workspaceId))
      return {
        operationId: randomUUID(),
        sourcePath: snapshot.workspace.sourcePath,
        changes: [],
        conflicts: [],
        supported: false,
        reason: '工作区仍有写入活动，请稍后恢复。',
        mode: 'rollback',
      };
    this.writebackBusy.add(binding.workspaceId);
    try {
      return await this.writebacks.prepareRollback(operationId, snapshot);
    } finally {
      this.writebackBusy.delete(binding.workspaceId);
    }
  }
  private writebackBlock(workspaceId: string): CommandResult | undefined {
    if (this.writebackBusy.has(workspaceId))
      return result(false, '原项目写回或核查正在进行，请稍后继续。', 'writeback_busy');
    if (this.writebacks.hasPending(workspaceId))
      return result(false, '上次写回结果尚未核清，请先查看写回记录。', 'writeback_pending');
  }
  async resolveApplyDirectory(operationId: string): Promise<string> {
    return this.writebacks.resolveDirectory(operationId);
  }
  async submit(input: SubmitInput): Promise<CommandResult> {
    if (this.closing) return result(false, 'Runtime is closing', 'closing');
    const payload = canonical(input);
    const receipt = this.store.receipt(input.requestId);
    if (receipt)
      return receipt.payload === payload
        ? receipt.result
        : result(false, 'Request ID already has a different payload', 'request_conflict');
    const applyBlock = this.writebackBlock(input.workspaceId);
    if (applyBlock) return applyBlock;
    const workspace = this.store.workspaces().find((w) => w.id === input.workspaceId);
    if (!workspace) return result(false, 'Workspace not found', 'workspace_not_found');
    if (
      !input.requestId ||
      !input.goal?.trim() ||
      !Array.isArray(input.criteria) ||
      !input.criteria.length ||
      input.criteria.some((c) => !c.trim()) ||
      !validBudget(input.budget)
    )
      return result(false, 'Goal, criteria and a positive budget are required', 'invalid_input');
    if (this.store.busy(workspace.id))
      return result(false, 'A writable commission already owns this workspace', 'workspace_busy');
    const id = randomUUID(),
      time = now();
    const snapshot: ProjectSnapshot = {
      workspace,
      agents: structuredClone(agents),
      commission: {
        id,
        workspaceId: workspace.id,
        title: input.goal.slice(0, 80),
        goal: input.goal,
        status: 'active',
        criteria: input.criteria.map((description, i) => ({
          id: `c${i + 1}`,
          description,
        })),
        scope: structuredClone(input.scope),
        budget: structuredClone(input.budget),
        revision: 1,
        planningMode: input.planningMode,
        stepsUsed: 0,
        activeMilliseconds: 0,
        budgetRevision: 0,
        createdAt: time,
        updatedAt: time,
        acceptedArtifactIds: [],
        summary: 'Planning the commission',
      },
      tasks: [],
      artifacts: [],
      evidence: [],
      events: [],
      requests: [],
      lastSequence: 0,
    };
    const answer: CommandResult = {
      ok: true,
      message: 'Commission created',
      commissionId: id,
      requestId: input.requestId,
    };
    this.event(snapshot, 'commission_created', 'Commission created');
    this.store.transaction(() => {
      this.store.save(snapshot);
      this.store.addReceipt(input.requestId, payload, answer);
    });
    this.syncClock(snapshot);
    this.emit(snapshot);
    this.kick(id);
    return answer;
  }
  async snapshot(id: string): Promise<ProjectSnapshot> {
    const s = this.store.get(id);
    if (this.activeSince.has(id)) s.commission.activeMilliseconds = this.elapsed(s);
    const operations = this.writebacks.list(s.workspace.id);
    if (operations.length) s.applyOperations = operations;
    return s;
  }
  subscribe(listener: (snapshot: ProjectSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<CommandResult> {
    if (this.closing) return result(false, 'Runtime is closing', 'closing');
    const current = this.store.get(id);
    const applyBlock = action === 'resume' ? this.writebackBlock(current.workspace.id) : undefined;
    if (applyBlock) return applyBlock;
    if (['accepted', 'cancelled'].includes(current.commission.status))
      return result(false, 'Commission is terminal', 'terminal');
    if (
      action !== 'pause' &&
      current.requests.some((r) => r.status === 'open' && r.title === interruptedTitle)
    )
      return result(
        false,
        'Resolve the unknown tool outcome before resuming or confirming cancellation',
        'outcome_unknown',
      );
    if (action === 'resume') {
      if (current.requests.some((r) => r.status === 'open' && r.title === 'Review proposed plan'))
        return result(
          false,
          'Review and approve the proposed plan before continuing',
          'approval_required',
        );
      if (budgetExhausted(current.commission, this.elapsed(current)))
        return result(false, '预算已用尽，请先调整总额度再继续', 'budget_exhausted');
      if (current.commission.status === 'cancelling')
        return result(false, 'Wait for cancellation to finish', 'task_running');
    }
    const active = [...this.running.values()].filter((r) => r.commissionId === id);
    this.change(id, `commission_${action}`, `User requested ${action}`, (s) => {
      s.commission.status =
        action === 'pause'
          ? 'paused'
          : action === 'resume'
            ? 'active'
            : active.length
              ? 'cancelling'
              : 'cancelled';
      if (action === 'cancel')
        for (const t of s.tasks)
          if (t.status !== 'running' && t.status !== 'passed') t.status = 'cancelled';
      if (action === 'resume') s.commission.summary = 'Continuing work';
    });
    if (action !== 'resume') for (const run of active) run.controller.abort(new Error(action));
    else {
      this.kick(id);
    }
    return result(
      true,
      action === 'cancel' && active.length
        ? 'Cancellation requested; waiting for active calls to stop'
        : `Commission ${action}`,
    );
  }
  async updateBudget(
    id: string,
    budget: Budget,
    expectedBudgetRevision: number,
  ): Promise<CommandResult> {
    if (this.closing) return result(false, 'Runtime is closing', 'closing');
    if (
      !validBudget(budget) ||
      !Number.isSafeInteger(expectedBudgetRevision) ||
      expectedBudgetRevision < 0
    )
      return result(false, '预算范围：1–10000 步、1–1440 分钟、0–20 轮返工', 'invalid_input');
    let committed: ProjectSnapshot | undefined;
    const response = this.store.transaction(() => {
      const s = this.store.get(id);
      if (['accepted', 'cancelled', 'failed'].includes(s.commission.status))
        return result(false, '委托已结束', 'terminal');
      if (s.commission.status !== 'paused')
        return result(false, '请先暂停委托再调整预算', 'pause_required');
      if ([...this.running.values()].some((r) => r.commissionId === id))
        return result(false, '请等待当前动作完成后再调整预算', 'task_running');
      if ((s.commission.budgetRevision ?? 0) !== expectedBudgetRevision)
        return result(false, '预算已更新，请重新打开编辑', 'stale_revision');
      if (
        budget.maxSteps < s.commission.stepsUsed ||
        budget.maxMinutes * 60000 < (s.commission.activeMilliseconds ?? 0) ||
        budget.maxRework < s.events.filter((e) => e.type === 'rework_created').length
      )
        return result(false, '总额度不能小于已使用量', 'budget_below_usage');
      s.commission.budget = structuredClone(budget);
      s.commission.budgetRevision = expectedBudgetRevision + 1;
      if (budget.maxRework > s.events.filter((e) => e.type === 'rework_created').length) {
        for (const task of s.tasks) {
          if (task.status === 'failed' && task.error === 'rework_budget_exhausted') {
            task.status = 'queued';
            task.step = 'Revisit the saved review with the updated rework limit';
            delete task.error;
            waitForTaskRequests(s, task);
          }
        }
      }
      this.event(
        s,
        'budget_updated',
        `Total limits updated: ${budget.maxSteps} steps, ${budget.maxMinutes} minutes, ${budget.maxRework} reworks`,
      );
      this.store.save(s);
      committed = s;
      return result(true, '预算已保存；点击“继续”恢复任务');
    });
    if (committed) this.emit(committed);
    return response;
  }
  async answer(requestId: string, answer: string, approve?: boolean): Promise<CommandResult> {
    const snapshot = this.store.projects().find((s) => s.requests.some((r) => r.id === requestId));
    if (!snapshot) return result(false, 'Request not found', 'not_found');
    const request = snapshot.requests.find((r) => r.id === requestId)!;
    if (request.status !== 'open')
      return result(false, 'Request already answered', 'already_answered');
    if (request.title === interruptedTitle && (approve !== true || !answer.trim()))
      return result(
        false,
        'The outcome stays unresolved until you explicitly confirm reconciliation and describe the observed state',
        'outcome_unknown',
      );
    this.change(snapshot.commission.id, 'request_answered', 'User answered a request', (s) => {
      const r = s.requests.find((r) => r.id === requestId)!;
      r.answer = answer;
      r.status = r.kind === 'approval' && approve !== true ? 'rejected' : 'answered';
      if (r.title === interruptedTitle)
        this.store.reconcileCalls(snapshot.commission.id, r.taskId, answer);
      const t = s.tasks.find((t) => t.id === r.taskId);
      if (t) {
        t.status = 'queued';
        t.step =
          r.status === 'rejected'
            ? 'Approval rejected; find an alternative'
            : 'User input received';
        if (r.title === interruptedTitle) delete t.error;
        waitForTaskRequests(s, t);
      }
      if (r.title === 'Review proposed plan' && approve === true) s.commission.status = 'active';
    });
    this.kick(snapshot.commission.id);
    return result(true, 'Answer recorded');
  }
  async revise(id: string, instruction: string, expectedRevision: number): Promise<CommandResult> {
    const s = this.store.get(id);
    const applyBlock = this.writebackBlock(s.workspace.id);
    if (applyBlock) return applyBlock;
    if (s.requests.some((r) => r.status === 'open' && r.title === interruptedTitle))
      return result(false, 'Resolve unknown tool outcomes before revising work', 'outcome_unknown');
    if (s.commission.revision !== expectedRevision)
      return result(false, 'Commission revision changed', 'stale_revision');
    if (!instruction.trim()) return result(false, 'Revision instruction required', 'invalid_input');
    if ([...this.running.values()].some((r) => r.commissionId === id))
      return result(
        false,
        'Pause and wait for current calls to stop before revising',
        'task_running',
      );
    if (['accepted', 'cancelled'].includes(s.commission.status) && this.store.busy(s.workspace.id))
      return result(false, 'Another commission owns this workspace', 'workspace_busy');
    this.change(id, 'requirements_revised', instruction, (s) => {
      s.commission.goal += `\nRevision ${s.commission.revision + 1}: ${instruction}`;
      s.commission.revision++;
      s.commission.status = 'active';
      invalidateLineage(
        s,
        s.artifacts.map((a) => a.versionId),
      );
      for (const t of s.tasks) if (t.status !== 'cancelled') t.status = 'cancelled';
      s.commission.acceptedArtifactIds = [];
      s.commission.summary = 'Replanning revised requirements';
    });
    this.kick(id);
    return result(true, 'Requirements revised');
  }
  async requestArtifactRework(input: ArtifactReworkInput): Promise<CommandResult> {
    if (
      !input ||
      typeof input.commissionId !== 'string' ||
      !input.commissionId.trim() ||
      typeof input.artifactId !== 'string' ||
      !input.artifactId.trim() ||
      typeof input.versionId !== 'string' ||
      !input.versionId.trim() ||
      typeof input.requestId !== 'string' ||
      !input.requestId.trim() ||
      input.requestId.length > 200 ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      typeof input.instruction !== 'string' ||
      !input.instruction.trim() ||
      input.instruction.trim().length > 4000
    )
      return result(
        false,
        'A current version and a rework instruction of up to 4000 characters are required',
        'invalid_input',
      );
    input = { ...input, instruction: input.instruction.trim() };
    const payload = canonical({ ...input, type: 'artifact_rework' });
    const receipt = () => {
      const saved = this.store.receipt(input.requestId);
      if (saved)
        return saved.payload === payload
          ? saved.result
          : result(false, 'Request ID already has a different payload', 'request_conflict');
    };
    const existing = receipt();
    if (existing) return existing;
    const initial = this.store.findProject(input.commissionId);
    if (!initial) return result(false, 'Commission not found', 'not_found');
    const candidate = this.artifactReworkCandidate(initial, input);
    if ('ok' in candidate) return candidate;
    try {
      await readArtifact(this.options.dataRoot, candidate);
    } catch {
      return receipt() ?? result(false, 'Artifact file missing or corrupted', 'invalid_artifact');
    }
    let committed: ProjectSnapshot | undefined;
    const response = this.store.transaction(() => {
      const existing = receipt();
      if (existing) return existing;
      const snapshot = this.store.get(input.commissionId);
      const target = this.artifactReworkCandidate(snapshot, input);
      if ('ok' in target) return target;
      if (target.sha256 !== candidate.sha256)
        return result(false, 'Artifact bytes changed during rework validation', 'stale_version');
      const author = snapshot.tasks.find((task) => task.id === target.taskId)!;
      const reviewer = agents.find((agent) => agent.id !== author.agentId)!;
      const schedule = scheduleArtifactRework(
        snapshot,
        target,
        author,
        reviewer.id,
        input.instruction,
        input.requestId,
        now(),
      );
      if ('code' in schedule) {
        if (schedule.code === 'path_conflict')
          return result(
            false,
            `Another current artifact already owns ${schedule.path}`,
            schedule.code,
          );
        return result(
          false,
          'Resolve open requests on affected tasks before reworking',
          schedule.code,
        );
      }
      const rework = schedule.task;
      const paused = snapshot.commission.status === 'paused';
      snapshot.commission.status = paused ? 'paused' : 'active';
      snapshot.commission.summary = paused
        ? 'Artifact rework queued; resume to start work'
        : 'Reworking the selected artifact version';
      this.event(
        snapshot,
        'rework_created',
        `Linked ${rework.id} to ${author.id}`,
        rework,
        target.versionId,
      );
      const success = {
        ...result(true, 'Artifact rework scheduled'),
        commissionId: input.commissionId,
        requestId: input.requestId,
      };
      this.store.save(snapshot);
      this.store.addReceipt(input.requestId, payload, success);
      committed = snapshot;
      return success;
    });
    if (committed) {
      this.syncClock(committed);
      this.emit(committed);
      this.kick(input.commissionId);
    }
    return response;
  }
  private artifactReworkCandidate(
    s: ProjectSnapshot,
    input: ArtifactReworkInput,
  ): Artifact | CommandResult {
    if (this.closing) return result(false, 'Runtime is closing', 'closing');
    if (s.commission.revision !== input.revision)
      return result(false, 'Commission revision changed', 'stale_revision');
    const artifact = s.artifacts.find((a) => a.id === input.artifactId);
    if (artifact?.versionId !== input.versionId || artifact.validity !== 'current')
      return result(false, 'The selected artifact version is no longer current', 'stale_version');
    if (s.commission.acceptedArtifactIds.includes(artifact.id))
      return result(false, 'The selected artifact has already been accepted', 'artifact_accepted');
    if (['accepted', 'cancelled', 'failed'].includes(s.commission.status))
      return result(false, 'Commission is terminal', 'terminal');
    if (artifact.renderedFromVersionId) {
      const source = s.artifacts.find((a) => a.versionId === artifact.renderedFromVersionId);
      return result(
        false,
        `Request content changes on the editable source${source ? ` ${source.relativePath}` : ''} so the native deliverable can be regenerated`,
        'source_rework_required',
      );
    }
    if (s.requests.some((r) => r.status === 'open' && r.title === interruptedTitle))
      return result(
        false,
        'Resolve unknown tool outcomes before requesting rework',
        'outcome_unknown',
      );
    if (s.requests.some((r) => r.status === 'open' && r.kind === 'approval'))
      return result(false, 'Resolve open approvals before requesting rework', 'approval_required');
    if (
      !['paused', 'awaiting_acceptance'].includes(s.commission.status) ||
      [...this.running.values()].some((r) => r.commissionId === s.commission.id)
    )
      return result(
        false,
        'Pause and wait for current calls to stop before requesting rework',
        'task_running',
      );
    const applyBlock = this.writebackBlock(s.workspace.id);
    if (applyBlock) return applyBlock;
    const author = s.tasks.find((t) => t.id === artifact.taskId);
    if (
      !author ||
      !['awaiting_review', 'passed'].includes(author.status) ||
      author.kind === 'review'
    )
      return result(
        false,
        'The producing task must finish publishing before rework',
        'invalid_artifact',
      );
    if (budgetExhausted(s.commission, this.elapsed(s)))
      return result(
        false,
        'Increase the step or time budget before requesting rework',
        'budget_exhausted',
      );
    if (s.events.filter((e) => e.type === 'rework_created').length >= s.commission.budget.maxRework)
      return result(
        false,
        'Increase the rework limit before requesting rework',
        'rework_budget_exhausted',
      );
    return artifact;
  }
  async accept(id: string, artifactIds: string[]): Promise<CommandResult> {
    const s = this.store.get(id);
    if (
      !artifactIds.length ||
      artifactIds.some((id) => !s.artifacts.some((a) => a.id === id && a.validity === 'current'))
    )
      return result(false, 'Select current artifacts', 'invalid_artifact');
    for (const id of artifactIds) {
      const a = s.artifacts.find((a) => a.id === id)!;
      try {
        await readArtifact(this.options.dataRoot, a);
      } catch {
        return result(false, 'Artifact file missing or corrupted', 'invalid_artifact');
      }
    }
    const reviewed = artifactIds.every((id) => {
      const artifact = s.artifacts.find((a) => a.id === id)!;
      return s.evidence.some(
        (e) =>
          e.kind === 'review' &&
          e.status === 'passed' &&
          e.artifactVersionIds.includes(artifact.versionId),
      );
    });
    if (!reviewed)
      return result(false, 'Selected versions require independent verification', 'unverified');
    let committed: ProjectSnapshot | undefined;
    const response = this.store.transaction(() => {
      // Revalidation and acceptance share the same SQLite write lock.
      const latest = this.store.get(id);
      if (latest.commission.revision !== s.commission.revision)
        return result(
          false,
          'Commission revision changed while artifact files were verified',
          'stale_revision',
        );
      if (
        artifactIds.some((id) => {
          const before = s.artifacts.find((a) => a.id === id)!;
          return !latest.artifacts.some(
            (a) =>
              a.id === id &&
              a.versionId === before.versionId &&
              a.sha256 === before.sha256 &&
              a.validity === 'current',
          );
        })
      )
        return result(false, 'Artifact versions changed during acceptance', 'invalid_artifact');
      if (
        !artifactIds.every((id) =>
          latest.evidence.some(
            (e) =>
              e.kind === 'review' &&
              e.status === 'passed' &&
              e.artifactVersionIds.includes(latest.artifacts.find((a) => a.id === id)!.versionId),
          ),
        )
      )
        return result(
          false,
          'Current selected versions require independent verification',
          'unverified',
        );
      latest.commission.acceptedArtifactIds = [
        ...new Set([...latest.commission.acceptedArtifactIds, ...artifactIds]),
      ];
      if (
        latest.commission.status === 'awaiting_acceptance' &&
        latest.artifacts
          .filter((a) => a.validity === 'current')
          .every((a) => latest.commission.acceptedArtifactIds.includes(a.id))
      )
        latest.commission.status = 'accepted';
      this.event(latest, 'artifacts_accepted', 'User accepted selected artifact versions');
      this.store.save(latest);
      committed = latest;
      return result(true, 'Artifacts accepted');
    });
    if (committed) this.emit(committed);
    return response;
  }
  private findArtifact(id: string) {
    for (const s of this.store.projects()) {
      const a = s.artifacts.find((a) => a.id === id);
      if (a) return a;
    }
    throw new Error('Artifact not found');
  }
  async resolveArtifactPath(id: string): Promise<string> {
    const a = this.findArtifact(id);
    await readArtifact(this.options.dataRoot, a);
    return blobPath(this.options.dataRoot, a.sha256);
  }
  async artifact(id: string): Promise<ArtifactPreview> {
    const artifact = this.findArtifact(id);
    const bytes = await readArtifact(this.options.dataRoot, artifact);
    const text =
      /^(text\/|application\/(json|javascript|xml))/.test(artifact.mediaType) ||
      /\.(md|markdown|txt|json|ts|tsx|js|py|css|html|csv|tsv)$/i.test(artifact.relativePath);
    return {
      artifact,
      format: text ? 'text' : 'binary',
      ...(text
        ? {
            content:
              bytes.subarray(0, 131072).toString('utf8') +
              (bytes.length > 131072 ? '\n[Preview truncated]' : ''),
          }
        : {}),
    };
  }
  async compareArtifacts(input: ArtifactComparisonInput): Promise<ArtifactComparison> {
    if (
      !input ||
      typeof input.commissionId !== 'string' ||
      !input.commissionId ||
      typeof input.fromVersionId !== 'string' ||
      !input.fromVersionId ||
      typeof input.toVersionId !== 'string' ||
      !input.toVersionId
    )
      throw new Error('A commission and two artifact versions are required');
    return compareArtifactVersions(
      this.options.dataRoot,
      this.store.get(input.commissionId),
      input,
    );
  }
  async testProvider(): Promise<CommandResult> {
    const settings = await this.options.getCredentials();
    if (!settings) return result(false, 'Configure a provider first', 'provider_missing');
    try {
      await complete(
        settings,
        [
          {
            role: 'user',
            content: 'Reply OK.',
          },
        ],
        [],
        new AbortController().signal,
      );
      return result(true, 'Provider responded successfully');
    } catch (e) {
      return result(false, this.safeError(e), 'provider_error');
    }
  }
  private safeError(e: unknown): string {
    return e instanceof Error ? e.message.slice(0, 1000) : 'Operation failed';
  }
  private kick(id: string): void {
    if (this.closing) return;
    queueMicrotask(() => {
      if (this.closing || this.closed) return;
      this.waitingForAgent.delete(id);
      let s = this.store.get(id);
      if (s.commission.status !== 'active') return;
      if (
        s.tasks.some(
          (t) => ['queued', 'waiting_dependency'].includes(t.status) && pendingTaskRequest(s, t.id),
        )
      ) {
        this.change(id, 'task_waiting', 'Unanswered user requests still block their tasks', (s) => {
          for (const task of s.tasks)
            if (['queued', 'waiting_dependency'].includes(task.status))
              waitForTaskRequests(s, task);
        });
        s = this.store.get(id);
      }
      const finished = s.tasks.filter((t) => !['cancelled', 'rework_required'].includes(t.status));
      if (
        finished.length &&
        finished.every((t) => t.status === 'passed') &&
        ![...this.running.values()].some((r) => r.commissionId === id)
      ) {
        const current = s.artifacts.filter((artifact) => artifact.validity === 'current');
        const accepted =
          current.length > 0 &&
          current.every((a) => s.commission.acceptedArtifactIds.includes(a.id));
        this.change(
          id,
          'delivery_ready',
          accepted
            ? 'All current artifact versions were independently reviewed and accepted'
            : 'All tasks independently verified; awaiting user acceptance',
          (s) => {
            s.commission.status = accepted ? 'accepted' : 'awaiting_acceptance';
            s.commission.summary = accepted
              ? 'All current versions are accepted'
              : 'Verified results are ready for acceptance';
          },
        );
        return;
      }
      if (budgetExhausted(s.commission, this.elapsed(s))) {
        // Let already reserved work persist its outputs before pausing at the boundary.
        if ([...this.running.values()].some((r) => r.commissionId === id)) return;
        this.change(id, 'budget_paused', 'Step or time budget reached', (s) => {
          s.commission.status = 'paused';
          s.commission.summary = 'Budget reached; review and revise the budget before continuing';
        });
        return;
      }
      if (!s.tasks.some((t) => t.status !== 'cancelled')) {
        if (!this.planning.has(id)) this.startPlan(id);
        return;
      }
      for (const agent of agents) {
        const task = s.tasks.find((t) => t.agentId === agent.id && ready(t, s));
        if (!task) continue;
        if (this.running.has(agent.id)) this.waitingForAgent.add(id);
        else this.startTask(id, task.id, agent.id);
      }
    });
  }
  private launch(key: string, id: string, run: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    const promise = run(controller.signal)
      .catch((e) => {
        if (!this.closed && !controller.signal.aborted)
          this.change(id, 'runtime_error', this.safeError(e), (s) => {
            s.commission.status = 'paused';
            s.commission.summary = this.safeError(e);
          });
      })
      .finally(() => {
        this.running.delete(key);
        if (this.closed) return;
        const s = this.store.get(id);
        if (
          s.commission.status === 'cancelling' &&
          ![...this.running.values()].some((r) => r.commissionId === id)
        )
          this.change(id, 'commission_cancelled', 'All active calls stopped', (s) => {
            s.commission.status = 'cancelled';
            for (const t of s.tasks) if (t.status !== 'passed') t.status = 'cancelled';
          });
        if (!key.startsWith('plan:')) {
          for (const waiting of this.waitingForAgent) if (waiting !== id) this.kick(waiting);
        }
        this.kick(id);
      });
    this.running.set(key, {
      commissionId: id,
      controller,
      promise,
    });
  }
  private startPlan(id: string): void {
    this.planning.add(id);
    this.launch(`plan:${id}`, id, async (signal) => {
      try {
        const settings = await this.options.getCredentials();
        if (!settings) {
          this.change(
            id,
            'provider_required',
            'Provider credentials are required to plan real work',
            (s) => {
              s.commission.status = 'paused';
              s.commission.summary = 'Configure a model provider and resume';
            },
          );
          return;
        }
        const s = this.store.get(id);
        const messages: Message[] = [
          {
            role: 'system',
            content:
              'You plan real project work, never a fixed demonstration. You must call propose_plan, not write a prose plan. Produce a DAG of 2+ tasks across mori and luma. Task kind must be investigate, implement, review, or integrate; author is a role, not a task kind. Every author, including investigate, must publish actual files and have a different reviewer DIRECTLY depending on that author and covering its criteria. Transitive dependency alone does not review preparatory outputs. Review tasks are read-only and finish with submit_review; never assign them report-file creation. Review dependencies use artifact_available. An author can consume a predecessor via artifact_available, or via task_passed after a separate earlier review; do not create a review-wait deadlock. Use only registered capabilities. Write reviewable Markdown, CSV or TSV sources for document and data work when appropriate. For a requested native document, publish the source first, then render the published source with render_source and publish the native output. This can be one author task, or a downstream renderer task with the published source as a dependency. Review both files. If only the source is requested, publish the source. Keep the graph as small as the goal permits. Parallel author tasks must own disjoint output paths; specify each task scope clearly.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              goal: s.commission.goal,
              criteria: s.commission.criteria,
              tools: this.options.executor
                .definitions()
                .filter((d) => grantedTool(d.effect, s.commission.scope)),
              environment: executionEnvironment(s.commission.scope),
              capabilities: await this.options.executor.capabilities(),
              workspace: s.workspace,
              budget: s.commission.budget,
            }),
          },
        ];
        let plan: ReturnType<typeof validatePlan> | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          const runId = randomUUID();
          if (!this.reserveStep(id, runId)) return;
          let response;
          try {
            response = await complete(settings, messages, [planTool], signal);
          } catch (error) {
            this.store.endCall(runId, { ok: false, error: this.safeError(error) });
            throw error;
          }
          try {
            signal.throwIfAborted();
            const proposal = response.calls.find((call) => call.name === 'propose_plan');
            if (!proposal) throw new Error('Provider did not return a structured plan');
            validateArguments(proposal.args, planTool.parameters);
            plan = validatePlan(proposal.args.tasks, s.commission.criteria);
            this.store.endCall(runId, { ok: true });
            break;
          } catch (error) {
            const detail = this.safeError(error);
            this.store.endCall(runId, { ok: false, error: detail });
            if (signal.aborted || attempt === 2) throw error;
            this.change(id, 'plan_rejected', `Plan needs correction: ${detail}`, () => {});
            messages.push({
              role: 'assistant',
              content: response.text,
              calls: response.calls,
              native: response.native,
            });
            for (const call of response.calls)
              messages.push({
                role: 'tool',
                callId: call.id,
                name: call.name,
                content: JSON.stringify({ ok: false, error: detail }),
              });
            messages.push({
              role: 'user',
              content: `The plan was rejected: ${detail}. Correct it and call propose_plan with supported task kinds, known criterion IDs, and separate authors/reviewers. Do not execute project tools or reply with a prose plan.`,
            });
          }
        }
        if (!plan) throw new Error('Provider did not return a valid plan');
        const ids = new Map(plan.map((p) => [p.key, randomUUID()]));
        this.change(id, 'plan_created', 'Model generated a validated task graph', (s) => {
          const time = now();
          s.tasks.push(
            ...plan.map((p) => ({
              id: ids.get(p.key)!,
              commissionId: id,
              agentId: p.agentId,
              title: p.title,
              description: p.description,
              kind: p.kind,
              status: 'queued' as const,
              dependencies: p.dependencies.map((k) => ids.get(k)!),
              dependencyKinds: Object.fromEntries(
                Object.entries(p.dependencyKinds ?? {}).map(([k, v]) => [ids.get(k)!, v]),
              ),
              criterionIds: p.criterionIds,
              inputVersions: [],
              outputArtifactIds: [],
              step: 'Queued',
              attempts: 0,
              createdAt: time,
              updatedAt: time,
            })),
          );
          s.commission.summary = 'Plan ready';
          if (s.commission.planningMode === 'review_first') {
            s.commission.status = 'paused';
            s.requests.push({
              id: randomUUID(),
              commissionId: id,
              kind: 'approval',
              title: 'Review proposed plan',
              detail: 'Review the generated task graph before execution.',
              status: 'open',
              createdAt: time,
            });
          }
        });
      } finally {
        this.planning.delete(id);
      }
    });
  }
  private startTask(id: string, taskId: string, agentId: string): void {
    this.change(
      id,
      'task_started',
      'Agent started task',
      (s) => {
        const t = s.tasks.find((t) => t.id === taskId)!;
        t.status = 'running';
        t.attempts++;
        t.step = 'Preparing isolated task workspace';
        t.updatedAt = now();
      },
      {
        taskId,
      },
    );
    this.launch(agentId, id, async (signal) => {
      try {
        await this.runTask(id, taskId, signal);
        if (this.store.get(id).tasks.find((t) => t.id === taskId)?.status === 'running')
          this.change(
            id,
            'task_waiting',
            'Task paused at a model-turn boundary',
            (s) => {
              const t = s.tasks.find((t) => t.id === taskId)!;
              t.status = 'queued';
              waitForTaskRequests(s, t);
            },
            { taskId },
          );
      } catch (e) {
        if (
          e instanceof OutcomeUnknownError &&
          this.store.get(id).tasks.find((t) => t.id === taskId)?.error === 'outcome_unknown'
        )
          return;
        this.change(
          id,
          signal.aborted ? 'task_stopped' : 'task_failed',
          signal.aborted ? 'Active call stopped' : this.safeError(e),
          (s) => {
            const t = s.tasks.find((t) => t.id === taskId)!;
            t.status = signal.aborted
              ? s.commission.status === 'cancelling'
                ? 'cancelled'
                : 'queued'
              : 'failed';
            t.error = this.safeError(e);
            t.step = signal.aborted ? 'Stopped' : 'Execution failed';
            if (signal.aborted) waitForTaskRequests(s, t);
            if (!signal.aborted) {
              s.commission.status = 'paused';
              s.commission.summary = 'A task failed; inspect evidence before resuming';
            }
          },
          { taskId },
        );
      }
    });
  }
  private async runTask(id: string, taskId: string, signal: AbortSignal): Promise<void> {
    const initial = this.store.get(id),
      task = initial.tasks.find((t) => t.id === taskId)!;
    const existingPath = this.store.taskPath(taskId);
    const workPath = existingPath ?? (await createTaskWorkspace(initial.workspace, task.id));
    if (!existingPath) this.store.setTaskPath(taskId, workPath);
    const reworkOutputs = directedReworkOutputs(initial, task);
    const reworkBase = reworkOutputs.find((a) => a.id === task.artifactRework?.artifactId);
    if (task.artifactRework && !reworkBase) throw new Error('Previous rework version is missing');
    const inputs = initial.artifacts.filter(
      (a) =>
        a.validity === 'current' &&
        task.dependencies.includes(a.taskId) &&
        !reworkOutputs.some((output) => output.relativePath === a.relativePath),
    );
    const pin = async (a: Artifact) => {
      const path = resolve(workPath, a.relativePath);
      const rel = relative(workPath, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Invalid artifact input path');
      await assertPlainPath(path, true);
      await mkdir(dirname(path), { recursive: true });
      await assertPlainPath(path, true);
      await writeFile(path, await readArtifact(this.options.dataRoot, a));
    };
    for (const a of inputs) {
      if (task.inputVersions.includes(a.versionId)) continue;
      await pin(a);
    }
    if (reworkBase && !initial.events.some((e) => e.type === 'task_inputs' && e.taskId === taskId))
      await pin(reworkBase);
    this.change(
      id,
      'task_inputs',
      'Pinned current input artifact versions',
      (s) => {
        s.tasks.find((t) => t.id === taskId)!.inputVersions = inputs.map((a) => a.versionId);
      },
      {
        taskId,
      },
    );
    const evidence = initial.evidence.filter((e) => e.taskId === taskId);
    const answerTaskIds = previousTaskIds(initial, task).add(taskId);
    const messages: Message[] = [
      {
        role: 'system',
        content: `You are ${task.agentId}, carrying out your assigned task in an isolated task workspace. The task description and criterionIds define your scope; the overall project goal is context, not an instruction to perform other partners' tasks. Only create and publish files owned by this task. Use registered tools. All paths are relative to your workspace. Do not claim execution or tests without tool output. Publish all final files with submit_artifact, then call complete_task once the handoff is ready. Before using render_source, publish the source or use the exact published input supplied by your dependency. For a targeted replacement, publish the selected file and the specifically listed regenerated files. Remove temporary changes before completion. A reviewer must inspect every pinned input version with workspace_read or inspect_delivery, then perform applicable checks and submit_review with the real evidence IDs and every input version ID. Process output alone does not establish which file version was inspected. Insufficient evidence is unable_to_verify. Never approve your own work. User rejections must be respected. Tools may not access runtime state files.`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          goal: initial.commission.goal,
          criteria: initial.commission.criteria,
          task,
          environment: executionEnvironment(initial.commission.scope),
          capabilities: await this.options.executor.capabilities(),
          inputs,
          previousArtifact: reworkBase,
          ...(reworkOutputs.length > 1 && {
            previousRenderedArtifacts: reworkOutputs.filter((a) => a.id !== reworkBase?.id),
          }),
          userAnswers: initial.requests.filter(
            (r) => r.taskId && answerTaskIds.has(r.taskId) && r.status !== 'open',
          ),
          pendingRequests: initial.requests.filter(
            (r) => r.status === 'open' && (!r.taskId || r.taskId === taskId),
          ),
          priorEvidence: summarizeTaskEvidence(evidence),
          priorEvidenceMayBeTruncated: evidence.length > 24,
          availableArtifacts: initial.artifacts,
          continuation: await buildTaskContinuation(
            workPath,
            this.store.recentTaskCalls(id, taskId),
            inputs.concat(
              initial.artifacts.filter((a) => a.taskId === taskId),
              reworkOutputs,
            ),
          ),
        }),
      },
    ];
    const definitions = [
      ...this.options.executor
        .definitions()
        .filter(
          (d) =>
            (task.kind !== 'review' || d.effect !== 'write') &&
            grantedTool(d.effect, initial.commission.scope),
        ),
      ...runtimeTools,
    ];
    while (!signal.aborted) {
      const s = this.store.get(id);
      if (s.commission.status !== 'active') return;
      const current = s.tasks.find((t) => t.id === taskId)!;
      if (current.status !== 'running') return;
      const settings = await this.options.getCredentials();
      if (!settings) throw new Error('Provider is not configured');
      const callId = randomUUID();
      signal.throwIfAborted();
      if (!this.reserveStep(id, callId, taskId)) return;
      let response;
      try {
        response = await complete(settings, messages, definitions, signal);
        this.store.endCall(callId, {
          ok: true,
        });
      } catch (e) {
        this.store.endCall(callId, {
          ok: false,
          error: this.safeError(e),
        });
        throw e;
      }
      signal.throwIfAborted();
      messages.push({
        role: 'assistant',
        content: response.text,
        calls: response.calls,
        native: response.native,
      });
      if (!response.calls.length)
        throw new Error('Model stopped without completing the task through a registered tool');
      for (const call of response.calls) {
        signal.throwIfAborted();
        if (this.store.get(id).tasks.find((t) => t.id === taskId)!.status !== 'running') break;
        let output: unknown;
        try {
          const definition = definitions.find((t) => t.name === call.name);
          if (!definition) throw new Error('Unregistered tool');
          validateArguments(call.args, definition.parameters);
          if (runtimeTools.some((t) => t.name === call.name)) {
            const runId = randomUUID();
            this.store.startCall(runId, id, taskId, {
              kind: 'runtime_tool',
              name: call.name,
              args: call.args,
              revision: s.commission.revision,
            });
            try {
              output = await this.runtimeTool(id, taskId, workPath, call);
              this.store.endCall(runId, output);
            } catch (error) {
              this.store.endCall(runId, {
                ok: false,
                code: error instanceof OutcomeUnknownError ? 'OUTCOME_UNKNOWN' : 'tool_error',
                output: this.safeError(error),
              });
              if (error instanceof OutcomeUnknownError)
                this.requireReconciliation(id, taskId, runId, call.name);
              throw error;
            }
          } else output = await this.executorTool(id, taskId, workPath, call, signal);
        } catch (e) {
          if (e instanceof OutcomeUnknownError) throw e;
          output = {
            ok: false,
            code: 'tool_error',
            output: this.safeError(e),
          };
        }
        messages.push({
          role: 'tool',
          content: JSON.stringify(output),
          callId: call.id,
          name: call.name,
        });
      }
    }
    signal.throwIfAborted();
  }
  private async executorTool(
    id: string,
    taskId: string,
    workPath: string,
    call: Call,
    signal: AbortSignal,
  ): Promise<unknown> {
    const s = this.store.get(id),
      task = s.tasks.find((t) => t.id === taskId)!,
      runId = randomUUID();
    const definition = this.options.executor.definitions().find((d) => d.name === call.name);
    if (task.kind === 'review' && definition?.effect === 'write')
      throw new Error(
        'Review workspaces are read-only; author changes require a separate rework task',
      );
    const source = call.args.path ?? call.args.source;
    const render = call.name === 'render_source';
    const inputs = s.artifacts.filter((a) => task.inputVersions.includes(a.versionId));
    const pinned =
      task.kind === 'review'
        ? inputs
        : render && typeof source === 'string'
          ? s.artifacts.filter(
              (a) =>
                a.validity === 'current' &&
                (a.taskId === taskId || task.inputVersions.includes(a.versionId)) &&
                resolve(workPath, source) === resolve(workPath, a.relativePath),
            )
          : [];
    const before = await this.pinnedHashes(workPath, pinned);
    this.store.startCall(runId, id, taskId, {
      kind: 'tool',
      name: call.name,
      args: call.args,
      revision: s.commission.revision,
    });
    this.change(
      id,
      'tool_started',
      `Calling ${call.name}`,
      (s) => {
        s.tasks.find((t) => t.id === taskId)!.step = call.name;
      },
      { taskId },
    );
    let output;
    try {
      output =
        render && pinned.length !== 1
          ? {
              ok: false,
              code: 'RENDER_SOURCE_NOT_PINNED',
              output:
                'Publish the source with submit_artifact or use a published source pinned from a dependency, then retry rendering',
            }
          : pinned.some((a) => before[a.versionId] !== a.sha256)
            ? {
                ok: false,
                code: render ? 'RENDER_SOURCE_CHANGED' : 'REVIEW_INPUT_CHANGED',
                output: render
                  ? 'Use the published source bytes, or publish the edited source before rendering'
                  : 'Pinned artifact bytes changed before tool execution',
              }
            : await this.options.executor.execute(call.name, call.args, {
                commissionId: id,
                taskId,
                runId,
                workPath,
                scope: {
                  ...s.commission.scope,
                  writeRoots: [workPath],
                },
                signal,
              });
    } catch (e) {
      output = {
        ok: false,
        code: definition?.effect === 'read' ? 'tool_error' : 'OUTCOME_UNKNOWN',
        output: this.safeError(e),
      };
    }
    const unknown =
      output.code === 'OUTCOME_UNKNOWN' || output.metadata?.stopStatus === 'outcome_unknown';
    const after = await this.pinnedHashes(workPath, pinned);
    const matching = pinned.filter(
      (a) => before[a.versionId] === a.sha256 && after[a.versionId] === a.sha256,
    );
    if (!unknown && pinned.some((a) => !matching.some((m) => m.versionId === a.versionId)))
      output = {
        ...output,
        ok: false,
        code: render ? 'RENDER_SOURCE_CHANGED' : 'REVIEW_INPUT_CHANGED',
        output: 'Pinned artifact bytes changed during tool execution',
      };
    let renderedOutput: RenderedOutput | undefined;
    if (render && output.ok) {
      const target = call.args.output;
      const sha256 = output.metadata?.outputSha256;
      const renderedSource = matching[0];
      if (
        renderedSource &&
        renderedSource.sha256 === output.metadata?.sourceSha256 &&
        typeof target === 'string' &&
        typeof sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(sha256)
      ) {
        renderedOutput = {
          path: relative(workPath, resolve(workPath, target)).replaceAll('\\', '/'),
          sha256,
          sourceVersionId: renderedSource.versionId,
        };
      } else {
        output = {
          ...output,
          ok: false,
          code: 'RENDER_PROVENANCE_MISMATCH',
          output: 'Could not bind the generated file to the exact published source version',
        };
      }
    }
    const qualifying = artifactInspectionTools.has(call.name);
    const consumed =
      output.ok && qualifying && typeof source === 'string'
        ? matching.filter((a) => resolve(workPath, source) === resolve(workPath, a.relativePath))
        : [];
    const evidenceId = randomUUID();
    this.change(
      id,
      'tool_finished',
      `${call.name}: ${output.ok ? 'returned successfully' : 'failed'}`,
      (s) => {
        this.store.endCall(runId, { ...output, evidenceId, inputVersionIds: task.inputVersions });
        s.evidence.push({
          id: evidenceId,
          kind: 'tool',
          summary: `${call.name}: ${output.ok ? 'success' : 'failure'}`,
          detail: JSON.stringify({
            runId,
            name: call.name,
            args: call.args,
            result: output,
            verifiedInputs: consumed.map((a) => ({ versionId: a.versionId, sha256: a.sha256 })),
            renderedOutput,
          }),
          status: unknown ? 'not_run' : output.ok ? 'passed' : 'failed',
          taskId,
          artifactVersionIds:
            task.kind === 'review' ? consumed.map((a) => a.versionId) : task.inputVersions,
          createdAt: now(),
        });
      },
      { taskId },
    );
    if (unknown) {
      this.requireReconciliation(id, taskId, runId, call.name);
    }
    signal.throwIfAborted();
    return {
      ...output,
      evidenceId,
      inputVersionIds: task.inputVersions,
    };
  }
  private requireReconciliation(id: string, taskId: string, runId: string, name: string): never {
    this.change(
      id,
      'tool_outcome_unknown',
      'Tool returned without confirmation that its external effects or process have stopped',
      (s) => {
        s.commission.status = 'paused';
        s.commission.summary =
          'A tool outcome is unknown. Inspect its process, files and logs before continuing or confirming cancellation.';
        const t = s.tasks.find((t) => t.id === taskId)!;
        t.status = 'waiting_approval';
        t.error = 'outcome_unknown';
        t.step = 'Outcome unknown; reconciliation required';
        if (
          !s.requests.some(
            (r) => r.taskId === taskId && r.status === 'open' && r.title === interruptedTitle,
          )
        )
          s.requests.push({
            id: randomUUID(),
            commissionId: id,
            taskId,
            kind: 'approval',
            title: interruptedTitle,
            detail: `Call ${runId} (${name}) could not confirm its outcome. Inspect the actual process, files and logs. Describe the observed state and approve only after reconciliation.`,
            status: 'open',
            createdAt: now(),
          });
      },
      { taskId },
    );
    for (const run of this.running.values())
      if (run.commissionId === id)
        run.controller.abort(new OutcomeUnknownError('Tool outcome unknown'));
    throw new OutcomeUnknownError('Tool outcome unknown');
  }
  private async pinnedHashes(
    workPath: string,
    artifacts: Artifact[],
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const artifact of artifacts) {
      try {
        const path = resolve(workPath, artifact.relativePath);
        await assertPlainPath(path);
        const actual = await realpath(path),
          base = await realpath(workPath),
          rel = relative(base, actual);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
        hashes[artifact.versionId] = hash(await readFile(actual));
      } catch {
        /* Missing or replaced inputs never qualify as verified. */
      }
    }
    return hashes;
  }
  private async runtimeTool(
    id: string,
    taskId: string,
    workPath: string,
    call: Call,
  ): Promise<unknown> {
    const s = this.store.get(id),
      task = s.tasks.find((t) => t.id === taskId)!,
      a = call.args;
    if (call.name === 'ask_input') {
      const requestId = randomUUID();
      this.change(
        id,
        'input_requested',
        String(a.title),
        (s) => {
          s.requests.push({
            id: requestId,
            commissionId: id,
            taskId,
            kind: a.kind as 'input' | 'approval',
            title: String(a.title),
            detail: String(a.detail),
            status: 'open',
            createdAt: now(),
          });
          const t = s.tasks.find((t) => t.id === taskId)!;
          t.status = a.kind === 'approval' ? 'waiting_approval' : 'waiting_input';
          t.step = String(a.title);
        },
        {
          taskId,
        },
      );
      return {
        ok: true,
        requestId,
      };
    }
    if (call.name === 'submit_artifact') {
      if (task.kind === 'review') throw new Error('Review tasks cannot replace author artifacts');
      const path = String(a.path);
      const replacementPaths = task.artifactRework
        ? directedReworkOutputs(s, task)
        : previousTaskOutputs(s, task);
      const relativePath = relative(workPath, resolve(workPath, path)).replaceAll('\\', '/');
      const previousVersion = replacementPaths
        .filter((a) => a.relativePath === relativePath)
        .at(-1);
      if ((task.artifactRework || replacementPaths.length) && !previousVersion)
        throw new Error('Only the previous artifact output paths may be published during rework');
      if (
        task.replacesTaskId &&
        s.artifacts.some(
          (a) =>
            a.validity === 'current' &&
            a.taskId !== taskId &&
            pathComparisonKey(a.relativePath) === pathComparisonKey(relativePath),
        )
      )
        throw new Error('The output path belongs to a different current artifact');
      if (task.replacesTaskId) await assertPlainPath(resolve(workPath, path));
      const artifact = await publishArtifact(this.options.dataRoot, workPath, path, {
        commissionId: id,
        taskId,
        name: task.artifactRework && previousVersion ? previousVersion.name : String(a.name),
        mediaType:
          task.artifactRework && previousVersion ? previousVersion.mediaType : String(a.mediaType),
        inputVersions: task.inputVersions,
      });
      if (previousVersion && artifact.relativePath !== previousVersion.relativePath)
        throw new Error('Published path differs from the requested replacement path');
      if (
        task.artifactRework &&
        previousVersion?.versionId === task.artifactRework.versionId &&
        artifact.sha256 === previousVersion.sha256
      )
        throw new Error('The requested replacement must change the previous artifact bytes');
      const renderEvidence = renderedPublication(s, taskId, workPath, relativePath);
      if (renderEvidence === null)
        throw new Error(
          'Render the deliverable successfully from the pinned source before publishing',
        );
      if (renderEvidence) {
        const source = s.artifacts.find(
          (a) => a.versionId === renderEvidence.sourceVersionId && a.validity === 'current',
        );
        if (
          renderEvidence.path !== artifact.relativePath ||
          renderEvidence.sha256 !== artifact.sha256 ||
          !source ||
          (source.taskId !== taskId && !task.inputVersions.includes(source.versionId))
        )
          throw new Error('Generated file changed since it was rendered from the pinned source');
        artifact.renderedFromVersionId = source.versionId;
        artifact.inputVersions = [...new Set([...artifact.inputVersions, source.versionId])];
      }
      this.change(
        id,
        'artifact_available',
        `Published ${artifact.name}`,
        (s) => {
          if (
            artifact.inputVersions.some(
              (version) =>
                !s.artifacts.some((a) => a.versionId === version && a.validity === 'current'),
            )
          )
            throw new Error('Task input versions changed before publication');
          if (
            task.replacesTaskId &&
            s.artifacts.some(
              (a) =>
                a.validity === 'current' &&
                a.taskId !== taskId &&
                pathComparisonKey(a.relativePath) === pathComparisonKey(artifact.relativePath),
            )
          )
            throw new Error('The output path belongs to a different current artifact');
          const versions = s.artifacts.filter(
            (x) => x.taskId === taskId && x.relativePath === artifact.relativePath,
          );
          const parent = versions.at(-1) ?? previousVersion;
          if (parent) artifact.previousVersionId = parent.versionId;
          invalidateLineage(
            s,
            versions.filter((x) => x.validity === 'current').map((x) => x.versionId),
          );
          s.artifacts.push(artifact);
          s.tasks.find((t) => t.id === taskId)!.outputArtifactIds.push(artifact.id);
        },
        {
          taskId,
          artifactVersionId: artifact.versionId,
        },
      );
      this.kick(id);
      return {
        ok: true,
        artifactId: artifact.id,
        versionId: artifact.versionId,
      };
    }
    if (call.name === 'complete_task') {
      if (task.kind === 'review') throw new Error('Reviewer must submit_review');
      if (!task.outputArtifactIds.length)
        throw new Error('Publish actual deliverables before completion');
      const published = s.artifacts.filter((a) => a.taskId === taskId && a.validity === 'current');
      for (const artifact of published) {
        if (hash(await readFile(resolve(workPath, artifact.relativePath))) !== artifact.sha256)
          throw new Error(
            'Task files changed after publication; publish the current bytes before integrating',
          );
      }
      const changes = await previewTaskWorkspaceChanges(s.workspace, workPath);
      if (task.artifactRework) {
        const previous = directedReworkOutputs(s, task);
        const target = previous.find((a) => a.versionId === task.artifactRework!.versionId)!;
        const source = published.find((a) => a.relativePath === target.relativePath);
        if (
          !source ||
          previous.some(
            (expected) =>
              expected.id !== target.id &&
              !published.some(
                (output) =>
                  output.relativePath === expected.relativePath &&
                  output.renderedFromVersionId === source.versionId,
              ),
          )
        )
          throw new Error(
            'Publish the selected file and regenerate every listed output from its new version',
          );
        if (changes.some((change) => !previous.some((a) => a.relativePath === change.path)))
          throw new Error('The replacement task may integrate only the listed artifact paths');
      }
      if (task.replacesTaskId && !task.artifactRework) {
        const previous = previousTaskOutputs(s, task);
        if (
          previous.some((expected) => {
            const output = published.find((a) => a.relativePath === expected.relativePath);
            if (!output) return true;
            if (!expected.renderedFromVersionId) return false;
            const oldSource = s.artifacts.find(
              (a) => a.versionId === expected.renderedFromVersionId,
            );
            const source = s.artifacts.find(
              (a) => a.versionId === output.renderedFromVersionId && a.validity === 'current',
            );
            return !source || source.relativePath !== oldSource?.relativePath;
          })
        )
          throw new Error(
            'Republish every affected deliverable, regenerating native files from their current source',
          );
      }
      for (const change of changes) {
        if (change.action === 'delete')
          throw new Error(
            `Deletion requires reviewed deletion support and is currently blocked: ${change.path}`,
          );
        if (
          !s.artifacts.some(
            (a) =>
              a.taskId === taskId &&
              a.validity === 'current' &&
              a.relativePath === change.path &&
              a.sha256 === change.afterHash,
          )
        )
          throw new Error(`Publish every changed file before integration: ${change.path}`);
      }
      let integration;
      try {
        // Validation above is effect-free. Integration may write several managed files;
        // a thrown I/O error cannot establish which writes reached the filesystem.
        integration = await integrateTaskWorkspace(s.workspace, workPath, changes);
        if (integration.ok)
          this.change(
            id,
            'task_completed',
            String(a.summary),
            (s) => {
              const t = s.tasks.find((t) => t.id === taskId)!;
              if (t.status !== 'running') return;
              const versions = s.artifacts
                .filter((a) => a.taskId === taskId && a.validity === 'current')
                .map((a) => a.versionId);
              const reviewed =
                versions.length > 0 &&
                versions.every((v) =>
                  s.evidence.some(
                    (e) =>
                      e.kind === 'review' &&
                      e.status === 'passed' &&
                      e.artifactVersionIds.includes(v),
                  ),
                );
              t.status =
                s.tasks.some((r) => r.kind === 'review' && r.dependencies.includes(taskId)) &&
                !reviewed
                  ? 'awaiting_review'
                  : 'passed';
              t.step = String(a.summary);
            },
            { taskId },
          );
      } catch (error) {
        throw new OutcomeUnknownError(
          `Managed integration may be partial: ${this.safeError(error)}`,
        );
      }
      if (!integration.ok)
        throw new Error(`Integration conflicts: ${integration.conflicts.join(', ')}`);
      return {
        ok: true,
      };
    }
    if (call.name === 'submit_review') return this.review(id, taskId, a);
    throw new Error('Unregistered runtime tool');
  }
  private async review(
    id: string,
    taskId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const s = this.store.get(id),
      task = s.tasks.find((t) => t.id === taskId)!;
    if (task.kind !== 'review') throw new Error('Only review tasks can submit_review');
    const versions = args.versionIds as string[],
      evidenceIds = args.evidenceIds as string[];
    const authors = s.tasks.filter((t) => task.dependencies.includes(t.id) && t.kind !== 'review');
    if (authors.some((t) => t.agentId === task.agentId))
      throw new Error('An author cannot review their own work');
    const expected = s.artifacts
      .filter((a) => authors.some((t) => t.id === a.taskId) && a.validity === 'current')
      .map((a) => a.versionId);
    let verdict = String(args.verdict);
    const reviewArtifacts = s.artifacts.filter((a) => expected.includes(a.versionId));
    const workPath = this.store.taskPath(taskId);
    const decisionHashes = workPath ? await this.pinnedHashes(workPath, reviewArtifacts) : {};
    const latest = this.store.get(id);
    const latestTask = latest.tasks.find((t) => t.id === taskId);
    const latestVersions = latest.artifacts
      .filter((a) => a.validity === 'current' && latestTask?.dependencies.includes(a.taskId))
      .map((a) => a.versionId);
    const unchanged =
      latest.commission.revision === s.commission.revision &&
      latestTask?.status === 'running' &&
      latestVersions.length === expected.length &&
      latestVersions.every((v) => expected.includes(v)) &&
      reviewArtifacts.every(
        (a) =>
          decisionHashes[a.versionId] === a.sha256 &&
          latest.artifacts.some(
            (b) => b.versionId === a.versionId && b.sha256 === a.sha256 && b.validity === 'current',
          ),
      );
    const validEvidence =
      evidenceIds.length > 0 &&
      reviewArtifacts.every((artifact) =>
        evidenceIds.some((id) =>
          s.evidence.some((e) => {
            if (
              e.id !== id ||
              e.taskId !== taskId ||
              e.kind !== 'tool' ||
              e.status !== 'passed' ||
              !e.artifactVersionIds.includes(artifact.versionId)
            )
              return false;
            const detail = JSON.parse(e.detail);
            if (
              !detail.verifiedInputs?.some(
                (v: { versionId: string; sha256: string }) =>
                  v.versionId === artifact.versionId && v.sha256 === artifact.sha256,
              )
            )
              return false;
            const path = detail.args.path ?? detail.args.source;
            if (artifactInspectionTools.has(detail.name))
              return (
                typeof path === 'string' &&
                path.replaceAll('\\', '/').replace(/^\.\//, '') === artifact.relativePath
              );
            return false;
          }),
        ),
      );
    if (
      verdict === 'pass' &&
      (!unchanged ||
        !expected.length ||
        expected.some((v) => !versions.includes(v)) ||
        versions.some((v) => !expected.includes(v)) ||
        !validEvidence)
    )
      verdict = 'unable_to_verify';
    this.change(
      id,
      'review_submitted',
      `${verdict}: ${String(args.summary)}`,
      (s) => {
        const t = s.tasks.find((t) => t.id === taskId)!;
        s.evidence.push({
          id: randomUUID(),
          kind: 'review',
          summary: String(args.summary),
          detail: JSON.stringify({
            verdict,
            evidenceIds,
            authorTaskIds: authors.map((t) => t.id),
          }),
          status:
            verdict === 'pass' ? 'passed' : verdict === 'changes_requested' ? 'failed' : 'not_run',
          taskId,
          artifactVersionIds: expected,
          createdAt: now(),
        });
        if (verdict === 'pass') {
          t.status = 'passed';
          t.step = 'Independent review passed';
          for (const author of authors) {
            const a = s.tasks.find((t) => t.id === author.id)!;
            if (a.status === 'awaiting_review') a.status = 'passed';
          }
        } else if (verdict === 'changes_requested') {
          const previous = s.events.filter((e) => e.type === 'rework_created').length;
          if (previous >= s.commission.budget.maxRework) {
            t.status = 'failed';
            t.error = 'rework_budget_exhausted';
            s.commission.status = 'paused';
            s.commission.summary = 'Rework limit reached';
            return;
          }
          const targetedAuthor = authors.length === 1 ? authors[0] : undefined;
          if (targetedAuthor?.artifactRework) {
            const previous = s.artifacts.find(
              (a) => a.versionId === targetedAuthor.artifactRework!.versionId,
            );
            const target = s.artifacts.find(
              (a) =>
                a.taskId === targetedAuthor.id &&
                a.validity === 'current' &&
                a.relativePath === previous?.relativePath,
            );
            const schedule =
              target &&
              scheduleArtifactRework(
                s,
                target,
                targetedAuthor,
                t.agentId,
                `${targetedAuthor.artifactRework.instruction}\nIndependent review feedback: ${String(args.summary)}`,
                targetedAuthor.artifactRework.requestId,
                now(),
              );
            if (target && schedule && 'task' in schedule) {
              const rework = schedule.task;
              this.event(
                s,
                'rework_created',
                `Linked ${rework.id} to ${targetedAuthor.id}`,
                rework,
                target.versionId,
              );
              return;
            }
            t.status = 'failed';
            t.step = 'Awaiting further rework';
            s.commission.status = 'paused';
            s.commission.summary =
              schedule && 'path' in schedule
                ? `Another current artifact already owns ${schedule.path}`
                : 'Resolve affected task requests before reworking';
            return;
          }
          t.status = 'queued';
          for (const author of authors) {
            const old = s.tasks.find((t) => t.id === author.id)!;
            old.status = 'rework_required';
            invalidateLineage(
              s,
              s.artifacts.filter((a) => a.taskId === old.id).map((a) => a.versionId),
            );
            const rework = {
              ...structuredClone(old),
              id: randomUUID(),
              ...(old.replacesTaskId && { replacesTaskId: old.id }),
              kind: old.kind === 'office' ? ('implement' as const) : old.kind,
              title: `Rework: ${old.title}`,
              description: `${old.description}\nReview feedback: ${String(args.summary)}\nReworks task ${old.id}`,
              status: 'queued' as const,
              outputArtifactIds: [],
              inputVersions: [],
              attempts: 0,
              step: 'Rework requested',
              createdAt: now(),
              updatedAt: now(),
            };
            s.tasks.push(rework);
            for (const dependent of s.tasks) {
              if (
                !dependent.dependencies.includes(old.id) ||
                (dependent.id !== t.id &&
                  (!old.replacesTaskId ||
                    !['queued', 'waiting_dependency'].includes(dependent.status)))
              )
                continue;
              dependent.dependencies = dependent.dependencies.map((dep) =>
                dep === old.id ? rework.id : dep,
              );
              if (dependent.dependencyKinds?.[old.id]) {
                dependent.dependencyKinds[rework.id] = dependent.dependencyKinds[old.id];
                delete dependent.dependencyKinds[old.id];
              }
            }
            this.event(s, 'rework_created', `Linked ${rework.id} to ${old.id}`, rework);
          }
        } else {
          t.status = 'failed';
          t.step = 'Unable to verify';
          s.commission.status = 'paused';
          s.commission.summary =
            'Review evidence is insufficient; further verification is required';
        }
      },
      {
        taskId,
      },
    );
    return {
      ok: true,
      verdict,
    };
  }
  async close(pendingCommands: Promise<unknown>[] = []): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    clearInterval(this.budgetTimer);
    for (const run of this.running.values()) run.controller.abort(new Error('Runtime closing'));
    await Promise.allSettled(pendingCommands);
    for (const s of this.store.projects())
      if (s.commission.status === 'active')
        this.change(s.commission.id, 'runtime_closing', 'Runtime is stopping safely', (s) => {
          s.commission.status = 'paused';
        });
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    this.closed = true;
    this.listeners.clear();
    this.store.close();
    this.ownership.release();
  }
}
