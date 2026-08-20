import { createHash } from 'node:crypto';

export const COMPONENT_PROVENANCE_SCHEMA_VERSION = 1 as const;

/** 仅涵盖会被显式激活或注入运行时的受治理构件；Provider Profile 仍由其独立凭据/边界控制面管理。 */
export type ActivatableComponentKind = 'extension' | 'skill-pack' | 'agent-adapter';
export type ComponentSourceKind = 'builtin' | 'local-path' | 'npm' | 'git' | 'registry' | 'manual';
export type ComponentReviewStatus = 'candidate' | 'reviewed' | 'revoked';
export type ComponentEligibility = 'eligible' | 'quarantined';
export type ComponentQuarantineReason =
  | 'missing-provenance'
  | 'kind-mismatch'
  | 'version-mismatch'
  | 'provenance-not-reviewed'
  | 'provenance-revoked'
  | 'provenance-digest-mismatch'
  | 'missing-lockfile'
  | 'missing-lock-entry'
  | 'lock-content-digest-mismatch'
  | 'lock-provenance-digest-mismatch';

export interface ComponentProvenanceV1 {
  schemaVersion: typeof COMPONENT_PROVENANCE_SCHEMA_VERSION;
  componentId: string;
  componentKind: ActivatableComponentKind;
  version: string;
  sourceKind: ComponentSourceKind;
  /** 非秘密、非 URL 的审查定位符，例如 `npm:@scope/name@1.2.3` 或 `git:owner/repo@commit`。 */
  sourceRef: string;
  contentDigest: string;
  licenseId: string;
  reviewStatus: ComponentReviewStatus;
  revision: number;
  recordedAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
  revokedAt?: number;
}

export interface RegisterComponentCandidateRequest {
  componentId: string;
  componentKind: ActivatableComponentKind;
  version: string;
  sourceKind: ComponentSourceKind;
  sourceRef: string;
  contentDigest: string;
  licenseId: string;
  at: number;
}

export interface ComponentProvenanceStore {
  load(componentId: string): ComponentProvenanceV1 | undefined;
  append(provenance: ComponentProvenanceV1): void;
  list(): readonly ComponentProvenanceV1[];
  history(componentId: string): readonly ComponentProvenanceV1[];
  close?(): void;
}

export interface ComponentLockEntryV1 {
  componentId: string;
  contentDigest: string;
  provenanceDigest: string;
}

export interface ComponentLockfileV1 {
  schemaVersion: typeof COMPONENT_PROVENANCE_SCHEMA_VERSION;
  revision: number;
  lockedAt: number;
  entries: readonly ComponentLockEntryV1[];
  lockDigest: string;
}

export interface ComponentLockfileStore {
  load(): ComponentLockfileV1 | undefined;
  append(lockfile: ComponentLockfileV1): void;
  history(): readonly ComponentLockfileV1[];
  close?(): void;
}

export interface ObservedActivatableComponentV1 {
  componentId: string;
  componentKind: ActivatableComponentKind;
  version: string;
  contentDigest: string;
}

export interface ComponentEligibilityDecisionV1 {
  componentId: string;
  componentKind: ActivatableComponentKind;
  eligibility: ComponentEligibility;
  lockRevision?: number;
  reasons: readonly ComponentQuarantineReason[];
  canActivate: false;
  canAutoRepair: false;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SPDX_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const COMPONENT_KINDS = new Set<ActivatableComponentKind>(['extension', 'skill-pack', 'agent-adapter']);
const SOURCE_KINDS = new Set<ComponentSourceKind>(['builtin', 'local-path', 'npm', 'git', 'registry', 'manual']);

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正安全整数`);
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} 必须是小写 SHA-256 十六进制摘要`);
}

function assertSourceReference(value: string): void {
  if (!SAFE_REFERENCE.test(value) || value.includes('://') || value.includes('..')) {
    throw new Error('sourceRef 必须是 1-256 位无 URL、路径穿越、查询参数或秘密的受限来源定位符');
  }
}

function copyProvenance(value: ComponentProvenanceV1): ComponentProvenanceV1 {
  return { ...value };
}

function copyLockEntry(value: ComponentLockEntryV1): ComponentLockEntryV1 {
  return { ...value };
}

function copyLockfile(value: ComponentLockfileV1): ComponentLockfileV1 {
  return { ...value, entries: value.entries.map(copyLockEntry) };
}

