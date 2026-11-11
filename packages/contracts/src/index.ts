/** Shared public boundary. Never expose provider credentials to snapshots. */
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
export type TaskKind = 'investigate' | 'implement' | 'office' | 'review' | 'integrate';
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
  kind: TaskKind;
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
export type CharacterId = 'mori' | 'luma' | 'user';
export interface CharacterModel {
  assetId: string;
  filename: string;
  format: 'glb' | 'gltf';
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
export interface ApplyChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  beforeHash?: string;
  afterHash?: string;
}
export interface ApplyPreview {
  operationId: string;
  changes: ApplyChange[];
  conflicts: string[];
  supported: boolean;
  reason?: string;
}
export interface HostAPI {
  bootstrap(): Promise<Bootstrap>;
  getCharacters?(): Promise<CharacterProfile[]>;
  updateCharacter?(id: CharacterId, patch: CharacterUpdate): Promise<CharacterProfile>;
  importCharacter?(id: CharacterId): Promise<CharacterProfile | null>;
  loadCharacterModel?(assetId: string): Promise<Uint8Array>;
  createWorkspace(input: NewWorkspaceInput): Promise<Workspace>;
  chooseDirectory(): Promise<string | null>;
  submit(input: SubmitInput): Promise<CommandResult>;
  snapshot(commissionId: string): Promise<ProjectSnapshot>;
  control(commissionId: string, action: 'pause' | 'resume' | 'cancel'): Promise<CommandResult>;
  answer(requestId: string, answer: string, approve?: boolean): Promise<CommandResult>;
  revise(
    commissionId: string,
    instruction: string,
    expectedRevision: number,
  ): Promise<CommandResult>;
  accept(commissionId: string, artifactIds: string[]): Promise<CommandResult>;
  artifact(artifactId: string): Promise<ArtifactPreview>;
  openArtifact(artifactId: string): Promise<CommandResult>;
  exportArtifacts(commissionId: string): Promise<CommandResult>;
  prepareApply(commissionId: string): Promise<ApplyPreview>;
  apply(operationId: string): Promise<CommandResult>;
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
