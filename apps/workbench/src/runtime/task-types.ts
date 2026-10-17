// 任务相关的**类型**定义（不含传输层）。
//
// 这个文件原本叫 `task-client.ts`，里面既有类型，也有一个走 HTTP 的客户端类
// （`HttpWorkbenchTaskClient`）—— 后者的后端 `apps/runtime-gateway` 在 2026-08-26 被删除，
// 于是它一直在调不存在的端点。
//
// 28 个文件从它导入**类型**（Provider、项目、诊断、安全姿态等都用），所以不能整文件删除。
// 这里只保留类型；传输层已随任务引擎一起移除。
import type { AgentProfileId, ExecutionAuthorityMode, InputProvenanceV1 } from '@awo/protocol';

export type WorkbenchTaskStatus = 'created' | 'running' | 'blocked' | 'completed' | 'failed';
export type WorkbenchNodeOutcome = 'ok' | 'failed' | 'blocked';

export interface WorkbenchRecordedInputProvenance extends InputProvenanceV1 {}

/** 浏览器只可提交外部/派生的 taint 摘要；可信输入由 本机能力服务 内部构造。 */
export type WorkbenchExternalInputProvenance = Omit<InputProvenanceV1, 'trust' | 'sourceKind'> & {
  trust: 'external-untrusted' | 'derived-untrusted';
  sourceKind: 'web' | 'upload' | 'knowledge' | 'tool-output' | 'provider-output';
};

export interface WorkbenchTaskSnapshot {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  profileId: AgentProfileId;
  authorityMode?: ExecutionAuthorityMode;
  inputProvenance?: readonly WorkbenchRecordedInputProvenance[];
  status: WorkbenchTaskStatus;
  nodeOutcomes: Readonly<Record<string, WorkbenchNodeOutcome>>;
  stats?: Readonly<{
    totalNodes: number;
    startedNodes: number;
    completedNodes: number;
    failedNodes: number;
    blockedNodes: number;
    maxObservedConcurrency: number;
  }>;
  attempt: number;
  updatedAt: number;
}

export type WorkbenchAuthorityMode = Exclude<ExecutionAuthorityMode, 'admin'>;

export interface WorkbenchTaskUpload {
  id: string;
  name: string;
  /** 仅在用户发起任务时发送给 loopback 本机能力服务；本机能力服务 重算 SHA-256，不信任浏览器摘要。 */
  contentBase64: string;
}

export interface WorkbenchTaskIntent {
  goal: string;
  profileId: AgentProfileId;
  authorityMode: WorkbenchAuthorityMode;
  /** 每次提交绑定用户在本机界面明确选择的 Provider 会话；不包含地址、密钥、header 或 driver。 */
  modelSelection?: Readonly<{ providerId: string; model?: string }>;
  inputProvenance?: readonly WorkbenchExternalInputProvenance[];
  uploads?: readonly WorkbenchTaskUpload[];
}

export interface WorkbenchLocalModelHealth {
  schemaVersion: 1;
  id: string;
  configuredModelId: string;
  offline: boolean;
  health: Readonly<{
    status: 'unknown' | 'healthy' | 'unhealthy';
    checkedAt?: number;
    probePath?: '/health' | '/v1/models';
    probeMethod?: 'HEAD' | 'GET';
    modelIds: readonly string[];
    error?: string;
  }>;
}

/** 供应商连接 DTO 故意没有 endpoint、API key、token、错误正文或模型输入。 */
export interface WorkbenchProviderConnection {
  schemaVersion: 1;
  providerId: string;
  displayName: string;
  driverId: string;
  defaultModel: string;
  credentialReference: string;
  credentialAvailability: 'available' | 'missing' | 'unsupported-reference';
  profileStatus: 'not-registered' | 'registered' | 'active' | 'disabled' | 'revoked';
  profileRevision?: number;
  canReadSecret: false;
  canAutoConnect: false;
}

export interface WorkbenchProviderConnectionProbe {
  schemaVersion: 1;
  providerId: string;
  outcome: 'reachable' | 'missing-credential' | 'not-registered' | 'not-active' | 'rejected' | 'unreachable';
  checkedAt: number;
  latencyMs?: number;
  canReadSecret: false;
  canAutoConnect: false;
}

/** 当前会话、协议和地址下公开可用的 model id；不含 endpoint、请求头或凭据。 */
export interface WorkbenchProviderModelDiscovery extends WorkbenchProviderConnectionProbe {
  models: readonly string[];
}