function assertProvenance(value: ComponentProvenanceV1): void {
  if (value.schemaVersion !== COMPONENT_PROVENANCE_SCHEMA_VERSION) throw new Error('ComponentProvenanceV1 版本不兼容');
  assertIdentifier(value.componentId, 'componentId');
  if (!COMPONENT_KINDS.has(value.componentKind)) throw new Error('componentKind 未被支持');
  if (!SEMVER.test(value.version)) throw new Error('version 必须是显式 semver');
  if (!SOURCE_KINDS.has(value.sourceKind)) throw new Error('sourceKind 未被支持');
  assertSourceReference(value.sourceRef);
  assertDigest(value.contentDigest, 'contentDigest');
  if (!SPDX_IDENTIFIER.test(value.licenseId)) throw new Error('licenseId 必须是受限 SPDX 标识符');
  if (!['candidate', 'reviewed', 'revoked'].includes(value.reviewStatus)) throw new Error('reviewStatus 未被支持');
  assertRevision(value.revision, 'revision');
  assertEpoch(value.recordedAt, 'recordedAt');
  if (value.reviewStatus === 'reviewed') {
    if (!value.reviewedBy || value.reviewedAt === undefined) throw new Error('reviewed provenance 必须有 reviewer 与 reviewedAt');
    assertIdentifier(value.reviewedBy, 'reviewedBy');
    assertEpoch(value.reviewedAt, 'reviewedAt');
  }
  if (value.reviewStatus === 'revoked') {
    if (value.revokedAt === undefined) throw new Error('revoked provenance 必须有 revokedAt');
    assertEpoch(value.revokedAt, 'revokedAt');
  }
}

function normalizedLockEntries(entries: readonly ComponentLockEntryV1[]): readonly ComponentLockEntryV1[] {
  if (entries.length > 512) throw new Error('lockfile entries 最多 512 项');
  const seen = new Set<string>();
  const normalized = entries.map((entry) => {
    assertIdentifier(entry.componentId, 'lock.componentId');
    assertDigest(entry.contentDigest, 'lock.contentDigest');
    assertDigest(entry.provenanceDigest, 'lock.provenanceDigest');
    if (seen.has(entry.componentId)) throw new Error('lockfile 不得包含重复 componentId');
    seen.add(entry.componentId);
    return copyLockEntry(entry);
  });
  return normalized.sort((left, right) => left.componentId.localeCompare(right.componentId));
}

function normalizedLockInput(revision: number, lockedAt: number, entries: readonly ComponentLockEntryV1[]): Omit<ComponentLockfileV1, 'lockDigest'> {
  assertRevision(revision, 'lockfile.revision');
  assertEpoch(lockedAt, 'lockfile.lockedAt');
  return { schemaVersion: COMPONENT_PROVENANCE_SCHEMA_VERSION, revision, lockedAt, entries: normalizedLockEntries(entries) };
}

function assertLockfile(lockfile: ComponentLockfileV1): void {
  if (lockfile.schemaVersion !== COMPONENT_PROVENANCE_SCHEMA_VERSION) throw new Error('ComponentLockfileV1 版本不兼容');
  const normalized = normalizedLockInput(lockfile.revision, lockfile.lockedAt, lockfile.entries);
  assertDigest(lockfile.lockDigest, 'lockfile.lockDigest');
  if (lockfile.lockDigest !== digest(normalized)) throw new Error('lockfile.lockDigest 与受限 entries 不匹配');
}

export function provenanceDigest(provenance: ComponentProvenanceV1): string {
  assertProvenance(provenance);
  return digest({
    schemaVersion: provenance.schemaVersion,
    componentId: provenance.componentId,
    componentKind: provenance.componentKind,
    version: provenance.version,
    sourceKind: provenance.sourceKind,
    sourceRef: provenance.sourceRef,
    contentDigest: provenance.contentDigest,
    licenseId: provenance.licenseId,
    reviewStatus: provenance.reviewStatus,
    revision: provenance.revision,
  });
}

/** 纯函数：将操作者明确提供的构件清单规范化为固定 revision 的 lockfile，不读取注册表、不下载、不安装。 */
export function createComponentLockfile(revision: number, entries: readonly ComponentLockEntryV1[], lockedAt: number): ComponentLockfileV1 {
  const normalized = normalizedLockInput(revision, lockedAt, entries);
  return { ...normalized, lockDigest: digest(normalized) };
}

