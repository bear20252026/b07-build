import type { AgentProfileId, ExecutionAuthorityMode, InputProvenanceV1, TaskEvent } from '@awo/protocol';
import { isBrowserTaskEvent } from '@awo/protocol/browser';

export type WorkbenchTaskStatus = 'created' | 'running' | 'blocked' | 'completed' | 'failed';
export type WorkbenchNodeOutcome = 'ok' | 'failed' | 'blocked';

export interface WorkbenchRecordedInputProvenance extends InputProvenanceV1 {}

/** 浏览器只可提交外部/派生的 taint 摘要；可信输入由 Gateway 内部构造。 */
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

export interface WorkbenchTaskIntent {
  goal: string;
  profileId: AgentProfileId;
  authorityMode: WorkbenchAuthorityMode;
  inputProvenance?: readonly WorkbenchExternalInputProvenance[];
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

/** 实际模型输出仅留在本次 WebView 状态；结果不含请求、endpoint、header、API key 或工具能力。 */
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
  source: 'task-runtime' | 'gateway.intent' | 'approval';
  kind: string;
  attributes: Readonly<Record<string, string | number | boolean>>;
  canReplaySideEffects: false;
}

/**
 * 浏览器端的唯一运行时入口。该接口故意不暴露节点、工具、审批许可或数据库操作；
 * 它们必须由本地服务端在可信边界内装配。
 */
