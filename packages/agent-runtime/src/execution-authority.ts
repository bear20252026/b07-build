import type {
  Capability,
  CapabilityEvaluation,
  CapabilityPolicy,
  CapabilityRequest,
  ExecutionAuthorityMode,
} from '@awo/protocol';

export const ADMINISTRATOR_LEASE_SCHEMA_VERSION = 1 as const;
export const MAX_ADMINISTRATOR_LEASE_MS = 15 * 60 * 1_000;

export type AdministratorLeaseStatus = 'active' | 'revoked';

export interface AdministratorAuthorityLeaseV1 {
  schemaVersion: typeof ADMINISTRATOR_LEASE_SCHEMA_VERSION;
  leaseId: string;
  revision: number;
  operatorId: string;
  taskId: string;
  runId: string;
  allowedCapabilities: readonly Capability[];
  issuedAt: number;
  expiresAt: number;
  reasonDigest: string;
  status: AdministratorLeaseStatus;
  canOverrideApproval: true;
  canOverrideDeny: false;
  canReadSecrets: false;
  canReplaySideEffects: false;
}

export interface IssueAdministratorLeaseInput {
  leaseId: string;
  operatorId: string;
  taskId: string;
  runId: string;
  allowedCapabilities: readonly Capability[];
  issuedAt: number;
  expiresAt: number;
  reasonDigest: string;
}

export interface AdministratorLeaseStore {
  append(lease: AdministratorAuthorityLeaseV1): void;
  latest(leaseId: string): AdministratorAuthorityLeaseV1 | undefined;
  list(taskId: string, runId: string): readonly AdministratorAuthorityLeaseV1[];
  close?(): void;
}

export interface AdministratorLeaseResolution {
  allowed: boolean;
  reason: string;
  leaseId?: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CAPABILITIES = new Set<Capability>([
  'document.parse', 'model.chat', 'filesystem.read', 'filesystem.write', 'network.fetch', 'shell.execute', 'browser.control',
]);
const PLAN_READ_ONLY = new Set<Capability>(['document.parse', 'model.chat', 'filesystem.read']);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertCapabilities(value: readonly Capability[]): void {
  if (value.length === 0 || value.some((capability) => !CAPABILITIES.has(capability))) {
    throw new Error('管理员租约必须包含至少一项已声明 capability');
  }
  if (new Set(value).size !== value.length) throw new Error('管理员租约 capability 不可重复');
}

function copyLease(lease: AdministratorAuthorityLeaseV1): AdministratorAuthorityLeaseV1 {
  return { ...lease, allowedCapabilities: [...lease.allowedCapabilities] };
}

/**
 * append-only 管理员租约账本。租约是短时本地 break-glass metadata，
 * 不能携带 secret、任意命令、路径或“覆盖 deny”的标记。
 */
export class AdministratorAuthorityLedger {
  constructor(
    private readonly store: AdministratorLeaseStore,
    private readonly now: () => number = Date.now,
  ) {}

  issue(input: IssueAdministratorLeaseInput): AdministratorAuthorityLeaseV1 {
    assertIdentifier(input.leaseId, 'leaseId');
    assertIdentifier(input.operatorId, 'operatorId');
    assertIdentifier(input.taskId, 'taskId');
    assertIdentifier(input.runId, 'runId');
    assertCapabilities(input.allowedCapabilities);
    assertEpoch(input.issuedAt, 'issuedAt');
    assertEpoch(input.expiresAt, 'expiresAt');
    if (!DIGEST.test(input.reasonDigest)) throw new Error('reasonDigest 必须是 SHA-256 十六进制摘要');
    if (input.expiresAt <= input.issuedAt || input.expiresAt - input.issuedAt > MAX_ADMINISTRATOR_LEASE_MS) {
      throw new Error(`管理员租约有效期必须为 1-${MAX_ADMINISTRATOR_LEASE_MS}ms`);
    }
    if (this.store.latest(input.leaseId)) throw new Error(`管理员租约已存在：${input.leaseId}`);
    const lease: AdministratorAuthorityLeaseV1 = {
      schemaVersion: ADMINISTRATOR_LEASE_SCHEMA_VERSION,
      ...input,
      allowedCapabilities: [...input.allowedCapabilities].sort(),
      revision: 1,
      status: 'active',
      canOverrideApproval: true,
      canOverrideDeny: false,
      canReadSecrets: false,
      canReplaySideEffects: false,
    };
    this.store.append(lease);
    return copyLease(lease);
  }