/** provenance 登记仅推进 append-only metadata 状态机；不读取制品、不验证签名、不改变任何 manifest 的激活状态。 */
export class ComponentProvenanceRegistry {
  constructor(private readonly store: ComponentProvenanceStore) {}

  registerCandidate(request: RegisterComponentCandidateRequest): ComponentProvenanceV1 {
    const candidate: ComponentProvenanceV1 = {
      schemaVersion: COMPONENT_PROVENANCE_SCHEMA_VERSION,
      componentId: request.componentId,
      componentKind: request.componentKind,
      version: request.version,
      sourceKind: request.sourceKind,
      sourceRef: request.sourceRef,
      contentDigest: request.contentDigest,
      licenseId: request.licenseId,
      reviewStatus: 'candidate',
      revision: 1,
      recordedAt: request.at,
    };
    assertProvenance(candidate);
    if (this.store.load(candidate.componentId)) throw new Error('构件 provenance 已存在；来源或摘要改变必须使用新 componentId');
    this.store.append(copyProvenance(candidate));
    return copyProvenance(candidate);
  }

  review(componentId: string, reviewer: string, at: number, expectedDigest: string): ComponentProvenanceV1 {
    assertIdentifier(componentId, 'componentId');
    assertIdentifier(reviewer, 'reviewedBy');
    assertEpoch(at, 'reviewedAt');
    assertDigest(expectedDigest, 'expectedDigest');
    const current = this.store.load(componentId);
    if (!current) throw new Error('构件 provenance 不存在');
    if (current.reviewStatus !== 'candidate') throw new Error('只有 candidate provenance 可被评审');
    if (current.contentDigest !== expectedDigest) throw new Error('评审摘要与登记摘要不一致；必须隔离并登记新 componentId');
    const reviewed: ComponentProvenanceV1 = { ...current, reviewStatus: 'reviewed', revision: current.revision + 1, reviewedBy: reviewer, reviewedAt: at };
    assertProvenance(reviewed);
    this.store.append(copyProvenance(reviewed));
    return copyProvenance(reviewed);
  }

  revoke(componentId: string, at: number): ComponentProvenanceV1 {
    assertIdentifier(componentId, 'componentId');
    assertEpoch(at, 'revokedAt');
    const current = this.store.load(componentId);
    if (!current) throw new Error('构件 provenance 不存在');
    if (current.reviewStatus === 'revoked') throw new Error('构件 provenance 已撤销且不可恢复');
    const revoked: ComponentProvenanceV1 = { ...current, reviewStatus: 'revoked', revision: current.revision + 1, revokedAt: at };
    assertProvenance(revoked);
    this.store.append(copyProvenance(revoked));
    return copyProvenance(revoked);
  }

  list(): readonly ComponentProvenanceV1[] {
    return this.store.list().map(copyProvenance).sort((left, right) => left.componentId.localeCompare(right.componentId));
  }
}

/** lockfile 只能由显式受控调用追加；它不会从 provenance registry 自动收集、升级或改写条目。 */
export class ComponentLockfileLedger {
  constructor(private readonly store: ComponentLockfileStore) {}

  record(lockfile: ComponentLockfileV1): ComponentLockfileV1 {
    assertLockfile(lockfile);
    const current = this.store.load();
    if (current && lockfile.revision !== current.revision + 1) throw new Error('lockfile revision 必须连续递增');
    if (!current && lockfile.revision !== 1) throw new Error('首个 lockfile revision 必须为 1');
    this.store.append(copyLockfile(lockfile));
    return copyLockfile(lockfile);
  }

  latest(): ComponentLockfileV1 | undefined {
    const lockfile = this.store.load();
    return lockfile ? copyLockfile(lockfile) : undefined;
  }

  history(): readonly ComponentLockfileV1[] {
    return this.store.history().map(copyLockfile).sort((left, right) => left.revision - right.revision);
  }
}