/** 实际模型输出仅留在本次 WebView 状态；结果不含请求、endpoint、header、API key 或工具能力。 */
export interface WorkbenchProviderStreamCompletion {
  providerId: string;
  model?: string;
  outputCharacters: number;
}

export interface WorkbenchProviderInference {
  schemaVersion: 1;
  providerId: string;
  profileId: string;
  profileRevision: number;
  model: string;
  dataBoundary: 'remote-allowed';
  output: string;
  outputDigest: string;
  outputCharacters: number;
  latencyMs: number;
  canReadSecret: false;
  canAutoExecuteTools: false;
  canAutoConnect: false;
}

export interface WorkbenchControlPlaneDiagnostics {
  schemaVersion: 1;
  generatedAt: number;
  authority: Readonly<{ adminIssuance: 'trusted-desktop-host-required'; browserCanIssue: false; canExecute: false }>;
  extensions: readonly Readonly<{ id: string; kind: string; status: string; revision: number; dataBoundary: string; declaredCapabilities: readonly string[]; findings: readonly Readonly<{ severity: 'info' | 'warning'; code: string }>[]; canExecute: false }> [];
  skillPacks: readonly Readonly<{ id: string; status: string; revision: number; version: string; estimatedTokens: number; canAuthorize: false; canGrantCapabilities: false }> [];
  providers: readonly Readonly<{ id: string; status: string; revision: number; dataBoundary: string; driverIds: readonly string[] }> [];
  localModels: readonly Readonly<{ id: string; configuredModelId: string; offline: boolean; healthStatus: 'unknown' | 'healthy' | 'unhealthy'; checkedAt?: number; modelIds: readonly string[] }> [];
  trustedDesktopIssuers: readonly Readonly<{ issuerId: string; displayName: string; platform: string; status: string; revision: number; canExecute: false }> [];
  canExecute: false;
}

export interface WorkbenchSecurityFinding {
  checkId: string;
  severity: 'info' | 'warning';
  subjectKind: 'runtime' | 'extension' | 'provider' | 'local-model' | 'trusted-desktop-issuer' | 'recovery' | 'resource-isolation';
  subjectId: string;
  evidenceDigest: string;
  remediationHint: string;
  canExecute: false;
  canAutoRemediate: false;
}

export interface WorkbenchSecurityPostureReport {
  schemaVersion: 1;
  auditId: string;
  auditedAt: number;
  evidenceDigest: string;
  findings: readonly WorkbenchSecurityFinding[];
  canExecute: false;
  canAutoRemediate: false;
}

export interface WorkbenchComponentLockDecision {
  componentId: string;
  componentKind: 'extension' | 'skill-pack' | 'agent-adapter';
  eligibility: 'eligible' | 'quarantined';
  lockRevision?: number;
  reasons: readonly ('missing-provenance' | 'kind-mismatch' | 'version-mismatch' | 'provenance-not-reviewed' | 'provenance-revoked' | 'provenance-digest-mismatch' | 'missing-lockfile' | 'missing-lock-entry' | 'lock-content-digest-mismatch' | 'lock-provenance-digest-mismatch')[];
  canActivate: false;
  canAutoRepair: false;
}

export interface WorkbenchComponentLockReport {
  schemaVersion: 1;
  inspectedAt: number;
  lockfile?: Readonly<{ revision: number; lockDigest: string }>;
  decisions: readonly WorkbenchComponentLockDecision[];
  canActivate: false;
  canAutoRepair: false;
}

export interface WorkbenchWindowsNativeReleaseEvidenceStatus {
  evidenceId: string;
  platform: 'windows';
  architecture: 'x64' | 'x86' | 'arm64' | 'unknown';
  issuerId: string;
  bridgeId: string;
  helperId: string;
  protocolVersion: string;
  authenticodeStatus: 'valid' | 'not-signed' | 'invalid' | 'unknown';
  capturedAt: number;
  canExecute: false;
  canAutoTrust: false;
}

export interface WorkbenchWindowsNativeReleaseReport {
  schemaVersion: 1;
  generatedAt: number;
  platform: 'windows';
  evidences: readonly WorkbenchWindowsNativeReleaseEvidenceStatus[];
  windowsOnly: true;
  browserCanCaptureEvidence: false;
  canRegisterBridge: false;
  canTrustBridge: false;
  canExecute: false;
}

