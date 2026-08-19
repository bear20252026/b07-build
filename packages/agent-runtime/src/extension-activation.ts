import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentProfileId, Capability, CapabilityPolicy, RiskLevel } from '@awo/protocol';
import type {
  ExtensionDataBoundary,
  ExtensionKind,
  ExtensionManifest,
  ExtensionRegistry,
} from './extension-registry.js';

export type ExtensionPlanDecision = 'selected' | 'blocked' | 'ignored';
export type ExtensionPlanReasonCode =
  | 'REQUEST_NOT_SELECTED'
  | 'KIND_NOT_REQUESTED'
  | 'NOT_INSTALLED'
  | 'API_VERSION_MISMATCH'
  | 'PROTOCOL_MISSING'
  | 'DATA_BOUNDARY_EXCEEDED'
  | 'CAPABILITY_MISSING'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'EXCLUSIVE_KIND_CONFLICT';

export interface ExtensionActivationTarget {
  profileId: AgentProfileId;
  requiredCapabilities: readonly Capability[];
  requiredProtocols: readonly string[];
  /** 当前任务允许的最高数据外发边界；默认 local-only。 */
  maximumDataBoundary: ExtensionDataBoundary;
  requestedExtensionIds?: readonly string[];
  requestedKinds?: readonly ExtensionKind[];
  /** 同种能力槽不能在一个计划中被隐式多选。 */
  exclusiveKinds?: readonly ExtensionKind[];
}

export interface ExtensionPlanEntry {
  extensionId: string;
  revision: number;
  kind: ExtensionKind;
  decision: ExtensionPlanDecision;
  reasons: readonly Readonly<{ code: ExtensionPlanReasonCode; detail: string }>[];
  effectiveCapabilities: readonly Capability[];
  /** 激活计划不授予执行权；后续 Host 仍必须进行实时 policy/approval/budget 判定。 */
  canExecute: false;
}

export interface ExtensionActivationPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  runId: string;
  target: Readonly<ExtensionActivationTarget>;
  entries: readonly ExtensionPlanEntry[];
  outcome: 'ready' | 'blocked';
  createdAt: number;
}

export interface PlanExtensionsRequest {
  taskId: string;
  runId: string;
  target: ExtensionActivationTarget;
  at: number;
  planId?: string;
}

export type ExtensionDiagnosticSeverity = 'info' | 'warning';

export interface ExtensionDiagnostic {
  extensionId: string;
  revision: number;
  severity: ExtensionDiagnosticSeverity;
  code: 'REVIEW_REQUIRED' | 'DIGEST_VERIFICATION_REQUIRED' | 'DISABLED' | 'REVOKED' | 'HOST_MODE_PENDING';
  message: string;
}