  revoke(leaseId: string, operatorId: string, at = this.now()): AdministratorAuthorityLeaseV1 {
    assertIdentifier(leaseId, 'leaseId');
    assertIdentifier(operatorId, 'operatorId');
    assertEpoch(at, 'at');
    const existing = this.store.latest(leaseId);
    if (!existing) throw new Error(`管理员租约不存在：${leaseId}`);
    if (existing.operatorId !== operatorId) throw new Error('管理员租约只能由原操作者撤销');
    if (existing.status !== 'active') throw new Error('管理员租约已撤销');
    const revoked: AdministratorAuthorityLeaseV1 = { ...existing, revision: existing.revision + 1, status: 'revoked' };
    this.store.append(revoked);
    return copyLease(revoked);
  }

  get(leaseId: string): AdministratorAuthorityLeaseV1 | undefined {
    assertIdentifier(leaseId, 'leaseId');
    const lease = this.store.latest(leaseId);
    return lease ? copyLease(lease) : undefined;
  }

  list(taskId: string, runId: string): readonly AdministratorAuthorityLeaseV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return this.store.list(taskId, runId).map(copyLease);
  }

  resolve(request: CapabilityRequest, at = this.now()): AdministratorLeaseResolution {
    assertEpoch(at, 'at');
    const candidates = this.store.list(request.taskId, request.runId)
      .filter((lease) => lease.status === 'active' && lease.issuedAt <= at && at < lease.expiresAt)
      .filter((lease) => lease.allowedCapabilities.includes(request.capability))
      .sort((left, right) => right.revision - left.revision || left.leaseId.localeCompare(right.leaseId));
    const lease = candidates[0];
    if (!lease) return { allowed: false, reason: '管理员租约缺失、已到期、已撤销或不包含该 capability' };
    return { allowed: true, reason: `管理员租约 ${lease.leaseId} 已限时允许该 capability`, leaseId: lease.leaseId };
  }
}

/**
 * 单次任务 Authority overlay。它只能收紧或将既有 require_approval 在合法范围内转为 allow；
 * 任何下游 deny、预算、宿主隔离或审计故障均不可由此类覆盖。
 */
export class AuthorityCapabilityPolicy implements CapabilityPolicy {
  constructor(
    private readonly authorityMode: ExecutionAuthorityMode,
    private readonly delegate: CapabilityPolicy,
    private readonly administratorLeases?: AdministratorAuthorityLedger,
    private readonly now: () => number = Date.now,
  ) {}

  evaluate(request: CapabilityRequest): CapabilityEvaluation {
    const base = this.delegate.evaluate(request);
    if (base.decision === 'deny') return base;

    if (this.authorityMode === 'plan') {
      return PLAN_READ_ONLY.has(request.capability)
        ? base
        : { decision: 'deny', reason: `Plan Authority 禁止 ${request.capability}；请改用 review、automate 或管理员租约` };
    }
    if (this.authorityMode === 'review') return base;
    if (this.authorityMode === 'automate') {
      return base.decision === 'require_approval'
        ? { decision: 'allow', reason: `Automate Authority 在既有 capability 边界内允许 ${request.capability}` }
        : base;
    }
    if (!this.administratorLeases) {
      return { decision: 'deny', reason: 'Admin Authority 未装配管理员租约账本，失败关闭' };
    }
    if (base.decision === 'allow') return base;
    const lease = this.administratorLeases.resolve(request, this.now());
    return lease.allowed
      ? { decision: 'allow', reason: lease.reason }
      : { decision: 'deny', reason: lease.reason };
  }
}

export class InMemoryAdministratorLeaseStore implements AdministratorLeaseStore {
  private readonly revisions = new Map<string, AdministratorAuthorityLeaseV1[]>();

  append(lease: AdministratorAuthorityLeaseV1): void {
    assertIdentifier(lease.leaseId, 'leaseId');
    const existing = this.revisions.get(lease.leaseId) ?? [];
    if (lease.revision !== existing.length + 1) throw new Error('管理员租约 revision 必须严格追加');
    this.revisions.set(lease.leaseId, [...existing, copyLease(lease)]);
  }

  latest(leaseId: string): AdministratorAuthorityLeaseV1 | undefined {
    assertIdentifier(leaseId, 'leaseId');
    const records = this.revisions.get(leaseId);
    const lease = records?.at(-1);
    return lease ? copyLease(lease) : undefined;
  }

  list(taskId: string, runId: string): readonly AdministratorAuthorityLeaseV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return [...this.revisions.values()]
      .map((records) => records.at(-1))
      .filter((lease): lease is AdministratorAuthorityLeaseV1 => Boolean(lease && lease.taskId === taskId && lease.runId === runId))
      .sort((left, right) => left.leaseId.localeCompare(right.leaseId))
      .map(copyLease);
  }
}
