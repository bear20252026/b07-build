import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DataBoundary, ModelRouteDecision, ModelRouteRequest, ModelRouter } from './router.js';

export type ProviderProfileStatus = 'registered' | 'active' | 'disabled' | 'revoked';

export interface ProviderProfile {
  schemaVersion: 1;
  id: string;
  displayName: string;
  /** 仅允许 ModelRouter 中已装配的 driver 进入候选集；顺序不影响 router 的稳定打分。 */
  driverIds: readonly string[];
  /** Profile 是任务 data boundary 的上限；请求不能通过更宽松值突破。 */
  maximumDataBoundary: DataBoundary;
  /** 只保存本机安全存储的引用名，绝不保存 API key、token、URL 凭据或 OAuth 内容。 */
  credentialReference?: string;
  status: ProviderProfileStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  reviewedBy: string;
  activatedAt?: number;
  disabledAt?: number;
  revokedAt?: number;
  note?: string;
}

export interface RegisterProviderProfileRequest {
  id: string;
  displayName: string;
  driverIds: readonly string[];
  maximumDataBoundary: DataBoundary;
  credentialReference?: string;
  reviewedBy: string;
  note?: string;
  at: number;
}

export interface UpdateProviderProfileRequest {
  displayName?: string;
  driverIds?: readonly string[];
  maximumDataBoundary?: DataBoundary;
  credentialReference?: string;
  clearCredentialReference?: boolean;
  note?: string;
  reviewedBy: string;
  at: number;
}

export interface ProviderProfileStore {
  load(id: string): ProviderProfile | undefined;
  append(profile: ProviderProfile): void;
  list(): readonly ProviderProfile[];
  history(id: string): readonly ProviderProfile[];
}

export interface ProfileRouteRequest extends Omit<ModelRouteRequest, 'dataBoundary'> {
  dataBoundary?: DataBoundary;
}

export interface ProviderProfileRouteDecision {
  profileId: string;
  profileRevision: number;
  effectiveDataBoundary: DataBoundary;
  selectedDriverId: string;
  decision: ModelRouteDecision;
  reason: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATA_BOUNDARY_RANK: Readonly<Record<DataBoundary, number>> = {
  'local-only': 0,
  'local-preferred': 1,
  'remote-allowed': 2,
};
const STATUSES = new Set<ProviderProfileStatus>(['registered', 'active', 'disabled', 'revoked']);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertDataBoundary(value: DataBoundary): void {
  if (!(value in DATA_BOUNDARY_RANK)) throw new Error('maximumDataBoundary 未被支持');
}

function validateDriverIds(driverIds: readonly string[]): readonly string[] {
  if (driverIds.length === 0 || driverIds.length > 16) throw new Error('driverIds 必须为 1-16 个显式驱动标识');
  const seen = new Set<string>();
  for (const driverId of driverIds) {
    assertIdentifier(driverId, 'driverId');
    if (seen.has(driverId)) throw new Error(`driverIds 不得重复：${driverId}`);
    seen.add(driverId);
  }
  return [...driverIds];
}

function validateCredentialReference(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  assertIdentifier(value, 'credentialReference');
  return value;
}

function validateNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  if (note.length > 2_000) throw new Error('note 不得超过 2000 字符');
  return note.trim() || undefined;
}

function copyProfile(profile: ProviderProfile): ProviderProfile {
  return { ...profile, driverIds: [...profile.driverIds] };
}

function fingerprint(profile: ProviderProfile): string {
  return createHash('sha256').update(JSON.stringify({
    id: profile.id,
    displayName: profile.displayName,
    driverIds: profile.driverIds,
    maximumDataBoundary: profile.maximumDataBoundary,
    credentialReference: profile.credentialReference,
    status: profile.status,
    revision: profile.revision,
  })).digest('hex');
}

function minimumBoundary(left: DataBoundary, right: DataBoundary): DataBoundary {
  return DATA_BOUNDARY_RANK[left] <= DATA_BOUNDARY_RANK[right] ? left : right;
}

/** 进程内 profile 账本；只接受连续 revision，便于 deterministic audit replay。 */
export class InMemoryProviderProfileStore implements ProviderProfileStore {
  private readonly current = new Map<string, ProviderProfile>();
  private readonly revisions = new Map<string, ProviderProfile[]>();

  load(id: string): ProviderProfile | undefined {
    assertIdentifier(id, 'id');
    const profile = this.current.get(id);
    return profile ? copyProfile(profile) : undefined;
  }

  append(profile: ProviderProfile): void {
    const previous = this.current.get(profile.id);
    if (!previous && profile.revision !== 1) throw new Error('新 provider profile revision 必须为 1');
    if (previous && profile.revision !== previous.revision + 1) throw new Error('provider profile revision 必须连续递增');
    const copied = copyProfile(profile);
    this.current.set(profile.id, copied);
    const history = this.revisions.get(profile.id) ?? [];
    history.push(copyProfile(copied));
    this.revisions.set(profile.id, history);
  }

