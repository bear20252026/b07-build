import { createHash } from 'node:crypto';

export const SECURITY_POSTURE_AUDIT_SCHEMA_VERSION = 1 as const;

export type SecurityFindingSeverity = 'info' | 'warning';
export type SecuritySubjectKind = 'runtime' | 'extension' | 'provider' | 'local-model' | 'trusted-desktop-issuer' | 'recovery' | 'resource-isolation';

export interface SecurityAuditExtensionEvidence {
  id: string;
  status: string;
  findingCodes: readonly string[];
}

export interface SecurityAuditProviderEvidence {
  id: string;
  status: string;
  dataBoundary: string;
}

export interface SecurityAuditLocalModelEvidence {
  id: string;
  offline: boolean;
  healthStatus: 'unknown' | 'healthy' | 'unhealthy';
}

export interface SecurityAuditIssuerEvidence {
  issuerId: string;
  status: string;
}

/** 审计只允许冷路径 metadata；禁止将 URL、路径、凭据、理由、命令或原文放入 evidence。 */
export interface SecurityPostureEvidenceV1 {
  schemaVersion: typeof SECURITY_POSTURE_AUDIT_SCHEMA_VERSION;
  taintGateEnforced: boolean;
  extensions: readonly SecurityAuditExtensionEvidence[];
  providers: readonly SecurityAuditProviderEvidence[];
  localModels: readonly SecurityAuditLocalModelEvidence[];
  trustedDesktopIssuers: readonly SecurityAuditIssuerEvidence[];
  recovery: Readonly<{ latestDrillAt?: number; quickCheckOk: boolean }>;
  resourceIsolation: Readonly<{ requested: boolean; enforced: boolean }>;
}

export interface SecurityFindingV1 {
  checkId: string;
  severity: SecurityFindingSeverity;
  subjectKind: SecuritySubjectKind;
  subjectId: string;
  evidenceDigest: string;
  remediationHint: string;
  canExecute: false;
  canAutoRemediate: false;
}

export interface SecurityPostureReportV1 {
  schemaVersion: typeof SECURITY_POSTURE_AUDIT_SCHEMA_VERSION;
  auditId: string;
  auditedAt: number;
  evidenceDigest: string;
  findings: readonly SecurityFindingV1[];
  canExecute: false;
  canAutoRemediate: false;
}

