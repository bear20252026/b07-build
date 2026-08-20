import { isTaskEvent, type AgentProfileId, type ExecutionAuthorityMode, type InputProvenanceV1, type TaskEvent } from '@awo/protocol';

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
  controlPlaneDiagnostics(): Promise<WorkbenchControlPlaneDiagnostics>;
  securityPostureAudit(): Promise<WorkbenchSecurityPostureReport>;
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
    if (!Array.isArray(payload) || !payload.every(isTaskEvent)) {
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