export interface ExtensionPlanStore {
  append(plan: ExtensionActivationPlan): void;
  load(planId: string): ExtensionActivationPlan | undefined;
  list(taskId: string, runId: string): readonly ExtensionActivationPlan[];
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATA_BOUNDARY_RANK: Readonly<Record<ExtensionDataBoundary, number>> = {
  'local-only': 0,
  'local-preferred': 1,
  'external-allowed': 2,
};
const DEFAULT_EXCLUSIVE_KINDS: readonly ExtensionKind[] = ['model-provider', 'agent-harness', 'scheduler-adapter'];
const LOW_RISK: RiskLevel = 'low';

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function copyTarget(target: ExtensionActivationTarget): ExtensionActivationTarget {
  return {
    ...target,
    requiredCapabilities: [...target.requiredCapabilities],
    requiredProtocols: [...target.requiredProtocols],
    requestedExtensionIds: target.requestedExtensionIds ? [...target.requestedExtensionIds] : undefined,
    requestedKinds: target.requestedKinds ? [...target.requestedKinds] : undefined,
    exclusiveKinds: target.exclusiveKinds ? [...target.exclusiveKinds] : undefined,
  };
}

function copyEntry(entry: ExtensionPlanEntry): ExtensionPlanEntry {
  return {
    ...entry,
    reasons: entry.reasons.map((reason) => ({ ...reason })),
    effectiveCapabilities: [...entry.effectiveCapabilities],
  };
}

function copyPlan(plan: ExtensionActivationPlan): ExtensionActivationPlan {
  return {
    ...plan,
    target: copyTarget(plan.target),
    entries: plan.entries.map(copyEntry),
  };
}

function unique<T extends string>(values: readonly T[], label: string): readonly T[] {
  const seen = new Set<T>();
  for (const value of values) {
    if (!value || seen.has(value)) throw new Error(`${label} 必须是非空且唯一的列表`);
    seen.add(value);
  }
  return [...values];
}

function policyReasons(
  manifest: ExtensionManifest,
  taskId: string,
  runId: string,
  policy: CapabilityPolicy,
): readonly Readonly<{ code: ExtensionPlanReasonCode; detail: string }>[] {
  const reasons: { code: ExtensionPlanReasonCode; detail: string }[] = [];
  for (const capability of manifest.requestedPermissions) {
    const evaluation = policy.evaluate({
      capability,
      risk: LOW_RISK,
      taskId,
      runId,
      actionId: `extension:${manifest.id}:${capability}`,
    });
    if (evaluation.decision === 'deny') reasons.push({ code: 'POLICY_DENIED', detail: `${capability}: ${evaluation.reason}` });
    if (evaluation.decision === 'require_approval') reasons.push({ code: 'APPROVAL_REQUIRED', detail: `${capability}: ${evaluation.reason}` });
  }
  return reasons;
}

function createEntry(
  manifest: ExtensionManifest,
  target: ExtensionActivationTarget,
  taskId: string,
  runId: string,
  policy: CapabilityPolicy,
): ExtensionPlanEntry {
  const reasons: { code: ExtensionPlanReasonCode; detail: string }[] = [];
  const requestedIds = target.requestedExtensionIds ? new Set(target.requestedExtensionIds) : undefined;
  const requestedKinds = target.requestedKinds ? new Set(target.requestedKinds) : undefined;
  if (requestedIds && !requestedIds.has(manifest.id)) reasons.push({ code: 'REQUEST_NOT_SELECTED', detail: '此 extension 未被当前请求显式选中' });
  if (requestedKinds && !requestedKinds.has(manifest.kind)) reasons.push({ code: 'KIND_NOT_REQUESTED', detail: '此 extension kind 不在当前请求范围' });
  if (manifest.status !== 'installed') reasons.push({ code: 'NOT_INSTALLED', detail: `当前状态为 ${manifest.status}，只有 installed metadata 可进入计划` });
  if (manifest.apiVersion !== 'awo.extension.v1' || manifest.compatibility.hostApiVersion !== 'awo.extension.v1') {
    reasons.push({ code: 'API_VERSION_MISMATCH', detail: 'extension API 版本不兼容当前 host' });
  }
  for (const protocol of target.requiredProtocols) {
    if (!manifest.compatibility.protocols.includes(protocol)) reasons.push({ code: 'PROTOCOL_MISSING', detail: `未声明所需协议 ${protocol}` });
  }
  if (DATA_BOUNDARY_RANK[manifest.dataBoundary] > DATA_BOUNDARY_RANK[target.maximumDataBoundary]) {
    reasons.push({ code: 'DATA_BOUNDARY_EXCEEDED', detail: `extension data boundary ${manifest.dataBoundary} 超过任务上限 ${target.maximumDataBoundary}` });
  }
  for (const capability of target.requiredCapabilities) {
    if (!manifest.declaredCapabilities.includes(capability)) reasons.push({ code: 'CAPABILITY_MISSING', detail: `未声明所需 capability ${capability}` });
  }
  reasons.push(...policyReasons(manifest, taskId, runId, policy));
  const ignored = reasons.some((reason) => reason.code === 'REQUEST_NOT_SELECTED' || reason.code === 'KIND_NOT_REQUESTED');
  return {
    extensionId: manifest.id,
    revision: manifest.revision,
    kind: manifest.kind,
    decision: ignored ? 'ignored' : reasons.length > 0 ? 'blocked' : 'selected',
    reasons,
    effectiveCapabilities: manifest.requestedPermissions.filter((capability) => manifest.declaredCapabilities.includes(capability)),
    canExecute: false,
  };
}

/** 默认只输出 metadata 激活计划。没有任何加载、import、spawn、网络连接或权限授权副作用。 */
export class ExtensionActivationPlanner {
  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly policy: CapabilityPolicy,
    private readonly store: ExtensionPlanStore,
  ) {}

  plan(request: PlanExtensionsRequest): ExtensionActivationPlan {
    assertIdentifier(request.taskId, 'taskId');
    assertIdentifier(request.runId, 'runId');
    assertEpoch(request.at, 'at');
    const target = copyTarget(request.target);
    unique(target.requiredCapabilities, 'requiredCapabilities');
    unique(target.requiredProtocols, 'requiredProtocols');
    if (target.requestedExtensionIds) unique(target.requestedExtensionIds, 'requestedExtensionIds');
    if (target.requestedKinds) unique(target.requestedKinds, 'requestedKinds');
    if (target.exclusiveKinds) unique(target.exclusiveKinds, 'exclusiveKinds');
    const entries = this.registry.list().map((manifest) => createEntry(manifest, target, request.taskId, request.runId, this.policy));
    const exclusiveKinds = new Set(target.exclusiveKinds ?? DEFAULT_EXCLUSIVE_KINDS);
    for (const kind of exclusiveKinds) {
      const selected = entries.filter((entry) => entry.kind === kind && entry.decision === 'selected');
      if (selected.length > 1) {
        for (const entry of selected) {
          entry.decision = 'blocked';
          (entry.reasons as { code: ExtensionPlanReasonCode; detail: string }[]).push({
            code: 'EXCLUSIVE_KIND_CONFLICT',
            detail: `${kind} 有 ${selected.length} 个候选，必须由请求显式缩小为单一 extension`,
          });
        }
      }
    }
    const plan: ExtensionActivationPlan = {
      schemaVersion: 1,
      planId: request.planId ?? `extension-plan-${randomUUID()}`,
      taskId: request.taskId,
      runId: request.runId,
      target,
      entries,
      outcome: entries.some((entry) => entry.decision === 'selected') ? 'ready' : 'blocked',
      createdAt: request.at,
    };
    assertIdentifier(plan.planId, 'planId');
    this.store.append(plan);
    return copyPlan(plan);
  }
}