  list(): readonly ProviderProfile[] {
    return [...this.current.values()].map(copyProfile).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  history(id: string): readonly ProviderProfile[] {
    assertIdentifier(id, 'id');
    return (this.revisions.get(id) ?? []).map(copyProfile);
  }
}

/** SQLite WAL profile 账本；只保存安全凭据引用名，不保存 secret 内容。 */
export class SqliteProviderProfileStore implements ProviderProfileStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_profile_revisions (
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        profile_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (profile_id, revision)
      );
    `);
  }

  load(id: string): ProviderProfile | undefined {
    assertIdentifier(id, 'id');
    const row = this.db.prepare(`
      SELECT profile_json FROM provider_profile_revisions WHERE profile_id = ? ORDER BY revision DESC LIMIT 1
    `).get(id) as { profile_json: string } | undefined;
    return row ? copyProfile(JSON.parse(row.profile_json) as ProviderProfile) : undefined;
  }

  append(profile: ProviderProfile): void {
    const current = this.load(profile.id);
    if (!current && profile.revision !== 1) throw new Error('新 provider profile revision 必须为 1');
    if (current && profile.revision !== current.revision + 1) throw new Error('provider profile revision 必须连续递增');
    this.db.prepare(`
      INSERT INTO provider_profile_revisions (profile_id, revision, profile_json, fingerprint) VALUES (?, ?, ?, ?)
    `).run(profile.id, profile.revision, JSON.stringify(copyProfile(profile)), fingerprint(profile));
  }

  list(): readonly ProviderProfile[] {
    const rows = this.db.prepare(`
      SELECT revision.profile_json FROM provider_profile_revisions AS revision
      JOIN (SELECT profile_id, MAX(revision) AS latest FROM provider_profile_revisions GROUP BY profile_id) AS latest
        ON latest.profile_id = revision.profile_id AND latest.latest = revision.revision
    `).all() as unknown as readonly { profile_json: string }[];
    return rows.map((row) => copyProfile(JSON.parse(row.profile_json) as ProviderProfile))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  history(id: string): readonly ProviderProfile[] {
    assertIdentifier(id, 'id');
    const rows = this.db.prepare(`
      SELECT profile_json FROM provider_profile_revisions WHERE profile_id = ? ORDER BY revision ASC
    `).all(id) as unknown as readonly { profile_json: string }[];
    return rows.map((row) => copyProfile(JSON.parse(row.profile_json) as ProviderProfile));
  }

  close(): void {
    this.db.close();
  }
}

/** Profile 控制面不请求模型，也不解析 credentialReference；它只收紧 ModelRouter 的候选和数据边界。 */
export class ProviderProfileRegistry {
  constructor(private readonly store: ProviderProfileStore) {}

  register(request: RegisterProviderProfileRequest): ProviderProfile {
    assertIdentifier(request.id, 'id');
    assertIdentifier(request.reviewedBy, 'reviewedBy');
    assertEpoch(request.at, 'at');
    if (this.store.load(request.id)) throw new Error(`provider profile ${request.id} 已登记；请显式更新或创建新 profile`);
    if (!request.displayName.trim() || request.displayName.length > 160) throw new Error('displayName 必须是 1-160 字符');
    const profile: ProviderProfile = {
      schemaVersion: 1,
      id: request.id,
      displayName: request.displayName.trim(),
      driverIds: validateDriverIds(request.driverIds),
      maximumDataBoundary: request.maximumDataBoundary,
      credentialReference: validateCredentialReference(request.credentialReference),
      status: 'registered',
      revision: 1,
      createdAt: request.at,
      updatedAt: request.at,
      reviewedBy: request.reviewedBy,
      note: validateNote(request.note),
    };
    assertDataBoundary(profile.maximumDataBoundary);
    this.store.append(profile);
    return copyProfile(profile);
  }

  update(id: string, request: UpdateProviderProfileRequest): ProviderProfile {
    assertIdentifier(request.reviewedBy, 'reviewedBy');
    assertEpoch(request.at, 'at');
    const current = this.requireMutable(id);
    if (request.clearCredentialReference && request.credentialReference !== undefined) throw new Error('credentialReference 与 clearCredentialReference 不可同时指定');
    const displayName = request.displayName === undefined ? current.displayName : request.displayName.trim();
    if (!displayName || displayName.length > 160) throw new Error('displayName 必须是 1-160 字符');
    const next: ProviderProfile = {
      ...copyProfile(current),
      displayName,
      driverIds: request.driverIds === undefined ? [...current.driverIds] : validateDriverIds(request.driverIds),
      maximumDataBoundary: request.maximumDataBoundary ?? current.maximumDataBoundary,
      credentialReference: request.clearCredentialReference ? undefined : validateCredentialReference(request.credentialReference ?? current.credentialReference),
      revision: current.revision + 1,
      updatedAt: request.at,
      reviewedBy: request.reviewedBy,
      note: validateNote(request.note) ?? current.note,
    };
    assertDataBoundary(next.maximumDataBoundary);
    this.store.append(next);
    return copyProfile(next);
  }

  activate(id: string, reviewedBy: string, at: number, note?: string): ProviderProfile {
    return this.transition(id, 'active', reviewedBy, at, note);
  }

  disable(id: string, reviewedBy: string, at: number, note?: string): ProviderProfile {
    return this.transition(id, 'disabled', reviewedBy, at, note);
  }

  revoke(id: string, reviewedBy: string, at: number, note?: string): ProviderProfile {
    return this.transition(id, 'revoked', reviewedBy, at, note);
  }

  /** 回滚只复制历史 metadata 为一个全新 active revision；它不会恢复或读取任何 secret。 */
  rollback(id: string, revision: number, reviewedBy: string, at: number, note?: string): ProviderProfile {
    assertIdentifier(id, 'id');
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error('revision 必须为正安全整数');
    const current = this.requireMutable(id);
    const previous = this.store.history(id).find((entry) => entry.revision === revision);
    if (!previous) throw new Error(`provider profile revision ${revision} 不存在`);
    const next: ProviderProfile = {
      ...copyProfile(previous),
      status: 'active',
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: at,
      reviewedBy,
      activatedAt: at,
      disabledAt: undefined,
      revokedAt: undefined,
      note: validateNote(note) ?? `从 revision ${revision} 回滚的配置快照`,
    };
    this.store.append(next);
    return copyProfile(next);
  }

  get(id: string): ProviderProfile | undefined {
    return this.store.load(id);
  }

  list(): readonly ProviderProfile[] {
    return this.store.list();
  }

  history(id: string): readonly ProviderProfile[] {
    return this.store.history(id);
  }

  /** 仅 active profile 可将其 driver allowlist 交给 ModelRouter。 */
  route(id: string, request: ProfileRouteRequest, router: ModelRouter): ProviderProfileRouteDecision {
    const profile = this.require(id);
    if (profile.status !== 'active') throw new Error(`provider profile ${id} 尚未激活`);
    const effectiveDataBoundary = minimumBoundary(profile.maximumDataBoundary, request.dataBoundary ?? profile.maximumDataBoundary);
    const decision = router.decide({
      ...request,
      dataBoundary: effectiveDataBoundary,
      allowedDriverIds: profile.driverIds,
    });
    return {
      profileId: profile.id,
      profileRevision: profile.revision,
      effectiveDataBoundary,
      selectedDriverId: decision.driver.id(),
      decision,
      reason: `Profile ${profile.id}@${profile.revision} 将候选限制为 [${profile.driverIds.join(', ')}]，数据边界 ${effectiveDataBoundary}；${decision.reason}`,
    };
  }

  private transition(id: string, status: ProviderProfileStatus, reviewedBy: string, at: number, note?: string): ProviderProfile {
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (!STATUSES.has(status)) throw new Error('provider profile status 未被支持');
    const current = this.requireMutable(id);
    if (current.status === status) return current;
    const allowed: Readonly<Record<ProviderProfileStatus, readonly ProviderProfileStatus[]>> = {
      registered: ['active', 'disabled', 'revoked'],
      active: ['disabled', 'revoked'],
      disabled: ['active', 'revoked'],
      revoked: [],
    };
    if (!allowed[current.status].includes(status)) throw new Error(`provider profile 不能从 ${current.status} 变为 ${status}`);
    const next: ProviderProfile = {
      ...copyProfile(current),
      status,
      revision: current.revision + 1,
      updatedAt: at,
      reviewedBy,
      activatedAt: status === 'active' ? at : current.activatedAt,
      disabledAt: status === 'disabled' ? at : current.disabledAt,
      revokedAt: status === 'revoked' ? at : current.revokedAt,
      note: validateNote(note) ?? current.note,
    };
    this.store.append(next);
    return copyProfile(next);
  }

  private require(id: string): ProviderProfile {
    assertIdentifier(id, 'id');
    const profile = this.store.load(id);
    if (!profile) throw new Error(`provider profile ${id} 不存在`);
    return profile;
  }

  private requireMutable(id: string): ProviderProfile {
    const profile = this.require(id);
    if (profile.status === 'revoked') throw new Error('已撤销 provider profile 不得被修改、激活或回滚；请重新登记');
    return profile;
  }
}