export interface SecurityPostureAuditStore {
  append(report: SecurityPostureReportV1): void;
  latest(auditId: string): SecurityPostureReportV1 | undefined;
  list(): readonly SecurityPostureReportV1[];
  close?(): void;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS = /^[a-z][a-z0-9-]{0,63}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertStatus(value: string, label: string): void {
  if (!STATUS.test(value)) throw new Error(`${label} 必须是受限的小写状态值`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function copyFinding(finding: SecurityFindingV1): SecurityFindingV1 {
  return { ...finding };
}

function copyReport(report: SecurityPostureReportV1): SecurityPostureReportV1 {
  return { ...report, findings: report.findings.map(copyFinding) };
}

function normalizedEvidence(evidence: SecurityPostureEvidenceV1): SecurityPostureEvidenceV1 {
  if (evidence.schemaVersion !== SECURITY_POSTURE_AUDIT_SCHEMA_VERSION) throw new Error('SecurityPostureEvidenceV1 版本不兼容');
  const duplicate = (items: readonly { id?: string; issuerId?: string }[], field: 'id' | 'issuerId'): boolean => new Set(items.map((item) => item[field])).size !== items.length;
  if (duplicate(evidence.extensions, 'id') || duplicate(evidence.providers, 'id') || duplicate(evidence.localModels, 'id') || duplicate(evidence.trustedDesktopIssuers, 'issuerId')) {
    throw new Error('Security Posture evidence subject 不可重复');
  }
  for (const extension of evidence.extensions) {
    assertIdentifier(extension.id, 'extension.id');
    assertStatus(extension.status, 'extension.status');
    if (extension.findingCodes.some((code) => !/^[A-Z][A-Z0-9_]{1,95}$/.test(code))) throw new Error('extension.findingCodes 无效');
  }
  for (const provider of evidence.providers) {
    assertIdentifier(provider.id, 'provider.id');
    assertStatus(provider.status, 'provider.status');
    assertStatus(provider.dataBoundary, 'provider.dataBoundary');
  }
  for (const model of evidence.localModels) {
    assertIdentifier(model.id, 'localModel.id');
    if (!['unknown', 'healthy', 'unhealthy'].includes(model.healthStatus)) throw new Error('localModel.healthStatus 无效');
  }
  for (const issuer of evidence.trustedDesktopIssuers) {
    assertIdentifier(issuer.issuerId, 'issuer.issuerId');
    assertStatus(issuer.status, 'issuer.status');
  }
  if (evidence.recovery.latestDrillAt !== undefined) assertEpoch(evidence.recovery.latestDrillAt, 'recovery.latestDrillAt');
  const sorted: SecurityPostureEvidenceV1 = {
    schemaVersion: SECURITY_POSTURE_AUDIT_SCHEMA_VERSION,
    taintGateEnforced: evidence.taintGateEnforced,
    extensions: evidence.extensions.map((extension) => ({ ...extension, findingCodes: [...extension.findingCodes].sort() })).sort((left, right) => left.id.localeCompare(right.id)),
    providers: evidence.providers.map((provider) => ({ ...provider })).sort((left, right) => left.id.localeCompare(right.id)),
    localModels: evidence.localModels.map((model) => ({ ...model })).sort((left, right) => left.id.localeCompare(right.id)),
    trustedDesktopIssuers: evidence.trustedDesktopIssuers.map((issuer) => ({ ...issuer })).sort((left, right) => left.issuerId.localeCompare(right.issuerId)),
    recovery: { ...evidence.recovery },
    resourceIsolation: { ...evidence.resourceIsolation },
  };
  return sorted;
}

function createFinding(
  checkId: string,
  severity: SecurityFindingSeverity,
  subjectKind: SecuritySubjectKind,
  subjectId: string,
  evidence: unknown,
  remediationHint: string,
): SecurityFindingV1 {
  assertIdentifier(subjectId, 'finding.subjectId');
  return {
    checkId,
    severity,
    subjectKind,
    subjectId,
    evidenceDigest: sha256(JSON.stringify(evidence)),
    remediationHint,
    canExecute: false,
    canAutoRemediate: false,
  };
}

/**
 * 纯审计服务：只把现有 metadata 归纳为 finding，绝不调用 activate/probe/issue/create/restore/run 等动作。
 * 同一 evidence 会得到相同 auditId、evidenceDigest 和 finding 顺序，从而支持安全地重新审查。
 */
export class SecurityPostureAuditService {
  inspect(input: SecurityPostureEvidenceV1, now = Date.now()): SecurityPostureReportV1 {
    assertEpoch(now, 'auditedAt');
    const evidence = normalizedEvidence(input);
    const evidenceDigest = sha256(JSON.stringify(evidence));
    const findings: SecurityFindingV1[] = [];
    if (!evidence.taintGateEnforced) {
      findings.push(createFinding('input.provenance.taint-gate-required', 'warning', 'runtime', 'task-runtime', { taintGateEnforced: false }, '在 Profile/Authority 之后恢复 TaintAwareCapabilityPolicy；不要用审批或租约覆盖 deny。'));
    }
    for (const extension of evidence.extensions) {
      if (!['reviewed', 'installed', 'disabled'].includes(extension.status) || extension.findingCodes.length > 0) {
        findings.push(createFinding('extensions.unreviewed-or-revoked', 'warning', 'extension', extension.id, extension, '审查 manifest、来源和 doctor finding；不要加载、修复或重新激活构件。'));
      }
    }
    const activeProviders = evidence.providers.filter((provider) => provider.status === 'active');
    if (activeProviders.length === 0) {
      findings.push(createFinding('providers.active-missing', 'warning', 'provider', 'provider-control-plane', { activeProviders: 0 }, '登记并审查符合任务数据边界的 Provider Profile；审计不会连接任何 Provider。'));
    }
    for (const provider of activeProviders) {
      if (provider.dataBoundary !== 'local-only') {
        findings.push(createFinding('providers.data-boundary-not-local-only', 'warning', 'provider', provider.id, provider, '在需要本地边界的 workload 中收紧 Provider Profile；审计不会改写 profile。'));
      }
    }
    for (const model of evidence.localModels) {
      if (model.offline || model.healthStatus === 'unhealthy') {
        findings.push(createFinding('local-models.unhealthy', 'warning', 'local-model', model.id, model, '由操作者检查已登记本地模型；审计不会 probe、连接或启动模型。'));
      }
    }
    for (const issuer of evidence.trustedDesktopIssuers) {
      if (issuer.status !== 'trusted') {
        findings.push(createFinding('issuers.untrusted', 'info', 'trusted-desktop-issuer', issuer.issuerId, issuer, '保持管理员租约签发关闭，直到可信 native host 完成独立认证。'));
      }
    }
    if (evidence.recovery.latestDrillAt === undefined || !evidence.recovery.quickCheckOk) {
      findings.push(createFinding('recovery.drill-missing', 'warning', 'recovery', 'recovery-bundle', evidence.recovery, '由操作者执行恢复 bundle 演练；审计不会创建 bundle 或替换数据库。'));
    }
    if (evidence.resourceIsolation.requested && !evidence.resourceIsolation.enforced) {
      findings.push(createFinding('resource-isolation.requested-only', 'warning', 'resource-isolation', 'process-supervisor', evidence.resourceIsolation, '将 requested-only 资源限制明确展示为未强制执行，或由宿主启用可验证隔离。'));
    }
    const ordered = findings.sort((left, right) => left.checkId.localeCompare(right.checkId) || left.subjectKind.localeCompare(right.subjectKind) || left.subjectId.localeCompare(right.subjectId));
    return {
      schemaVersion: SECURITY_POSTURE_AUDIT_SCHEMA_VERSION,
      auditId: `audit:${evidenceDigest}`,
      auditedAt: now,
      evidenceDigest,
      findings: ordered.map(copyFinding),
      canExecute: false,
      canAutoRemediate: false,
    };
  }
}

/**
 * 可替换的 append-only 审计账本端口。记录动作必须由受控宿主或未来调度器显式触发；普通浏览器读取不会调用它。
 */
export class SecurityPostureAuditLedger {
  constructor(private readonly store: SecurityPostureAuditStore) {}

  record(report: SecurityPostureReportV1): SecurityPostureReportV1 {
    if (report.schemaVersion !== SECURITY_POSTURE_AUDIT_SCHEMA_VERSION || !report.auditId.startsWith('audit:') || !/^[a-f0-9]{64}$/.test(report.evidenceDigest) || report.canExecute !== false || report.canAutoRemediate !== false) {
      throw new Error('Security Posture report 无效；账本失败关闭');
    }
    assertEpoch(report.auditedAt, 'report.auditedAt');
    const existing = this.store.latest(report.auditId);
    if (existing && existing.evidenceDigest === report.evidenceDigest) return copyReport(existing);
    this.store.append(copyReport(report));
    return copyReport(report);
  }

  list(): readonly SecurityPostureReportV1[] {
    return this.store.list().map(copyReport).sort((left, right) => right.auditedAt - left.auditedAt || left.auditId.localeCompare(right.auditId));
  }
}

export class InMemorySecurityPostureAuditStore implements SecurityPostureAuditStore {
  private readonly reports = new Map<string, SecurityPostureReportV1>();

  append(report: SecurityPostureReportV1): void {
    if (this.reports.has(report.auditId)) throw new Error('同一 Security Posture auditId 不可重复追加');
    this.reports.set(report.auditId, copyReport(report));
  }

  latest(auditId: string): SecurityPostureReportV1 | undefined {
    const report = this.reports.get(auditId);
    return report ? copyReport(report) : undefined;
  }

  list(): readonly SecurityPostureReportV1[] {
    return [...this.reports.values()].map(copyReport);
  }
}