/** 将 registry 当前状态转换为无需执行代码的 doctor diagnostics。 */
export class ExtensionDoctor {
  constructor(private readonly registry: ExtensionRegistry) {}

  inspect(): readonly ExtensionDiagnostic[] {
    return this.registry.list().flatMap((manifest) => {
      const diagnostic = (severity: ExtensionDiagnosticSeverity, code: ExtensionDiagnostic['code'], message: string): ExtensionDiagnostic => ({
        extensionId: manifest.id, revision: manifest.revision, severity, code, message,
      });
      if (manifest.status === 'discovered') return [diagnostic('info', 'REVIEW_REQUIRED', '已发现 metadata，等待人工审查。')];
      if (manifest.status === 'reviewed') return [diagnostic('info', 'DIGEST_VERIFICATION_REQUIRED', '已审查 metadata，等待本地制品摘要核验。')];
      if (manifest.status === 'disabled') return [diagnostic('info', 'DISABLED', 'extension 已显式停用，不会进入激活计划。')];
      if (manifest.status === 'revoked') return [diagnostic('warning', 'REVOKED', 'extension 已撤销，必须以新 id 和来源重新登记。')];
      if (manifest.entry?.mode === 'in-process') return [diagnostic('warning', 'HOST_MODE_PENDING', '当前 host 仅计划 metadata；in-process entry 必须在受控 Host 策略就绪后才能使用。')];
      return [];
    });
  }
}

export class InMemoryExtensionPlanStore implements ExtensionPlanStore {
  private readonly plans = new Map<string, ExtensionActivationPlan>();

  append(plan: ExtensionActivationPlan): void {
    assertIdentifier(plan.planId, 'planId');
    if (this.plans.has(plan.planId)) throw new Error(`extension plan ${plan.planId} 已存在；审计计划不可覆盖`);
    this.plans.set(plan.planId, copyPlan(plan));
  }

  load(planId: string): ExtensionActivationPlan | undefined {
    assertIdentifier(planId, 'planId');
    const plan = this.plans.get(planId);
    return plan ? copyPlan(plan) : undefined;
  }

  list(taskId: string, runId: string): readonly ExtensionActivationPlan[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return [...this.plans.values()].filter((plan) => plan.taskId === taskId && plan.runId === runId)
      .sort((left, right) => left.createdAt - right.createdAt || left.planId.localeCompare(right.planId)).map(copyPlan);
  }
}

/** SQLite WAL 审计计划账本；一个 planId 只能写入一次，防止诊断结果被追溯覆盖。 */
export class SqliteExtensionPlanStore implements ExtensionPlanStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_activation_plans (
        plan_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        plan_json TEXT NOT NULL
      );
    `);
  }

  append(plan: ExtensionActivationPlan): void {
    assertIdentifier(plan.planId, 'planId');
    this.db.prepare(`
      INSERT INTO extension_activation_plans (plan_id, task_id, run_id, created_at, plan_json) VALUES (?, ?, ?, ?, ?)
    `).run(plan.planId, plan.taskId, plan.runId, plan.createdAt, JSON.stringify(copyPlan(plan)));
  }

  load(planId: string): ExtensionActivationPlan | undefined {
    assertIdentifier(planId, 'planId');
    const row = this.db.prepare('SELECT plan_json FROM extension_activation_plans WHERE plan_id = ?').get(planId) as { plan_json: string } | undefined;
    return row ? copyPlan(JSON.parse(row.plan_json) as ExtensionActivationPlan) : undefined;
  }

  list(taskId: string, runId: string): readonly ExtensionActivationPlan[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    const rows = this.db.prepare(`
      SELECT plan_json FROM extension_activation_plans WHERE task_id = ? AND run_id = ? ORDER BY created_at ASC, plan_id ASC
    `).all(taskId, runId) as unknown as readonly { plan_json: string }[];
    return rows.map((row) => copyPlan(JSON.parse(row.plan_json) as ExtensionActivationPlan));
  }

  close(): void {
    this.db.close();
  }
}