/** 纯冷路径决策器：任何缺失或不一致都会隔离；不会改写 lock、安装构件、加载代码、执行命令或触发网络请求。 */
export class ComponentLockEnforcementService {
  inspect(
    observed: readonly ObservedActivatableComponentV1[],
    provenances: readonly ComponentProvenanceV1[],
    lockfile: ComponentLockfileV1 | undefined,
  ): readonly ComponentEligibilityDecisionV1[] {
    const provenanceById = new Map<string, ComponentProvenanceV1>();
    for (const provenance of provenances) {
      assertProvenance(provenance);
      if (provenanceById.has(provenance.componentId)) throw new Error('provenance 输入不可有重复 componentId');
      provenanceById.set(provenance.componentId, copyProvenance(provenance));
    }
    if (lockfile) assertLockfile(lockfile);
    const lockById = new Map(lockfile?.entries.map((entry) => [entry.componentId, entry]) ?? []);
    const seen = new Set<string>();
    const decisions = observed.map((item) => {
      assertIdentifier(item.componentId, 'observed.componentId');
      if (!COMPONENT_KINDS.has(item.componentKind)) throw new Error('observed.componentKind 未被支持');
      if (!SEMVER.test(item.version)) throw new Error('observed.version 必须是显式 semver');
      assertDigest(item.contentDigest, 'observed.contentDigest');
      if (seen.has(item.componentId)) throw new Error('observed 输入不可有重复 componentId');
      seen.add(item.componentId);
      const provenance = provenanceById.get(item.componentId);
      const locked = lockById.get(item.componentId);
      const reasons: ComponentQuarantineReason[] = [];
      if (!provenance) {
        reasons.push('missing-provenance');
      } else {
        if (provenance.componentKind !== item.componentKind) reasons.push('kind-mismatch');
        if (provenance.version !== item.version) reasons.push('version-mismatch');
        if (provenance.reviewStatus === 'candidate') reasons.push('provenance-not-reviewed');
        if (provenance.reviewStatus === 'revoked') reasons.push('provenance-revoked');
        if (provenance.contentDigest !== item.contentDigest) reasons.push('provenance-digest-mismatch');
      }
      if (!lockfile) {
        reasons.push('missing-lockfile');
      } else if (!locked) {
        reasons.push('missing-lock-entry');
      } else if (locked.contentDigest !== item.contentDigest) {
        reasons.push('lock-content-digest-mismatch');
      } else if (provenance && locked.provenanceDigest !== provenanceDigest(provenance)) {
        reasons.push('lock-provenance-digest-mismatch');
      }
      const ordered = [...new Set(reasons)].sort();
      return {
        componentId: item.componentId,
        componentKind: item.componentKind,
        eligibility: ordered.length === 0 ? 'eligible' : 'quarantined',
        lockRevision: lockfile?.revision,
        reasons: ordered,
        canActivate: false,
        canAutoRepair: false,
      } satisfies ComponentEligibilityDecisionV1;
    });
    return decisions.sort((left, right) => left.componentId.localeCompare(right.componentId));
  }
}

export class InMemoryComponentProvenanceStore implements ComponentProvenanceStore {
  private readonly revisions = new Map<string, ComponentProvenanceV1[]>();

  load(componentId: string): ComponentProvenanceV1 | undefined {
    assertIdentifier(componentId, 'componentId');
    const value = this.revisions.get(componentId)?.at(-1);
    return value ? copyProvenance(value) : undefined;
  }

  append(provenance: ComponentProvenanceV1): void {
    assertProvenance(provenance);
    const history = this.revisions.get(provenance.componentId) ?? [];
    const current = history.at(-1);
    if (!current && provenance.revision !== 1) throw new Error('首个 provenance revision 必须为 1');
    if (current && provenance.revision !== current.revision + 1) throw new Error('provenance revision 必须连续递增');
    this.revisions.set(provenance.componentId, [...history, copyProvenance(provenance)]);
  }

  list(): readonly ComponentProvenanceV1[] {
    return [...this.revisions.values()].flatMap((history) => history.at(-1) ? [copyProvenance(history.at(-1)!)] : []);
  }

  history(componentId: string): readonly ComponentProvenanceV1[] {
    assertIdentifier(componentId, 'componentId');
    return (this.revisions.get(componentId) ?? []).map(copyProvenance);
  }
}

export class InMemoryComponentLockfileStore implements ComponentLockfileStore {
  private readonly revisions: ComponentLockfileV1[] = [];

  load(): ComponentLockfileV1 | undefined {
    const value = this.revisions.at(-1);
    return value ? copyLockfile(value) : undefined;
  }

  append(lockfile: ComponentLockfileV1): void {
    assertLockfile(lockfile);
    const current = this.revisions.at(-1);
    if (!current && lockfile.revision !== 1) throw new Error('首个 lockfile revision 必须为 1');
    if (current && lockfile.revision !== current.revision + 1) throw new Error('lockfile revision 必须连续递增');
    this.revisions.push(copyLockfile(lockfile));
  }

  history(): readonly ComponentLockfileV1[] {
    return this.revisions.map(copyLockfile);
  }
}
