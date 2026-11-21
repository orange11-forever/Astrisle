/** Shared public boundary. Never expose provider credentials to snapshots. */
export { isSearchEndpoint, isSourceHostname } from './web-research';

export type CommissionStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'awaiting_acceptance'
  | 'accepted'
  | 'cancelling'
  | 'cancelled'
  | 'failed';
export type TaskStatus =
  | 'queued'
  | 'waiting_dependency'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'awaiting_review'
  | 'rework_required'
  | 'passed'
  | 'failed'
  | 'cancelled';
export type TaskKind = 'investigate' | 'implement' | 'review' | 'integrate';
export interface Workspace {
  id: string;
  name: string;
  sourcePath: string;
  workPath: string;
  createdAt: string;
}
export interface Scope {
  readRoots: string[];
  writeRoots: string[];
  allowProcess: boolean;
  allowNetwork: boolean;
  allowedHosts: string[];
  /** Explicit permission to send search terms to this SearXNG service. */
  searchEndpoint?: string;
}
export interface Budget {
  maxSteps: number;
  maxMinutes: number;
  maxRework: number;
}
export interface Criterion {
  id: string;
  description: string;
}
export interface AgentIdentity {
  id: string;
  name: string;
  temperament: 'explorer' | 'organizer';
}
export interface TaskInput {
  taskId: string;
  artifactId?: string;
  versionId?: string;
}
export interface Task {
  id: string;
  commissionId: string;
  agentId: string;
  title: string;
  description: string;
  /** Older saved commissions can still contain a retired Office task. */
  kind: TaskKind | 'office';
  replacesTaskId?: string;
  artifactRework?: Pick<
    ArtifactReworkInput,
    'artifactId' | 'versionId' | 'instruction' | 'requestId'
  > & { renderedVersionIds?: string[] };
  status: TaskStatus;
  dependencies: string[];
  criterionIds: string[];
  dependencyKinds?: Record<string, 'artifact_available' | 'task_passed'>;
  inputVersions: string[];
  outputArtifactIds: string[];
  step: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export interface Evidence {
  id: string;
  kind: 'tool' | 'test' | 'review' | 'render' | 'note';
  summary: string;
  detail: string;
  status: 'passed' | 'failed' | 'not_run';
  taskId?: string;
  artifactVersionIds: string[];
  createdAt: string;
}
export interface Artifact {
  id: string;
  versionId: string;
  previousVersionId?: string;
  renderedFromVersionId?: string;
  /** Final URLs and the author's original read receipts for this version. */
  webSources?: { url: string; evidenceId: string }[];
  commissionId: string;
  taskId: string;
  name: string;
  relativePath: string;
  mediaType: string;
  sha256: string;
  size: number;
  createdAt: string;
  inputVersions: string[];
  validity: 'current' | 'stale' | 'missing';
}
export interface ProjectEvent {
  id: string;
  commissionId: string;
  sequence: number;
  type: string;
  message: string;
  taskId?: string;
  agentId?: string;
  artifactVersionId?: string;
  createdAt: string;
}
export interface UserRequest {
  id: string;
  commissionId: string;
  taskId?: string;
  kind: 'input' | 'approval';
  title: string;
  detail: string;
  status: 'open' | 'answered' | 'rejected';
  answer?: string;
  createdAt: string;
}
export interface Commission {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  status: CommissionStatus;
  criteria: Criterion[];
  scope: Scope;
  budget: Budget;
  revision: number;
  planningMode: 'auto' | 'review_first';
  stepsUsed: number;
  /** Cumulative active wall time; absent on snapshots created before budget accounting. */
  activeMilliseconds?: number;
  /** Budget edits do not change the requirements revision. */
  budgetRevision?: number;
  createdAt: string;
  updatedAt: string;
  acceptedArtifactIds: string[];
  summary: string;
}
export interface ProjectSnapshot {
  commission: Commission;
  workspace: Workspace;
  agents: AgentIdentity[];
  tasks: Task[];
  artifacts: Artifact[];
  evidence: Evidence[];
  events: ProjectEvent[];
  requests: UserRequest[];
  lastSequence: number;
  applyOperations?: ApplyOperation[];
}
export type ProviderKind = 'openai-compatible' | 'openai-responses' | 'anthropic' | 'gemini';
export interface ProviderSettings {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  configured: boolean;
}
export interface ProviderInput {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
}
export interface Capability {
  id: string;
  name: string;
  available: boolean;
  detail: string;
}
export type CharacterId = 'mori' | 'luma' | 'user' | `partner-${string}`;
export function isValidCharacterName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && [...name].length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(name);
}
export interface CharacterModel {
  assetId: string;
  filename: string;
  format: 'glb' | 'gltf' | '3mf' | 'stl' | 'obj' | 'fbx';
  byteLength: number;
  triangleCount: number;
  animationCount: number;
  hasSkins: boolean;
}
export interface CharacterProfile {
  id: CharacterId;
  displayName: string;
  model?: CharacterModel;
  /** Changes only after a successful import, including repair of the same content hash. */
  modelRevision?: number;
  rotationY?: 0 | 90 | 180 | 270;
}
export interface CharacterUpdate {
  displayName?: string;
  resetModel?: boolean;
  rotationY?: 0 | 90 | 180 | 270;
}
export interface CharacterImportInspection {
  triangleCount: number;
  animationCount: number;
  hasSkins: boolean;
}
export interface PendingCharacterImport {
  importId: string;
  bytes: Uint8Array;
}
export const DEFAULT_CHARACTERS: readonly CharacterProfile[] = [
  { id: 'mori', displayName: 'Mori' },
  { id: 'luma', displayName: 'Luma' },
  { id: 'user', displayName: '我' },
];
export interface Bootstrap {
  workspaces: Workspace[];
  commissions: Commission[];
  provider: ProviderSettings;
  capabilities: Capability[];
  version: string;
  characters?: CharacterProfile[];
}
export interface NewWorkspaceInput {
  name: string;
  sourcePath?: string;
}
export interface SubmitInput {
  requestId: string;
  workspaceId: string;
  goal: string;
  criteria: string[];
  scope: Scope;
  budget: Budget;
  planningMode: 'auto' | 'review_first';
}
export interface CommandResult {
  ok: boolean;
  code?: string;
  message: string;
  commissionId?: string;
  requestId?: string;
}
export interface ArtifactPreview {
  artifact: Artifact;
  content?: string;
  format: 'text' | 'binary';
}
export const PARTNER_DIALOGUE_LIMITS = { question: 1200, answer: 4000, history: 4 } as const;
export const PARTNER_DIALOGUE_ERRORS = {
  invalid_partner_dialogue: '请选择委托和伙伴，问题最多 1200 字符，历史对话最多四轮。',
  commission_not_found: '找不到这份委托。',
  partner_unavailable: '这位伙伴不在这份委托的伙伴名单中。',
  provider_missing: '请先在设置中配置模型。',
  provider_error: '连接模型失败，请检查模型配置后重试。',
  partner_reply_invalid: '模型未返回可核对的回答，请重试。',
  partner_dialogue_timeout: '伙伴回答超时，请重试。',
  runtime_closing: '工作运行时正在关闭，伙伴对话已取消。',
} as const;
export interface PartnerDialogueTurn {
  question: string;
  answer: string;
}
export interface PartnerDialogueInput {
  commissionId: string;
  partnerId: string;
  question: string;
  history?: PartnerDialogueTurn[];
}
export interface PartnerDialogueReference {
  kind: 'commission' | 'task' | 'artifact' | 'evidence';
  /** Commission ID, task ID, immutable artifact version ID, or evidence ID. */
  id: string;
  label: string;
}
export interface PartnerDialogueReply {
  answer: string;
  references: PartnerDialogueReference[];
}
export interface ArtifactReworkInput {
  commissionId: string;
  artifactId: string;
  versionId: string;
  revision: number;
  instruction: string;
  requestId: string;
}
export type SourceExportFormat = 'docx' | 'pptx' | 'xlsx';
export function findArtifactVersion(
  snapshot: ProjectSnapshot,
  versionId: string,
): Artifact | undefined {
  const matches = snapshot.artifacts.filter(
    (entry) => entry.commissionId === snapshot.commission.id && entry.versionId === versionId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export interface SourceExportInput {
  commissionId: string;
  versionId: string;
  format: SourceExportFormat;
}
export function sourceExportFormats(relativePath: string): readonly SourceExportFormat[] {
  if (/\.(md|markdown)$/i.test(relativePath)) return ['docx', 'pptx'];
  if (/\.(csv|tsv)$/i.test(relativePath)) return ['xlsx'];
  return [];
}
export interface ArtifactComparisonInput {
  commissionId: string;
  fromVersionId: string;
  toVersionId: string;
}
export interface ArtifactDiffLine {
  kind: 'context' | 'addition' | 'deletion';
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface ArtifactDiffHunk {
  lines: ArtifactDiffLine[];
}
export interface ArtifactComparison {
  from: Artifact;
  to: Artifact;
  kind: 'unchanged' | 'text' | 'binary' | 'unavailable';
  hunks: ArtifactDiffHunk[];
  truncated: boolean;
  reason?:
    | 'missing-version'
    | 'read-failed'
    | 'integrity-mismatch'
    | 'input-limit'
    | 'line-limit'
    | 'work-limit'
    | 'output-limit'
    | 'text-normalization';
}
export interface ApplyChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  beforeHash?: string;
  afterHash?: string;
  beforeText?: string;
  afterText?: string;
  binary?: boolean;
  truncated?: boolean;
}
export interface ApplyPreview {
  operationId: string;
  changes: ApplyChange[];
  conflicts: string[];
  supported: boolean;
  reason?: string;
  sourcePath?: string;
  mode?: 'apply' | 'rollback';
  expiresAt?: string;
}
export type ApplyStatus =
  | 'prepared'
  | 'applying'
  | 'applied'
  | 'rolling_back'
  | 'rolled_back'
  | 'interrupted'
  | 'conflict'
  | 'unknown';
export interface ApplyFileState {
  path: string;
  state: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  currentHash?: string | null;
  message?: string;
}
export interface ApplyOperation {
  operationId: string;
  commissionId: string;
  workspaceId: string;
  sourcePath: string;
  status: ApplyStatus;
  createdAt: string;
  updatedAt: string;
  message: string;
  files: ApplyFileState[];
  conflicts: string[];
  canRollback: boolean;
}
export interface HostAPI {
  bootstrap(): Promise<Bootstrap>;
  getCharacters?(): Promise<CharacterProfile[]>;
  createCharacter?(displayName: string): Promise<CharacterProfile>;
  updateCharacter?(id: CharacterId, patch: CharacterUpdate): Promise<CharacterProfile>;
  importCharacter?(id: CharacterId): Promise<CharacterProfile | null>;
  prepareCharacterImport?(id: CharacterId): Promise<PendingCharacterImport | null>;
  completeCharacterImport?(
    id: CharacterId,
    importId: string,
    inspection: CharacterImportInspection,
  ): Promise<CharacterProfile>;
  cancelCharacterImport?(importId: string): Promise<void>;
  loadCharacterModel?(assetId: string): Promise<Uint8Array>;
  createWorkspace(input: NewWorkspaceInput): Promise<Workspace>;
  chooseDirectory(): Promise<string | null>;
  submit(input: SubmitInput): Promise<CommandResult>;
  snapshot(commissionId: string): Promise<ProjectSnapshot>;
  askPartner?(input: PartnerDialogueInput): Promise<PartnerDialogueReply>;
  control(commissionId: string, action: 'pause' | 'resume' | 'cancel'): Promise<CommandResult>;
  updateBudget(
    commissionId: string,
    budget: Budget,
    expectedBudgetRevision: number,
  ): Promise<CommandResult>;
  answer(requestId: string, answer: string, approve?: boolean): Promise<CommandResult>;
  revise(
    commissionId: string,
    instruction: string,
    expectedRevision: number,
  ): Promise<CommandResult>;
  accept(commissionId: string, artifactIds: string[]): Promise<CommandResult>;
  artifact(artifactId: string): Promise<ArtifactPreview>;
  compareArtifacts(input: ArtifactComparisonInput): Promise<ArtifactComparison>;
  requestArtifactRework(input: ArtifactReworkInput): Promise<CommandResult>;
  exportSourceArtifact(input: SourceExportInput): Promise<CommandResult>;
  openArtifact(artifactId: string): Promise<CommandResult>;
  exportArtifacts(commissionId: string): Promise<CommandResult>;
  prepareApply(commissionId: string): Promise<ApplyPreview>;
  apply(operationId: string): Promise<CommandResult>;
  inspectApply?(operationId: string): Promise<ApplyOperation>;
  prepareRollback?(operationId: string): Promise<ApplyPreview>;
  openApplyBackups?(operationId: string): Promise<CommandResult>;
  saveProvider(input: ProviderInput): Promise<ProviderSettings>;
  testProvider(): Promise<CommandResult>;
  onSnapshot(listener: (snapshot: ProjectSnapshot) => void): () => void;
}
export interface ToolContext {
  commissionId: string;
  taskId: string;
  runId: string;
  workPath: string;
  scope: Scope;
  signal: AbortSignal;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: 'read' | 'write' | 'process' | 'network';
}
export interface ToolResult {
  ok: boolean;
  output: string;
  files?: string[];
  code?: string;
  metadata?: Record<string, unknown>;
}
export interface ToolExecutor {
  definitions(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  capabilities(): Promise<Capability[]>;
}
export interface RuntimeOptions {
  dataRoot: string;
  executor: ToolExecutor;
  getCredentials: () => Promise<(ProviderInput & { apiKey: string }) | null>;
  applyHelperPath?: string;
}
export interface ModelTaskProposal {
  key: string;
  title: string;
  description: string;
  kind: TaskKind;
  agentId: string;
  dependencies: string[];
  dependencyKinds?: Record<string, 'artifact_available' | 'task_passed'>;
  criterionIds: string[];
}
declare global {
  interface Window {
    astrisle?: HostAPI;
  }
}