export interface WorkbenchNativeHostBridgeStatus {
  issuerId: string;
  bridgeId: string;
  transport: 'native-messaging' | 'webview2-isolated-host' | 'desktop-ipc';
  status: 'registered' | 'trusted' | 'disabled' | 'revoked';
  revision: number;
  allowedActions: readonly ('register-candidate' | 'verify-digest' | 'review-provenance' | 'record-lockfile' | 'revoke-provenance')[];
  canAuthenticateComponentManagement: true;
  canExecute: false;
}

export interface WorkbenchNativeHostAuthenticationReport {
  schemaVersion: 1;
  generatedAt: number;
  bridges: readonly WorkbenchNativeHostBridgeStatus[];
  challengeSummary: { issued: number; consumedVerified: number; consumedRejected: number; };
  browserCanAuthenticate: false;
  canIssueChallenge: false;
  canExecute: false;
}

export interface WorkbenchComponentManagementReceipt {
  operationId: string;
  issuerId: string;
  action: 'register-candidate' | 'verify-digest' | 'review-provenance' | 'record-lockfile' | 'revoke-provenance';
  componentId: string;
  outcome: 'applied' | 'rejected';
  rejectionCode?: 'attestation-invalid' | 'attestation-expired' | 'issuer-untrusted' | 'operation-replayed' | 'payload-mismatch' | 'precondition-failed';
  recordedAt: number;
  canExecute: false;
  canAutoRemediate: false;
}

export interface WorkbenchComponentManagementReport {
  schemaVersion: 1;
  generatedAt: number;
  receipts: readonly WorkbenchComponentManagementReceipt[];
  browserCanManage: false;
  canExecute: false;
  canAutoRemediate: false;
}

export interface WorkbenchRunTrajectoryEvent {
  schemaVersion: 1;
  trajectoryEventId: string;
  taskId: string;
  runId: string;
  sequence: number;
  at: number;
  source: 'task-runtime' | 'localService.intent' | 'approval';
  kind: string;
  attributes: Readonly<Record<string, string | number | boolean>>;
  canReplaySideEffects: false;
}

/** 受控结果引用的脱敏投影；reference 不是路径、内容或文件读取能力。 */
export interface WorkbenchRunWorkspaceArtifact {
  schemaVersion: 1;
  artifactLedgerId: string;
  sourceEventId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  reference: string;
  referenceDigest: string;
  kind: 'tool-output' | 'declared-artifact';
  status: 'available';
  at: number;
  containsSensitiveContent: false;
  canReplaySideEffects: false;
}

/** 任务快照的不可变 metadata；继续运行仍需用户的既有 resume/approve intent。 */
export interface WorkbenchRunCheckpoint {
  schemaVersion: 1;
  checkpointId: string;
  taskId: string;
  runId: string;
  attempt: number;
  status: WorkbenchTaskStatus;
  nodeOutcomeDigest: string;
  artifactManifestDigest: string;
  artifactCount: number;
  createdAt: number;
  canResume: boolean;
  canReplaySideEffects: false;
}

/** task/run 专属的可审查文件 metadata；不含绝对路径、文件字节、prompt 或凭据。 */
export interface WorkbenchTaskFile {
  schemaVersion: 1;
  taskFileId: string;
  taskId: string;
  runId: string;
  artifactLedgerId: string;
  logicalPath: string;
  displayName: string;
  mediaType: 'text/plain' | 'text/markdown' | 'application/json' | 'text/csv' | 'text/x-source' | 'application/octet-stream';
  byteSize: number;
  sha256: string;
  version: number;
  createdAt: number;
  status: 'available';
  origin: 'generated' | 'user-upload';
  containsSensitiveContent: false;
  canExecute: false;
}

export interface WorkbenchTaskFilePreview {
  taskFileId: string;
  logicalPath: string;
  language: string;
  content: string;
  lineCount: number;
  truncated: boolean;
  byteSize: number;
  sha256: string;
}

export interface WorkbenchTaskFileDiff {
  taskFileId: string;
  logicalPath: string;
  previousVersion: number | undefined;
  currentVersion: number;
  content: string;
  truncated: boolean;
}

export interface WorkbenchTaskDeliveryReceipt {
  schemaVersion: 1;
  deliveryId: string;
  taskId: string;
  runId: string;
  fileCount: number;
  byteSize: number;
  sha256: string;
  createdAt: number;
  status: 'available';
  canAutoExecute: false;
  canAutoExtract: false;
}
