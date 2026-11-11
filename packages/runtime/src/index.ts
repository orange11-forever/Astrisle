import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  Artifact,
  ArtifactPreview,
  Bootstrap,
  CommandResult,
  NewWorkspaceInput,
  ProjectSnapshot,
  RuntimeOptions,
  SubmitInput,
  Task,
  Workspace,
} from '../../contracts/src/index';
import { RuntimeStore } from '../../persistence/src/index';
import { agents, invalidateLineage, ready, validatePlan } from '../../domain/src/index';
import { blobPath, hash, publishArtifact, readArtifact } from '../../artifacts/src/index';
import {
  createWorkspaceStorage,
  createTaskWorkspace,
  integrateTaskWorkspace,
  previewTaskWorkspaceChanges,
} from '../../workspace/src/index';
import { assertPlainPath } from '../../executor/src/path-guard';
import { complete, validateArguments, type Call, type Message } from './provider';
import { planTool, runtimeTools } from './tools';
export interface RuntimeService {
  bootstrap(): Promise<Bootstrap>;
  createWorkspace(input: NewWorkspaceInput): Promise<Workspace>;
  submit(input: SubmitInput): Promise<CommandResult>;
  snapshot(id: string): Promise<ProjectSnapshot>;
  control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<CommandResult>;
  answer(requestId: string, answer: string, approve?: boolean): Promise<CommandResult>;
  revise(id: string, instruction: string, expectedRevision: number): Promise<CommandResult>;
  accept(id: string, artifactIds: string[]): Promise<CommandResult>;
  artifact(id: string): Promise<ArtifactPreview>;
  resolveArtifactPath(id: string): Promise<string>;
  subscribe(listener: (snapshot: ProjectSnapshot) => void): () => void;
  testProvider(): Promise<CommandResult>;
  close(): Promise<void>;
}
const now = () => new Date().toISOString();
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
  return new Runtime(options);
}
class OutcomeUnknownError extends Error {}
const interruptedTitle = 'Inspect interrupted task';
class Runtime implements RuntimeService {
  private store: RuntimeStore;
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
  private closing = false;
  private closed = false;
  private activeSince = new Map<string, number>();
  constructor(private options: RuntimeOptions) {
    this.store = new RuntimeStore(options.dataRoot);
    const unknown = this.store.unknownCalls();
    for (const snapshot of this.store.projects())
      if (['active', 'cancelling'].includes(snapshot.commission.status)) {
        snapshot.commission.status = 'paused';
        snapshot.commission.summary =
          'Runtime restarted. Previous calls may have an unknown outcome; inspect evidence before resuming.';
        for (const task of snapshot.tasks)
          if (task.status === 'running') {
            task.status = 'waiting_input';
            task.error = 'outcome_unknown';
            task.step = 'Inspect previous tool output before resuming';
            const id = randomUUID();
            snapshot.requests.push({
              id,
              commissionId: snapshot.commission.id,
              taskId: task.id,
              kind: 'approval',
              title: 'Inspect interrupted task',
              detail:
                'Previous execution outcome is unknown. Confirm the task workspace is safe to continue; this will not replay the old call.',
              status: 'open',
              createdAt: now(),
            });
          }
        this.event(
          snapshot,
          'recovery',
          'Paused after restart; no interrupted tool call was replayed',
        );
        this.store.transaction(() => this.store.save(snapshot));
      }
    for (const call of unknown)
      this.store.endCall(call.id, {
        code: 'outcome_unknown',
      });
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
    for (const listener of this.listeners)
      try {
        listener(structuredClone(s));
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
  async submit(input: SubmitInput): Promise<CommandResult> {
    if (this.closing) return result(false, 'Runtime is closing', 'closing');
    const payload = canonical(input);
    const receipt = this.store.receipt(input.requestId);
    if (receipt)
      return receipt.payload === payload
        ? receipt.result
        : result(false, 'Request ID already has a different payload', 'request_conflict');
    const workspace = this.store.workspaces().find((w) => w.id === input.workspaceId);
    if (!workspace) return result(false, 'Workspace not found', 'workspace_not_found');
    if (
      !input.requestId ||
      !input.goal?.trim() ||
      !Array.isArray(input.criteria) ||
      !input.criteria.length ||
      input.criteria.some((c) => !c.trim()) ||
      !Number.isInteger(input.budget.maxSteps) ||
      input.budget.maxSteps < 1 ||
      !Number.isFinite(input.budget.maxMinutes) ||
      input.budget.maxMinutes <= 0 ||
      input.budget.maxRework < 0
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
        budget: {
          ...input.budget,
          maxRework: Math.min(3, input.budget.maxRework),
        },
        revision: 1,
        planningMode: input.planningMode,
        stepsUsed: 0,
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
    this.emit(snapshot);
    this.kick(id);
    return answer;
  }
  async snapshot(id: string): Promise<ProjectSnapshot> {
    return this.store.get(id);
  }
  subscribe(listener: (snapshot: ProjectSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<CommandResult> {
    const current = this.store.get(id);
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
      this.activeSince.set(id, Date.now());
      this.kick(id);
    }
    return result(
      true,
      action === 'cancel' && active.length
        ? 'Cancellation requested; waiting for active calls to stop'
        : `Commission ${action}`,
    );
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
      const t = s.tasks.find((t) => t.id === r.taskId);
      if (t) {
        t.status = 'queued';
        t.step =
          r.status === 'rejected'
            ? 'Approval rejected; find an alternative'
            : 'User input received';
        if (r.title === interruptedTitle) delete t.error;
      }
      if (r.title === 'Review proposed plan' && approve === true) s.commission.status = 'active';
    });
    this.kick(snapshot.commission.id);
    return result(true, 'Answer recorded');
  }
  async revise(id: string, instruction: string, expectedRevision: number): Promise<CommandResult> {
    const s = this.store.get(id);
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
      /\.(md|txt|json|ts|tsx|js|py|css|html|csv)$/.test(artifact.relativePath);
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
      const s = this.store.get(id);
      if (s.commission.status !== 'active') return;
      if (!s.tasks.some((t) => t.status !== 'cancelled')) {
        if (!this.planning.has(id)) this.startPlan(id);
        return;
      }
      if (!this.activeSince.has(id)) this.activeSince.set(id, Date.now());
      if (
        s.commission.stepsUsed >= s.commission.budget.maxSteps ||
        Date.now() - this.activeSince.get(id)! >= s.commission.budget.maxMinutes * 60000
      ) {
        this.change(id, 'budget_paused', 'Step or time budget reached', (s) => {
          s.commission.status = 'paused';
          s.commission.summary = 'Budget reached; review and revise the budget before continuing';
        });
        return;
      }
      for (const agent of agents) {
        if (this.running.has(agent.id)) continue;
        const task = s.tasks.find((t) => t.agentId === agent.id && ready(t, s));
        if (task) this.startTask(id, task.id, agent.id);
      }
      const latest = this.store.get(id);
      const live = latest.tasks.filter((t) => !['cancelled', 'rework_required'].includes(t.status));
      if (
        live.length &&
        live.every((t) => t.status === 'passed') &&
        ![...this.running.values()].some((r) => r.commissionId === id)
      )
        this.change(
          id,
          'delivery_ready',
          'All tasks independently verified; awaiting user acceptance',
          (s) => {
            s.commission.status = 'awaiting_acceptance';
            s.commission.summary = 'Verified results are ready for acceptance';
          },
        );
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
        const s = this.store.get(id),
          runId = randomUUID();
        this.store.startCall(runId, id, undefined, {
          kind: 'plan',
        });
        let response;
        try {
          response = await complete(
            settings,
            [
              {
                role: 'system',
                content:
                  'You plan real project work, never a fixed demonstration. Use propose_plan to produce a DAG of 2+ tasks across mori and luma. Each criterion must have an author and a different reviewer depending on the author. Review dependencies should use artifact_available when reviewing published files. Use only registered capabilities. Keep graph as small as the goal permits.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  goal: s.commission.goal,
                  criteria: s.commission.criteria,
                  tools: this.options.executor.definitions(),
                  workspace: s.workspace,
                  budget: s.commission.budget,
                }),
              },
            ],
            [planTool],
            signal,
          );
          this.store.endCall(runId, {
            ok: true,
          });
        } catch (e) {
          this.store.endCall(runId, {
            ok: false,
            error: this.safeError(e),
          });
          throw e;
        }
        signal.throwIfAborted();
        const proposal = response.calls.find((c) => c.name === 'propose_plan');
        if (!proposal) throw new Error('Provider did not return a structured plan');
        validateArguments(proposal.args, planTool.parameters);
        const plan = validatePlan(proposal.args.tasks, s.commission.criteria);
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
          s.commission.stepsUsed++;
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
            if (!signal.aborted) {
              s.commission.status = 'paused';
              s.commission.summary = 'A task failed; inspect evidence before resuming';
            }
          },
        );
      }
    });
  }
  private async runTask(id: string, taskId: string, signal: AbortSignal): Promise<void> {
    const initial = this.store.get(id),
      task = initial.tasks.find((t) => t.id === taskId)!;
    let workPath = this.store.taskPath(taskId);
    if (!workPath) {
      workPath = await createTaskWorkspace(initial.workspace, task.id);
      this.store.setTaskPath(taskId, workPath);
    }
    const inputs = initial.artifacts.filter(
      (a) => a.validity === 'current' && task.dependencies.includes(a.taskId),
    );
    for (const a of inputs) {
      const path = resolve(workPath, a.relativePath),
        rel = relative(workPath, path);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid artifact input path');
      await mkdir(dirname(path), {
        recursive: true,
      });
      await writeFile(path, await readArtifact(this.options.dataRoot, a));
    }
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
    const messages: Message[] = [
      {
        role: 'system',
        content: `You are ${task.agentId}, carrying out real work in an isolated task workspace. Use registered tools. All paths are relative to your workspace. Do not claim execution or tests without tool output. Publish actual files with submit_artifact then complete_task. A reviewer must use tools to inspect exact input versions and submit_review with real evidence IDs; insufficient evidence is unable_to_verify. Never approve your own work. User rejections must be respected. Tools may not access runtime state files.`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          goal: initial.commission.goal,
          criteria: initial.commission.criteria,
          task,
          inputs,
          userAnswers: initial.requests.filter((r) => r.taskId === taskId && r.status !== 'open'),
          priorEvidence: initial.evidence.filter((e) => e.taskId === taskId),
          availableArtifacts: initial.artifacts,
        }),
      },
    ];
    const definitions = [
      ...this.options.executor
        .definitions()
        .filter((d) => task.kind !== 'review' || d.effect !== 'write'),
      ...runtimeTools,
    ];
    while (!signal.aborted) {
      const s = this.store.get(id);
      if (s.commission.status !== 'active') return;
      const current = s.tasks.find((t) => t.id === taskId)!;
      if (current.status !== 'running') return;
      if (
        s.commission.stepsUsed >= s.commission.budget.maxSteps ||
        Date.now() - (this.activeSince.get(id) ?? Date.now()) >=
          s.commission.budget.maxMinutes * 60000
      ) {
        this.change(id, 'budget_paused', 'Execution budget reached', (s) => {
          s.commission.status = 'paused';
          s.tasks.find((t) => t.id === taskId)!.status = 'queued';
        });
        return;
      }
      const settings = await this.options.getCredentials();
      if (!settings) throw new Error('Provider is not configured');
      const callId = randomUUID();
      this.store.startCall(callId, id, taskId, {
        kind: 'model',
      });
      this.change(id, 'model_step', 'Agent requested next action', (s) => {
        s.commission.stepsUsed++;
      });
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
          if (runtimeTools.some((t) => t.name === call.name))
            output = await this.runtimeTool(id, taskId, workPath, call);
          else output = await this.executorTool(id, taskId, workPath, call, signal);
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
    const pinned =
      task.kind === 'review'
        ? s.artifacts.filter((a) => task.inputVersions.includes(a.versionId))
        : [];
    const before = await this.pinnedHashes(workPath, pinned);
    this.store.startCall(runId, id, taskId, {
      kind: 'tool',
      name: call.name,
      args: call.args,
    });
    this.change(id, 'tool_started', `Calling ${call.name}`, (s) => {
      s.tasks.find((t) => t.id === taskId)!.step = call.name;
    });
    let output;
    try {
      output = pinned.some((a) => before[a.versionId] !== a.sha256)
        ? {
            ok: false,
            code: 'REVIEW_INPUT_CHANGED',
            output: 'Pinned artifact bytes changed before tool execution',
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
      this.store.endCall(runId, output);
    } catch (e) {
      this.store.endCall(runId, {
        ok: false,
        error: this.safeError(e),
      });
      throw e;
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
        code: 'REVIEW_INPUT_CHANGED',
        output: 'Pinned artifact bytes changed during tool execution',
      };
    const source = call.args.path ?? call.args.source;
    const qualifying = ['workspace_read', 'office_inspect', 'office_verify'].includes(call.name);
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
          }),
          status: unknown ? 'not_run' : output.ok ? 'passed' : 'failed',
          taskId,
          artifactVersionIds:
            task.kind === 'review' ? consumed.map((a) => a.versionId) : task.inputVersions,
          createdAt: now(),
        });
      },
    );
    if (unknown) {
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
          s.requests.push({
            id: randomUUID(),
            commissionId: id,
            taskId,
            kind: 'approval',
            title: interruptedTitle,
            detail: `Call ${runId} (${call.name}) could not confirm its outcome. Inspect the actual process, files and logs. Describe the observed state and approve only after reconciliation.`,
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
    signal.throwIfAborted();
    return {
      ...output,
      evidenceId,
      inputVersionIds: task.inputVersions,
    };
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
      const artifact = await publishArtifact(this.options.dataRoot, workPath, String(a.path), {
        commissionId: id,
        taskId,
        name: String(a.name),
        mediaType: String(a.mediaType),
        inputVersions: task.inputVersions,
      });
      this.change(
        id,
        'artifact_available',
        `Published ${artifact.name}`,
        (s) => {
          const previous = s.artifacts.filter(
            (x) =>
              x.taskId === taskId &&
              x.relativePath === artifact.relativePath &&
              x.validity === 'current',
          );
          invalidateLineage(
            s,
            previous.map((x) => x.versionId),
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
      if (
        ['implement', 'office', 'integrate'].includes(task.kind) &&
        !task.outputArtifactIds.length
      )
        throw new Error('Publish actual deliverables before completion');
      for (const artifact of s.artifacts.filter(
        (a) => a.taskId === taskId && a.validity === 'current',
      )) {
        if (hash(await readFile(resolve(workPath, artifact.relativePath))) !== artifact.sha256)
          throw new Error(
            'Task files changed after publication; publish the current bytes before integrating',
          );
      }
      const changes = await previewTaskWorkspaceChanges(s.workspace, workPath);
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
      const integration = await integrateTaskWorkspace(s.workspace, workPath, changes);
      if (!integration.ok)
        throw new Error(`Integration conflicts: ${integration.conflicts.join(', ')}`);
      this.change(id, 'task_completed', String(a.summary), (s) => {
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
                e.kind === 'review' && e.status === 'passed' && e.artifactVersionIds.includes(v),
            ),
          );
        t.status =
          s.tasks.some((r) => r.kind === 'review' && r.dependencies.includes(taskId)) && !reviewed
            ? 'awaiting_review'
            : 'passed';
        t.step = String(a.summary);
      });
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
            if (['workspace_read', 'office_inspect', 'office_verify'].includes(detail.name))
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
            s.commission.status = 'paused';
            s.commission.summary = 'Rework limit reached';
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
            t.dependencies = t.dependencies.map((dep) => (dep === old.id ? rework.id : dep));
            if (t.dependencyKinds?.[old.id]) {
              t.dependencyKinds[rework.id] = t.dependencyKinds[old.id];
              delete t.dependencyKinds[old.id];
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
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    for (const s of this.store.projects())
      if (s.commission.status === 'active')
        this.change(s.commission.id, 'runtime_closing', 'Runtime is stopping safely', (s) => {
          s.commission.status = 'paused';
        });
    for (const run of this.running.values()) run.controller.abort(new Error('Runtime closing'));
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    this.closed = true;
    this.listeners.clear();
    this.store.close();
  }
}