function createIdempotencyKey(operation: string): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${operation}-${suffix}`;
}

export interface WorkbenchTaskClient {
  submit(intent: WorkbenchTaskIntent): Promise<WorkbenchTaskSnapshot>;
  resume(taskId: string, runId: string): Promise<WorkbenchTaskSnapshot>;
  approve(taskId: string, runId: string, nodeId: string): Promise<WorkbenchTaskSnapshot>;
  snapshot(taskId: string, runId: string): Promise<WorkbenchTaskSnapshot | undefined>;
  events(taskId: string, runId: string): Promise<readonly TaskEvent[]>;
  trajectory(taskId: string, runId: string): Promise<readonly WorkbenchRunTrajectoryEvent[]>;
  localModelHealth(): Promise<readonly WorkbenchLocalModelHealth[]>;
  providerConnections(): Promise<readonly WorkbenchProviderConnection[]>;
  registerProviderConnection(providerId: string, reviewedBy: string, note?: string): Promise<WorkbenchProviderConnection>;
  activateProviderConnection(providerId: string, reviewedBy: string, note?: string): Promise<WorkbenchProviderConnection>;
  probeProviderConnection(providerId: string): Promise<WorkbenchProviderConnectionProbe>;
  inferProviderConnection(providerId: string, prompt: string, model?: string): Promise<WorkbenchProviderInference>;
  controlPlaneDiagnostics(): Promise<WorkbenchControlPlaneDiagnostics>;
  securityPostureAudit(): Promise<WorkbenchSecurityPostureReport>;
  componentLockReport(): Promise<WorkbenchComponentLockReport>;
  componentManagementReport(): Promise<WorkbenchComponentManagementReport>;
  nativeHostAuthenticationReport(): Promise<WorkbenchNativeHostAuthenticationReport>;
  windowsNativeReleaseReport(): Promise<WorkbenchWindowsNativeReleaseReport>;
}

function assertLocalModelHealth(value: unknown): asserts value is WorkbenchLocalModelHealth {
  if (!value || typeof value !== 'object') throw new Error('本地模型健康摘要无效');
  const summary = value as Partial<WorkbenchLocalModelHealth>;
  const health = summary.health;
  if (
    Object.keys(summary).some((key) => !['schemaVersion', 'id', 'configuredModelId', 'offline', 'health'].includes(key))
    || summary.schemaVersion !== 1 || typeof summary.id !== 'string' || typeof summary.configuredModelId !== 'string' || typeof summary.offline !== 'boolean'
    || !health || typeof health !== 'object' || !['unknown', 'healthy', 'unhealthy'].includes(String(health.status))
    || !Array.isArray(health.modelIds) || !health.modelIds.every((id) => typeof id === 'string')
    || (health.checkedAt !== undefined && (!Number.isSafeInteger(health.checkedAt) || health.checkedAt < 0))
    || (health.probePath !== undefined && health.probePath !== '/health' && health.probePath !== '/v1/models')
    || (health.probeMethod !== undefined && health.probeMethod !== 'HEAD' && health.probeMethod !== 'GET')
    || (health.error !== undefined && typeof health.error !== 'string')
  ) throw new Error('本地模型健康摘要返回了不兼容的 metadata contract');
}

function assertProviderConnection(value: unknown): asserts value is WorkbenchProviderConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('供应商连接摘要无效');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => !['schemaVersion', 'providerId', 'displayName', 'driverId', 'defaultModel', 'credentialReference', 'credentialAvailability', 'profileStatus', 'profileRevision', 'canReadSecret', 'canAutoConnect'].includes(key))
    || item.schemaVersion !== 1 || typeof item.providerId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(item.providerId)
    || typeof item.displayName !== 'string' || typeof item.driverId !== 'string' || typeof item.defaultModel !== 'string'
    || typeof item.credentialReference !== 'string' || !/^env\.[a-z][a-z0-9-]{1,63}$/.test(item.credentialReference)
    || !['available', 'missing', 'unsupported-reference'].includes(String(item.credentialAvailability))
    || !['not-registered', 'registered', 'active', 'disabled', 'revoked'].includes(String(item.profileStatus))
    || (item.profileRevision !== undefined && (!Number.isSafeInteger(item.profileRevision) || (item.profileRevision as number) < 1))
    || item.canReadSecret !== false || item.canAutoConnect !== false
  ) throw new Error('供应商连接摘要包含未声明、敏感或可自动连接字段');
}

function assertProviderConnectionProbe(value: unknown): asserts value is WorkbenchProviderConnectionProbe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('供应商连接探测摘要无效');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => !['schemaVersion', 'providerId', 'outcome', 'checkedAt', 'latencyMs', 'canReadSecret', 'canAutoConnect'].includes(key))
    || item.schemaVersion !== 1 || typeof item.providerId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(item.providerId)
    || !['reachable', 'missing-credential', 'not-registered', 'not-active', 'rejected', 'unreachable'].includes(String(item.outcome))
    || !Number.isSafeInteger(item.checkedAt) || (item.checkedAt as number) < 0
    || (item.latencyMs !== undefined && (!Number.isSafeInteger(item.latencyMs) || (item.latencyMs as number) < 0))
    || item.canReadSecret !== false || item.canAutoConnect !== false
  ) throw new Error('供应商连接探测包含未声明、敏感或可自动连接字段');
}

function assertProviderInference(value: unknown): asserts value is WorkbenchProviderInference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('供应商推理结果无效');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => !['schemaVersion', 'providerId', 'profileId', 'profileRevision', 'model', 'dataBoundary', 'output', 'outputDigest', 'outputCharacters', 'latencyMs', 'canReadSecret', 'canAutoExecuteTools', 'canAutoConnect'].includes(key))
    || item.schemaVersion !== 1 || typeof item.providerId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(item.providerId)
    || typeof item.profileId !== 'string' || !/^provider\.[a-z][a-z0-9-]{1,63}$/.test(item.profileId)
    || !Number.isSafeInteger(item.profileRevision) || (item.profileRevision as number) < 1
    || typeof item.model !== 'string' || item.dataBoundary !== 'remote-allowed'
    || typeof item.output !== 'string' || item.output.length > 32_000
    || typeof item.outputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.outputDigest)
    || !Number.isSafeInteger(item.outputCharacters) || item.outputCharacters !== item.output.length
    || !Number.isSafeInteger(item.latencyMs) || (item.latencyMs as number) < 0
    || item.canReadSecret !== false || item.canAutoExecuteTools !== false || item.canAutoConnect !== false
  ) throw new Error('供应商推理结果包含未声明、敏感或可执行字段');
}

function isSafeMetadataArray(value: unknown): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function assertControlPlaneDiagnostics(value: unknown): asserts value is WorkbenchControlPlaneDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('控制面诊断无效');
  const report = value as Record<string, unknown>;
  if (
    Object.keys(report).some((key) => !['schemaVersion', 'generatedAt', 'authority', 'extensions', 'skillPacks', 'providers', 'localModels', 'trustedDesktopIssuers', 'canExecute'].includes(key))
    || report.schemaVersion !== 1 || !Number.isSafeInteger(report.generatedAt) || report.canExecute !== false
    || !report.authority || typeof report.authority !== 'object' || Array.isArray(report.authority)
    || Object.keys(report.authority as object).some((key) => !['adminIssuance', 'browserCanIssue', 'canExecute'].includes(key))
    || (report.authority as Record<string, unknown>).adminIssuance !== 'trusted-desktop-host-required'
    || (report.authority as Record<string, unknown>).browserCanIssue !== false || (report.authority as Record<string, unknown>).canExecute !== false
    || !isSafeMetadataArray(report.extensions) || !isSafeMetadataArray(report.skillPacks) || !isSafeMetadataArray(report.providers)
    || !isSafeMetadataArray(report.localModels) || !isSafeMetadataArray(report.trustedDesktopIssuers)
  ) throw new Error('控制面诊断返回了不兼容或可执行的 metadata contract');
  const safeStringArray = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.every((item) => typeof item === 'string');
  for (const extension of report.extensions) {
    if (Object.keys(extension).some((key) => !['id', 'kind', 'status', 'revision', 'dataBoundary', 'declaredCapabilities', 'findings', 'canExecute'].includes(key))
      || typeof extension.id !== 'string' || typeof extension.kind !== 'string' || typeof extension.status !== 'string' || !Number.isSafeInteger(extension.revision)
      || typeof extension.dataBoundary !== 'string' || !safeStringArray(extension.declaredCapabilities) || !isSafeMetadataArray(extension.findings) || extension.canExecute !== false
      || extension.findings.some((finding) => Object.keys(finding).some((key) => !['severity', 'code'].includes(key)) || !['info', 'warning'].includes(String(finding.severity)) || typeof finding.code !== 'string')) throw new Error('Extension 诊断包含未声明或敏感字段');
  }
  for (const skill of report.skillPacks) {
    if (Object.keys(skill).some((key) => !['id', 'status', 'revision', 'version', 'estimatedTokens', 'canAuthorize', 'canGrantCapabilities'].includes(key))
      || typeof skill.id !== 'string' || typeof skill.status !== 'string' || !Number.isSafeInteger(skill.revision) || typeof skill.version !== 'string'
      || !Number.isSafeInteger(skill.estimatedTokens) || skill.canAuthorize !== false || skill.canGrantCapabilities !== false) throw new Error('Skill Pack 诊断包含未声明或可授权字段');
  }
  for (const provider of report.providers) {
    if (Object.keys(provider).some((key) => !['id', 'status', 'revision', 'dataBoundary', 'driverIds'].includes(key)) || typeof provider.id !== 'string' || typeof provider.status !== 'string' || !Number.isSafeInteger(provider.revision) || typeof provider.dataBoundary !== 'string' || !safeStringArray(provider.driverIds)) throw new Error('Provider 诊断包含未声明或敏感字段');
  }
  for (const model of report.localModels) {
    if (Object.keys(model).some((key) => !['id', 'configuredModelId', 'offline', 'healthStatus', 'checkedAt', 'modelIds'].includes(key)) || typeof model.id !== 'string' || typeof model.configuredModelId !== 'string' || typeof model.offline !== 'boolean' || !['unknown', 'healthy', 'unhealthy'].includes(String(model.healthStatus)) || (model.checkedAt !== undefined && !Number.isSafeInteger(model.checkedAt)) || !safeStringArray(model.modelIds)) throw new Error('本地模型诊断包含未声明或敏感字段');
  }
  for (const issuer of report.trustedDesktopIssuers) {
    if (Object.keys(issuer).some((key) => !['issuerId', 'displayName', 'platform', 'status', 'revision', 'canExecute'].includes(key)) || typeof issuer.issuerId !== 'string' || typeof issuer.displayName !== 'string' || typeof issuer.platform !== 'string' || typeof issuer.status !== 'string' || !Number.isSafeInteger(issuer.revision) || issuer.canExecute !== false) throw new Error('可信桌面 issuer 诊断包含未声明或可执行字段');
  }
}

function assertSecurityPostureAudit(value: unknown): asserts value is WorkbenchSecurityPostureReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('安全态势审计报告无效');
  const report = value as Record<string, unknown>;
  if (
    Object.keys(report).some((key) => !['schemaVersion', 'auditId', 'auditedAt', 'evidenceDigest', 'findings', 'canExecute', 'canAutoRemediate'].includes(key))
    || report.schemaVersion !== 1 || typeof report.auditId !== 'string' || !/^audit:[a-f0-9]{64}$/.test(report.auditId)
    || !Number.isSafeInteger(report.auditedAt) || typeof report.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(report.evidenceDigest)
    || report.canExecute !== false || report.canAutoRemediate !== false || !isSafeMetadataArray(report.findings)
  ) throw new Error('安全态势审计报告返回了不兼容或可执行的 metadata contract');
  for (const finding of report.findings) {
    if (
      Object.keys(finding).some((key) => !['checkId', 'severity', 'subjectKind', 'subjectId', 'evidenceDigest', 'remediationHint', 'canExecute', 'canAutoRemediate'].includes(key))
      || typeof finding.checkId !== 'string' || !/^[a-z][a-z0-9.-]{2,127}$/.test(finding.checkId)
      || !['info', 'warning'].includes(String(finding.severity))
      || !['runtime', 'extension', 'provider', 'local-model', 'trusted-desktop-issuer', 'recovery', 'resource-isolation'].includes(String(finding.subjectKind))
      || typeof finding.subjectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(finding.subjectId)
      || typeof finding.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(finding.evidenceDigest)
      || typeof finding.remediationHint !== 'string' || finding.canExecute !== false || finding.canAutoRemediate !== false
    ) throw new Error('安全态势 finding 包含未声明、敏感或可执行字段');
  }
}

function assertComponentLockReport(value: unknown): asserts value is WorkbenchComponentLockReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('构件锁定报告无效');
  const report = value as Record<string, unknown>;
  const allowedReasons = new Set(['missing-provenance', 'kind-mismatch', 'version-mismatch', 'provenance-not-reviewed', 'provenance-revoked', 'provenance-digest-mismatch', 'missing-lockfile', 'missing-lock-entry', 'lock-content-digest-mismatch', 'lock-provenance-digest-mismatch']);
  const inspectedAt = report.inspectedAt;
  const isNonNegativeSafeInteger = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0;
  const isPositiveSafeInteger = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 1;
  const lockfile = report.lockfile as Record<string, unknown> | undefined;
  const lockRevision = lockfile?.revision;
  const lockDigest = lockfile?.lockDigest;
  if (
    Object.keys(report).some((key) => !['schemaVersion', 'inspectedAt', 'lockfile', 'decisions', 'canActivate', 'canAutoRepair'].includes(key))
    || report.schemaVersion !== 1 || !isNonNegativeSafeInteger(inspectedAt)
    || report.canActivate !== false || report.canAutoRepair !== false || !isSafeMetadataArray(report.decisions)
    || (report.lockfile !== undefined && (!report.lockfile || typeof report.lockfile !== 'object' || Array.isArray(report.lockfile)
      || Object.keys(report.lockfile as object).some((key) => !['revision', 'lockDigest'].includes(key))
      || !isPositiveSafeInteger(lockRevision)
      || typeof lockDigest !== 'string' || !/^[a-f0-9]{64}$/.test(lockDigest)))
  ) throw new Error('构件锁定报告返回了不兼容或可执行的 metadata contract');
  for (const decision of report.decisions) {
    if (
      Object.keys(decision).some((key) => !['componentId', 'componentKind', 'eligibility', 'lockRevision', 'reasons', 'canActivate', 'canAutoRepair'].includes(key))
      || typeof decision.componentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(decision.componentId)
      || !['extension', 'skill-pack', 'agent-adapter'].includes(String(decision.componentKind))
      || !['eligible', 'quarantined'].includes(String(decision.eligibility))
      || (decision.lockRevision !== undefined && (!Number.isSafeInteger(decision.lockRevision) || (decision.lockRevision as number) < 1))
      || !Array.isArray(decision.reasons) || !decision.reasons.every((reason) => typeof reason === 'string' && allowedReasons.has(reason))
      || decision.canActivate !== false || decision.canAutoRepair !== false
    ) throw new Error('构件锁定决策包含未声明、敏感或可执行字段');
  }
}

function assertWindowsNativeReleaseReport(value: unknown): asserts value is WorkbenchWindowsNativeReleaseReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Windows 发布证据摘要无效');
  const report = value as Record<string, unknown>;
  const architectures = new Set(['x64', 'x86', 'arm64', 'unknown']);
  const statuses = new Set(['valid', 'not-signed', 'invalid', 'unknown']);
  const isNonNegativeSafeInteger = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0;
  if (
    Object.keys(report).some((key) => !['schemaVersion', 'generatedAt', 'platform', 'evidences', 'windowsOnly', 'browserCanCaptureEvidence', 'canRegisterBridge', 'canTrustBridge', 'canExecute'].includes(key))
    || report.schemaVersion !== 1 || !isNonNegativeSafeInteger(report.generatedAt) || report.platform !== 'windows' || !isSafeMetadataArray(report.evidences)
    || report.windowsOnly !== true || report.browserCanCaptureEvidence !== false || report.canRegisterBridge !== false || report.canTrustBridge !== false || report.canExecute !== false
  ) throw new Error('Windows 发布证据摘要返回了不兼容或可执行的 metadata contract');
  for (const evidence of report.evidences) {
    if (
      Object.keys(evidence).some((key) => !['evidenceId', 'platform', 'architecture', 'issuerId', 'bridgeId', 'helperId', 'protocolVersion', 'authenticodeStatus', 'capturedAt', 'canExecute', 'canAutoTrust'].includes(key))
      || typeof evidence.evidenceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.evidenceId)
      || evidence.platform !== 'windows'
      || typeof evidence.architecture !== 'string' || !architectures.has(evidence.architecture)
      || typeof evidence.issuerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.issuerId)
      || typeof evidence.bridgeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.bridgeId)
      || typeof evidence.helperId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.helperId)
      || typeof evidence.protocolVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.protocolVersion)
      || typeof evidence.authenticodeStatus !== 'string' || !statuses.has(evidence.authenticodeStatus)
      || !isNonNegativeSafeInteger(evidence.capturedAt) || evidence.canExecute !== false || evidence.canAutoTrust !== false
    ) throw new Error('Windows 发布证据包含未声明、敏感或可执行字段');
  }
}

function assertNativeHostAuthenticationReport(value: unknown): asserts value is WorkbenchNativeHostAuthenticationReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原生宿主认证摘要无效');
  const report = value as Record<string, unknown>;
  const actions = new Set(['register-candidate', 'verify-digest', 'review-provenance', 'record-lockfile', 'revoke-provenance']);
  const transports = new Set(['native-messaging', 'webview2-isolated-host', 'desktop-ipc']);
  const statuses = new Set(['registered', 'trusted', 'disabled', 'revoked']);
  const isNonNegativeSafeInteger = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0;
  const isStringArray = (candidate: unknown): candidate is readonly string[] => Array.isArray(candidate) && candidate.every((item) => typeof item === 'string');
  if (
    Object.keys(report).some((key) => !['schemaVersion', 'generatedAt', 'bridges', 'challengeSummary', 'browserCanAuthenticate', 'canIssueChallenge', 'canExecute'].includes(key))
    || report.schemaVersion !== 1 || !isNonNegativeSafeInteger(report.generatedAt) || !isSafeMetadataArray(report.bridges)
    || !report.challengeSummary || typeof report.challengeSummary !== 'object' || Array.isArray(report.challengeSummary)
    || Object.keys(report.challengeSummary as object).some((key) => !['issued', 'consumedVerified', 'consumedRejected'].includes(key))
    || !isNonNegativeSafeInteger((report.challengeSummary as Record<string, unknown>).issued)
    || !isNonNegativeSafeInteger((report.challengeSummary as Record<string, unknown>).consumedVerified)
    || !isNonNegativeSafeInteger((report.challengeSummary as Record<string, unknown>).consumedRejected)
    || report.browserCanAuthenticate !== false || report.canIssueChallenge !== false || report.canExecute !== false
  ) throw new Error('原生宿主认证摘要返回了不兼容或可执行的 metadata contract');
  for (const bridge of report.bridges) {
    if (
      Object.keys(bridge).some((key) => !['issuerId', 'bridgeId', 'transport', 'status', 'revision', 'allowedActions', 'canAuthenticateComponentManagement', 'canExecute'].includes(key))
      || typeof bridge.issuerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bridge.issuerId)
      || typeof bridge.bridgeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bridge.bridgeId)
      || typeof bridge.transport !== 'string' || !transports.has(bridge.transport)
      || typeof bridge.status !== 'string' || !statuses.has(bridge.status)
      || !isNonNegativeSafeInteger(bridge.revision) || bridge.revision < 1
      || !isStringArray(bridge.allowedActions) || bridge.allowedActions.length === 0 || bridge.allowedActions.some((action) => !actions.has(action))
      || bridge.canAuthenticateComponentManagement !== true || bridge.canExecute !== false
    ) throw new Error('原生宿主认证 bridge 包含未声明、敏感或可执行字段');
  }
}

function assertComponentManagementReport(value: unknown): asserts value is WorkbenchComponentManagementReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('构件管理回执报告无效');
  const report = value as Record<string, unknown>;
  const actions = new Set(['register-candidate', 'verify-digest', 'review-provenance', 'record-lockfile', 'revoke-provenance']);
  const outcomes = new Set(['applied', 'rejected']);
  const rejections = new Set(['attestation-invalid', 'attestation-expired', 'issuer-untrusted', 'operation-replayed', 'payload-mismatch', 'precondition-failed']);
  const isNonNegativeSafeInteger = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0;
  if (
    Object.keys(report).some((key) => !['schemaVersion', 'generatedAt', 'receipts', 'browserCanManage', 'canExecute', 'canAutoRemediate'].includes(key))
    || report.schemaVersion !== 1 || !isNonNegativeSafeInteger(report.generatedAt)
    || report.browserCanManage !== false || report.canExecute !== false || report.canAutoRemediate !== false || !isSafeMetadataArray(report.receipts)
  ) throw new Error('构件管理回执报告返回了不兼容或可执行的 metadata contract');
  for (const receipt of report.receipts) {
    if (
      Object.keys(receipt).some((key) => !['operationId', 'issuerId', 'action', 'componentId', 'outcome', 'rejectionCode', 'recordedAt', 'canExecute', 'canAutoRemediate'].includes(key))
      || typeof receipt.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.operationId)
      || typeof receipt.issuerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.issuerId)
      || typeof receipt.componentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.componentId)
      || typeof receipt.action !== 'string' || !actions.has(receipt.action)
      || typeof receipt.outcome !== 'string' || !outcomes.has(receipt.outcome)
      || (receipt.rejectionCode !== undefined && (typeof receipt.rejectionCode !== 'string' || !rejections.has(receipt.rejectionCode)))
      || !isNonNegativeSafeInteger(receipt.recordedAt) || receipt.canExecute !== false || receipt.canAutoRemediate !== false
    ) throw new Error('构件管理回执包含未声明、敏感或可执行字段');
  }
}

function assertTrajectoryEvent(value: unknown): asserts value is WorkbenchRunTrajectoryEvent {
  if (!value || typeof value !== 'object') throw new Error('运行轨迹包含无效事件');
  const event = value as Partial<WorkbenchRunTrajectoryEvent>;
  if (event.schemaVersion !== 1 || typeof event.trajectoryEventId !== 'string' || typeof event.taskId !== 'string' || typeof event.runId !== 'string' || typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.at !== 'number' || !Number.isSafeInteger(event.at) || !['task-runtime', 'gateway.intent', 'approval'].includes(String(event.source)) || typeof event.kind !== 'string' || !event.attributes || typeof event.attributes !== 'object' || event.canReplaySideEffects !== false) {
    throw new Error('运行轨迹返回了不兼容的 metadata contract');
  }
}

function assertRecordedInputProvenance(value: unknown): asserts value is WorkbenchRecordedInputProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('输入 provenance 摘要无效');
  const input = value as Partial<WorkbenchRecordedInputProvenance>;
  if (
    Object.keys(input).some((key) => !['schemaVersion', 'inputId', 'trust', 'sourceKind', 'contentDigest'].includes(key))
    || input.schemaVersion !== 1 || typeof input.inputId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.inputId)
    || !['operator-authored', 'workspace-controlled', 'external-untrusted', 'derived-untrusted'].includes(String(input.trust))
    || !['operator', 'workspace', 'web', 'upload', 'knowledge', 'tool-output', 'provider-output'].includes(String(input.sourceKind))
    || typeof input.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentDigest)
  ) throw new Error('输入 provenance 返回了不兼容或敏感的 metadata contract');
}

function assertBrowserExternalProvenance(input: WorkbenchExternalInputProvenance): void {
  assertRecordedInputProvenance(input);
  if (!['external-untrusted', 'derived-untrusted'].includes(input.trust)) throw new Error('浏览器不得提交可信输入 provenance');
  if ((input.trust === 'external-untrusted' && !['web', 'upload', 'knowledge'].includes(input.sourceKind)) || (input.trust === 'derived-untrusted' && !['tool-output', 'provider-output', 'knowledge'].includes(input.sourceKind))) {
    throw new Error('浏览器 provenance 的 trust/sourceKind 不匹配');
  }
}

function assertSnapshot(value: unknown): asserts value is WorkbenchTaskSnapshot {
  if (!value || typeof value !== 'object') throw new Error('任务服务返回了无效快照');
  const snapshot = value as Partial<WorkbenchTaskSnapshot>;
  if (
    Object.keys(snapshot).some((key) => !['schemaVersion', 'taskId', 'runId', 'profileId', 'authorityMode', 'inputProvenance', 'status', 'nodeOutcomes', 'stats', 'attempt', 'updatedAt'].includes(key))
    || snapshot.schemaVersion !== 1 || typeof snapshot.taskId !== 'string' || typeof snapshot.runId !== 'string' || !['build', 'plan', 'explore', 'reader'].includes(String(snapshot.profileId))
    || (snapshot.authorityMode !== undefined && !['plan', 'review', 'automate', 'admin'].includes(String(snapshot.authorityMode)))
    || (snapshot.inputProvenance !== undefined && (!Array.isArray(snapshot.inputProvenance) || !snapshot.inputProvenance.every((input) => { try { assertRecordedInputProvenance(input); return true; } catch { return false; } })))
  ) {
    throw new Error('任务服务返回了不兼容的快照版本');
  }
  if (!['created', 'running', 'blocked', 'completed', 'failed'].includes(String(snapshot.status))) {
    throw new Error('任务服务返回了未知任务状态');
  }
  if (!snapshot.nodeOutcomes || typeof snapshot.nodeOutcomes !== 'object') {
    throw new Error('任务服务快照缺少节点状态');
  }
}

export class HttpWorkbenchTaskClient implements WorkbenchTaskClient {
  constructor(
    private readonly baseUrl = '/api/tasks',
    private readonly localModelHealthUrl = '/api/local-models/health',
    private readonly controlPlaneDiagnosticUrl = '/api/control-plane/diagnostics',
    private readonly securityPostureAuditUrl = '/api/security-posture/audit',
    private readonly componentLockReportUrl = '/api/components/lock-report',
    private readonly componentManagementReportUrl = '/api/components/management-receipts',
    private readonly nativeHostAuthenticationReportUrl = '/api/native-host-authentication',
    private readonly windowsNativeReleaseReportUrl = '/api/windows/native-release-evidence',
    private readonly providerConnectionsUrl = '/api/providers/connections',
  ) {}

  async submit(intent: WorkbenchTaskIntent): Promise<WorkbenchTaskSnapshot> {
    const inputProvenance = intent.inputProvenance ?? [];
    if (inputProvenance.length > 16) throw new Error('浏览器最多可提交 16 条 external/derived provenance 摘要');
    inputProvenance.forEach(assertBrowserExternalProvenance);
    if (new Set(inputProvenance.map((input) => input.inputId)).size !== inputProvenance.length) throw new Error('浏览器 provenance inputId 不可重复');
    return this.request('', {
      method: 'POST',
      body: JSON.stringify({ schemaVersion: 1, ...intent, inputProvenance }),
      headers: { 'idempotency-key': createIdempotencyKey('submit') },
    });
  }

  async resume(taskId: string, runId: string): Promise<WorkbenchTaskSnapshot> {
    return this.request(`/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      headers: { 'idempotency-key': createIdempotencyKey('resume') },
    });
  }

  async approve(taskId: string, runId: string, nodeId: string): Promise<WorkbenchTaskSnapshot> {
    return this.request(
      `/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(nodeId)}`,
      { method: 'POST', headers: { 'idempotency-key': createIdempotencyKey('approve') } },
    );
  }

  async events(taskId: string, runId: string): Promise<readonly TaskEvent[]> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/events`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(await response.text() || `任务事件请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || !payload.every(isBrowserTaskEvent)) {
      throw new Error('任务服务返回了无效事件流');
    }
    return payload;
  }

  async trajectory(taskId: string, runId: string): Promise<readonly WorkbenchRunTrajectoryEvent[]> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/trajectory`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(await response.text() || `运行轨迹请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('运行轨迹返回了无效列表');
    payload.forEach(assertTrajectoryEvent);
    return [...payload].sort((left, right) => left.sequence - right.sequence);
  }

  async localModelHealth(): Promise<readonly WorkbenchLocalModelHealth[]> {
    const response = await fetch(this.localModelHealthUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `本地模型健康请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('本地模型健康返回了无效列表');
    payload.forEach(assertLocalModelHealth);
    return [...payload].sort((left, right) => left.id.localeCompare(right.id));
  }

  async providerConnections(): Promise<readonly WorkbenchProviderConnection[]> {
    const response = await fetch(this.providerConnectionsUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `供应商连接读取失败 (${response.status})`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('供应商连接返回了无效列表');
    payload.forEach(assertProviderConnection);
    return [...payload].sort((left, right) => left.displayName.localeCompare(right.displayName) || left.providerId.localeCompare(right.providerId));
  }

  async registerProviderConnection(providerId: string, reviewedBy: string, note?: string): Promise<WorkbenchProviderConnection> {
    return this.providerConnectionMutation(providerId, 'register', reviewedBy, note);
  }

  async activateProviderConnection(providerId: string, reviewedBy: string, note?: string): Promise<WorkbenchProviderConnection> {
    return this.providerConnectionMutation(providerId, 'activate', reviewedBy, note);
  }

  async probeProviderConnection(providerId: string): Promise<WorkbenchProviderConnectionProbe> {
    const response = await fetch(`${this.providerConnectionsUrl}/${encodeURIComponent(providerId)}/probe`, {
      method: 'POST', headers: { accept: 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' },
    });
    if (!response.ok) throw new Error(await response.text() || `供应商连接探测失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertProviderConnectionProbe(payload);
    return payload;
  }

  async inferProviderConnection(providerId: string, prompt: string, model?: string): Promise<WorkbenchProviderInference> {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(providerId) || !prompt.trim() || prompt.trim().length > 24_000) throw new Error('供应商或 prompt 无效');
    if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(model)) throw new Error('模型标识无效');
    const response = await fetch(`${this.providerConnectionsUrl}/${encodeURIComponent(providerId)}/infer`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1', 'idempotency-key': createIdempotencyKey('provider-infer') },
      body: JSON.stringify({ prompt: prompt.trim(), ...(model?.trim() ? { model: model.trim() } : {}) }),
    });
    if (!response.ok) throw new Error(await response.text() || `供应商推理失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertProviderInference(payload);
    return payload;
  }

  async controlPlaneDiagnostics(): Promise<WorkbenchControlPlaneDiagnostics> {
    const response = await fetch(this.controlPlaneDiagnosticUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `控制面诊断请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertControlPlaneDiagnostics(payload);
    return payload;
  }

  async securityPostureAudit(): Promise<WorkbenchSecurityPostureReport> {
    const response = await fetch(this.securityPostureAuditUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `安全态势审计请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertSecurityPostureAudit(payload);
    return payload;
  }

  async componentLockReport(): Promise<WorkbenchComponentLockReport> {
    const response = await fetch(this.componentLockReportUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `构件锁定报告请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertComponentLockReport(payload);
    return { ...payload, decisions: [...payload.decisions].sort((left, right) => left.componentId.localeCompare(right.componentId)) };
  }

  async windowsNativeReleaseReport(): Promise<WorkbenchWindowsNativeReleaseReport> {
    const response = await fetch(this.windowsNativeReleaseReportUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `Windows 发布证据摘要请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertWindowsNativeReleaseReport(payload);
    return { ...payload, evidences: [...payload.evidences].sort((left, right) => right.capturedAt - left.capturedAt || left.evidenceId.localeCompare(right.evidenceId)) };
  }

  async nativeHostAuthenticationReport(): Promise<WorkbenchNativeHostAuthenticationReport> {
    const response = await fetch(this.nativeHostAuthenticationReportUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `原生宿主认证摘要请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertNativeHostAuthenticationReport(payload);
    return { ...payload, bridges: [...payload.bridges].sort((left, right) => left.issuerId.localeCompare(right.issuerId) || left.bridgeId.localeCompare(right.bridgeId)) };
  }

  async componentManagementReport(): Promise<WorkbenchComponentManagementReport> {
    const response = await fetch(this.componentManagementReportUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `构件管理回执报告请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertComponentManagementReport(payload);
    return { ...payload, receipts: [...payload.receipts].sort((left, right) => right.recordedAt - left.recordedAt || left.operationId.localeCompare(right.operationId)) };
  }

  async snapshot(taskId: string, runId: string): Promise<WorkbenchTaskSnapshot | undefined> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}`, {
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(await response.text() || `任务服务请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertSnapshot(payload);
    return payload;
  }

  private async providerConnectionMutation(providerId: string, operation: 'register' | 'activate', reviewedBy: string, note?: string): Promise<WorkbenchProviderConnection> {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(providerId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reviewedBy)) throw new Error('供应商或审核人标识无效');
    const response = await fetch(`${this.providerConnectionsUrl}/${encodeURIComponent(providerId)}/${operation}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1', 'idempotency-key': createIdempotencyKey(`provider-${operation}`) },
      body: JSON.stringify({ reviewedBy, ...(note?.trim() ? { note: note.trim() } : {}) }),
    });
    if (!response.ok) throw new Error(await response.text() || `供应商连接${operation}失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertProviderConnection(payload);
    return payload;
  }

  private async request(path: string, init: RequestInit): Promise<WorkbenchTaskSnapshot> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
    });
    if (!response.ok) throw new Error(await response.text() || `任务服务请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    assertSnapshot(payload);
    return payload;
  }
}
