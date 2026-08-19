import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionPersistenceMode } from '../../knowledge-workspace.js';

export type SkillPackStatus = 'candidate' | 'reviewed' | 'published' | 'disabled' | 'revoked';
export type SkillPackSourceType = 'local-path' | 'git' | 'registry' | 'manual';

/**
 * 纯文本技能包的不可变来源信息。它只说明文本从何而来，不携带运行入口、密钥或工具连接。
 */
export interface SkillPackSource {
  type: SkillPackSourceType;
  locator: string;
  digest: string;
}

/**
 * 限制技能文本可以在哪些受控工作区与 agent 上被显式引用；空数组表示不额外限制。
 */
export interface SkillPackScope {
  workspaceIds?: readonly string[];
  agentIds?: readonly string[];
}

export interface SkillPackInjectionPolicy {
  /** 单次引用该技能包时可贡献的最大 token；始终取 content 估算与此上限的较小值。 */
  maxTokens: number;
  /** 固定为 true：系统不得因为检索相似度或名称猜测自动注入技能包。 */
  requiresExplicitReference: true;
  /** 固定为 false：指令文本不是审批、授权或 policy rule。 */
  canAuthorize: false;
  /** 固定为 false：技能文本不能增加 tool capability。 */
  canGrantCapabilities: false;
}

/**
 * 受治理的 Skill Pack 修订。content 仅接受本地纯文本；没有动态 import、entrypoint 或执行权限字段。
 */
export interface SkillPackManifestV1 {
  schemaVersion: 1;
  id: string;
  revision: number;
  status: SkillPackStatus;
  version: string;
  displayName: string;
  source: Readonly<SkillPackSource>;
  content: string;
  estimatedTokens: number;
  scope: Readonly<SkillPackScope>;
  injectionPolicy: Readonly<SkillPackInjectionPolicy>;
  reviewedBy?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterSkillPackCandidateRequest {
  id: string;
  version: string;
  displayName: string;
  source: SkillPackSource;
  content: string;
  estimatedTokens?: number;
  scope?: SkillPackScope;
  maxInjectionTokens?: number;
  note?: string;
  at: number;
}

export interface SkillPackStore {
  load(id: string): SkillPackManifestV1 | undefined;
  history(id: string): readonly SkillPackManifestV1[];
  append(manifest: SkillPackManifestV1): void;
  list(): readonly SkillPackManifestV1[];
}

export type SkillPackOmissionReason = 'missing' | 'not_published' | 'out_of_scope' | 'over_token_budget';

export interface SkillPackContextInjection {
  kind: 'skill-pack';
  packId: string;
  packRevision: number;
  version: string;
  displayName: string;
  source: Readonly<SkillPackSource>;
  content: string;
  estimatedTokens: number;
  canAuthorize: false;
  canGrantCapabilities: false;
  /** 调用方必须在实际上下文装配前重新向账本确认该 pack 仍为 published。 */
  revocation: Readonly<{ packId: string; verifyAtUse: true }>;
}

export interface SkillPackInjectionRequest {
  workspaceId: string;
  agentId: string;
  persistence: SessionPersistenceMode;
  /** 按调用方顺序显式引用；空数组不会得到任何隐式匹配。 */
  packIds: readonly string[];
  maxTokens: number;
  at: number;
}

export interface SkillPackOmission {
  packId: string;
  reason: SkillPackOmissionReason;
}

/**
 * 可审查的上下文装配决定。它并不调用模型、运行脚本或写入知识索引。
 */
export interface SkillPackInjectionPlan {
  schemaVersion: 1;
  workspaceId: string;
  agentId: string;
  at: number;
  requestedPackIds: readonly string[];
  injected: readonly SkillPackContextInjection[];
  omitted: readonly SkillPackOmission[];
  totalEstimatedTokens: number;
  implicitSelection: false;
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} 必须是 1-128 位安全标识符`);
  }
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数毫秒时间戳`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正安全整数`);
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('source.digest 必须是 64 位 SHA-256 十六进制摘要');
}

function assertVersion(value: string): void {
  if (!/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) {
    throw new Error('version 必须是语义化版本');
  }
}

function estimatedTokensFor(content: string): number {
  return Math.ceil(content.length / 4);
}

function copySource(source: SkillPackSource): SkillPackSource {
  return { ...source };
}

function copyScope(scope: SkillPackScope): SkillPackScope {
  return {
    workspaceIds: scope.workspaceIds ? [...scope.workspaceIds] : undefined,
    agentIds: scope.agentIds ? [...scope.agentIds] : undefined,
  };
}

function copyPolicy(policy: SkillPackInjectionPolicy): SkillPackInjectionPolicy {
  return { ...policy };
}

export function copySkillPackManifest(manifest: SkillPackManifestV1): SkillPackManifestV1 {
  return {
    ...manifest,
    source: copySource(manifest.source),
    scope: copyScope(manifest.scope),
    injectionPolicy: copyPolicy(manifest.injectionPolicy),
  };
}

function copyInjection(injection: SkillPackContextInjection): SkillPackContextInjection {
  return {
    ...injection,
    source: copySource(injection.source),
    revocation: { ...injection.revocation },
  };
}

function validateSource(source: SkillPackSource): void {
  if (!['local-path', 'git', 'registry', 'manual'].includes(source.type)) {
    throw new Error('source.type 必须是 local-path、git、registry 或 manual');
  }
  if (!source.locator.trim() || source.locator.length > 1_024) {
    throw new Error('source.locator 必须是 1-1024 位非空定位符');
  }
  assertDigest(source.digest);
}

function validateScope(scope: SkillPackScope): void {
  for (const [field, ids] of [['scope.workspaceIds', scope.workspaceIds], ['scope.agentIds', scope.agentIds]] as const) {
    if (!ids) continue;
    if (ids.length > 64) throw new Error(`${field} 不得超过 64 个标识`);
    const unique = new Set(ids);
    if (unique.size !== ids.length) throw new Error(`${field} 不得包含重复标识`);
    for (const id of ids) assertIdentifier(id, field);
  }
}

function validateCandidate(request: RegisterSkillPackCandidateRequest): void {
  assertIdentifier(request.id, 'id');
  assertVersion(request.version);
  if (!request.displayName.trim() || request.displayName.trim().length > 160) {
    throw new Error('displayName 必须是 1-160 位非空文本');
  }
  validateSource(request.source);
  if (!request.content.trim()) throw new Error('Skill Pack content 不能为空');
  if (request.content.includes('\0') || request.content.length > 120_000) {
    throw new Error('Skill Pack 只接受不超过 120000 字符的纯文本');
  }
  const estimatedTokens = request.estimatedTokens ?? estimatedTokensFor(request.content);
  assertPositiveInteger(estimatedTokens, 'estimatedTokens');
  const maxTokens = request.maxInjectionTokens ?? estimatedTokens;
  assertPositiveInteger(maxTokens, 'maxInjectionTokens');
  if (maxTokens > estimatedTokens) throw new Error('maxInjectionTokens 不得大于 estimatedTokens');
  validateScope(request.scope ?? {});
  if (request.note !== undefined && request.note.length > 2_000) throw new Error('note 不得超过 2000 个字符');
  assertEpoch(request.at, 'at');
}

function validateReviewer(value: string): void {
  assertIdentifier(value, 'reviewedBy');
}

function canTransition(from: SkillPackStatus, to: SkillPackStatus): boolean {
  return {
    candidate: to === 'reviewed' || to === 'revoked',
    reviewed: to === 'published' || to === 'revoked',
    published: to === 'disabled' || to === 'revoked',
    disabled: to === 'published' || to === 'revoked',
    revoked: false,
  }[from];
}

function scopeAllows(scope: SkillPackScope, workspaceId: string, agentId: string): boolean {
  return (!scope.workspaceIds || scope.workspaceIds.includes(workspaceId))
    && (!scope.agentIds || scope.agentIds.includes(agentId));
}

function injectionFrom(manifest: SkillPackManifestV1): SkillPackContextInjection {
  return {
    kind: 'skill-pack',
    packId: manifest.id,
    packRevision: manifest.revision,
    version: manifest.version,
    displayName: manifest.displayName,
    source: copySource(manifest.source),
    content: manifest.content,
    estimatedTokens: Math.min(manifest.estimatedTokens, manifest.injectionPolicy.maxTokens),
    canAuthorize: false,
    canGrantCapabilities: false,
    revocation: { packId: manifest.id, verifyAtUse: true },
  };
}

export class InMemorySkillPackStore implements SkillPackStore {
  private readonly records = new Map<string, SkillPackManifestV1[]>();

  load(id: string): SkillPackManifestV1 | undefined {
    const history = this.records.get(id);
    const current = history?.at(-1);
    return current ? copySkillPackManifest(current) : undefined;
  }

  history(id: string): readonly SkillPackManifestV1[] {
    return (this.records.get(id) ?? []).map(copySkillPackManifest);
  }

  append(manifest: SkillPackManifestV1): void {
    const history = this.records.get(manifest.id) ?? [];
    const current = history.at(-1);
    if (!current && manifest.revision !== 1) throw new Error(`Skill Pack ${manifest.id} 的首个 revision 必须为 1`);
    if (current && manifest.revision !== current.revision + 1) throw new Error(`Skill Pack ${manifest.id} 的 revision 必须递增`);
    this.records.set(manifest.id, [...history, copySkillPackManifest(manifest)]);
  }

  list(): readonly SkillPackManifestV1[] {
    return [...this.records.values()]
      .map((history) => history.at(-1))
      .filter((manifest): manifest is SkillPackManifestV1 => Boolean(manifest))
      .map(copySkillPackManifest)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }
}

interface SkillPackRow {
  id: string;
  revision: number;
  status: SkillPackStatus;
  version: string;
  display_name: string;
  source_json: string;
  content: string;
  estimated_tokens: number;
  scope_json: string;
  max_injection_tokens: number;
  reviewed_by: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 追加式 SQLite Skill Pack 账本。每次审查、发布、停用与撤销均新增修订，便于离线审计与恢复。
 */
export class SqliteSkillPackStore implements SkillPackStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_pack_revisions (
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate', 'reviewed', 'published', 'disabled', 'revoked')),
        version TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source_json TEXT NOT NULL,
        content TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        scope_json TEXT NOT NULL,
        max_injection_tokens INTEGER NOT NULL,
        reviewed_by TEXT,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_pack_revisions_latest ON skill_pack_revisions (id, revision DESC);
    `);
  }

  load(id: string): SkillPackManifestV1 | undefined {
    const row = this.db.prepare(`
      SELECT id, revision, status, version, display_name, source_json, content, estimated_tokens, scope_json,
        max_injection_tokens, reviewed_by, note, created_at, updated_at
      FROM skill_pack_revisions WHERE id = ? ORDER BY revision DESC LIMIT 1
    `).get(id) as SkillPackRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  history(id: string): readonly SkillPackManifestV1[] {
    const rows = this.db.prepare(`
      SELECT id, revision, status, version, display_name, source_json, content, estimated_tokens, scope_json,
        max_injection_tokens, reviewed_by, note, created_at, updated_at
      FROM skill_pack_revisions WHERE id = ? ORDER BY revision ASC
    `).all(id) as unknown as readonly SkillPackRow[];
    return rows.map((row) => this.fromRow(row));
  }

  append(manifest: SkillPackManifestV1): void {
    const current = this.load(manifest.id);
    if (!current && manifest.revision !== 1) throw new Error(`Skill Pack ${manifest.id} 的首个 revision 必须为 1`);
    if (current && manifest.revision !== current.revision + 1) throw new Error(`Skill Pack ${manifest.id} 的 revision 必须递增`);
    this.db.prepare(`
      INSERT INTO skill_pack_revisions (
        id, revision, status, version, display_name, source_json, content, estimated_tokens, scope_json,
        max_injection_tokens, reviewed_by, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      manifest.id, manifest.revision, manifest.status, manifest.version, manifest.displayName,
      JSON.stringify(manifest.source), manifest.content, manifest.estimatedTokens, JSON.stringify(manifest.scope),
      manifest.injectionPolicy.maxTokens, manifest.reviewedBy ?? null, manifest.note ?? null,
      manifest.createdAt, manifest.updatedAt,
    );
  }

  list(): readonly SkillPackManifestV1[] {
    const rows = this.db.prepare(`
      SELECT r.id, r.revision, r.status, r.version, r.display_name, r.source_json, r.content, r.estimated_tokens, r.scope_json,
        r.max_injection_tokens, r.reviewed_by, r.note, r.created_at, r.updated_at
      FROM skill_pack_revisions r
      INNER JOIN (SELECT id, MAX(revision) AS revision FROM skill_pack_revisions GROUP BY id) latest
        ON latest.id = r.id AND latest.revision = r.revision
      ORDER BY r.display_name ASC, r.id ASC
    `).all() as unknown as readonly SkillPackRow[];
    return rows.map((row) => this.fromRow(row));
  }

  close(): void {
    this.db.close();
  }

  private fromRow(row: SkillPackRow): SkillPackManifestV1 {
    const source = JSON.parse(row.source_json) as SkillPackSource;
    const scope = JSON.parse(row.scope_json) as SkillPackScope;
    return {
      schemaVersion: 1,
      id: row.id,
      revision: row.revision,
      status: row.status,
      version: row.version,
      displayName: row.display_name,
      source: copySource(source),
      content: row.content,
      estimatedTokens: row.estimated_tokens,
      scope: copyScope(scope),
      injectionPolicy: {
        maxTokens: row.max_injection_tokens,
        requiresExplicitReference: true,
        canAuthorize: false,
        canGrantCapabilities: false,
      },
      reviewedBy: row.reviewed_by ?? undefined,
      note: row.note ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * Skill Pack 的控制面。它只治理纯文本上下文，绝不下载、解析可执行物、调用工具或放宽运行时 policy。
 */
export class SkillPackRegistry {
  constructor(private readonly store: SkillPackStore) {}

  registerCandidate(request: RegisterSkillPackCandidateRequest): SkillPackManifestV1 {
    validateCandidate(request);
    if (this.store.load(request.id)) throw new Error(`Skill Pack ${request.id} 已存在；请创建新的版本化 id 或撤销后保留审计历史`);
    const estimatedTokens = request.estimatedTokens ?? estimatedTokensFor(request.content);
    const maxTokens = request.maxInjectionTokens ?? estimatedTokens;
    const manifest: SkillPackManifestV1 = {
      schemaVersion: 1,
      id: request.id,
      revision: 1,
      status: 'candidate',
      version: request.version,
      displayName: request.displayName.trim(),
      source: copySource(request.source),
      content: request.content.trim(),
      estimatedTokens,
      scope: copyScope(request.scope ?? {}),
      injectionPolicy: { maxTokens, requiresExplicitReference: true, canAuthorize: false, canGrantCapabilities: false },
      note: request.note?.trim() || undefined,
      createdAt: request.at,
      updatedAt: request.at,
    };
    this.store.append(manifest);
    return copySkillPackManifest(manifest);
  }

  review(id: string, reviewedBy: string, at: number, note?: string): SkillPackManifestV1 {
    validateReviewer(reviewedBy);
    return this.transition(id, 'reviewed', reviewedBy, at, note);
  }

  publish(id: string, verifiedDigest: string, reviewedBy: string, at: number, note?: string): SkillPackManifestV1 {
    assertDigest(verifiedDigest);
    const current = this.require(id);
    if (current.source.digest.toLocaleLowerCase() !== verifiedDigest.toLocaleLowerCase()) {
      throw new Error(`Skill Pack ${id} 的 source digest 与审查时提供的摘要不一致`);
    }
    return this.transition(id, 'published', reviewedBy, at, note);
  }

  disable(id: string, reviewedBy: string, at: number, note?: string): SkillPackManifestV1 {
    return this.transition(id, 'disabled', reviewedBy, at, note);
  }

  revoke(id: string, reviewedBy: string, at: number, note?: string): SkillPackManifestV1 {
    return this.transition(id, 'revoked', reviewedBy, at, note);
  }

  get(id: string): SkillPackManifestV1 | undefined {
    assertIdentifier(id, 'id');
    const manifest = this.store.load(id);
    return manifest ? copySkillPackManifest(manifest) : undefined;
  }

  list(): readonly SkillPackManifestV1[] {
    return this.store.list().map(copySkillPackManifest);
  }

  history(id: string): readonly SkillPackManifestV1[] {
    assertIdentifier(id, 'id');
    return this.store.history(id).map(copySkillPackManifest);
  }

  eligible(): readonly SkillPackManifestV1[] {
    return this.list().filter((manifest) => manifest.status === 'published');
  }

  /**
   * 对明确列出的 pack 做确定性的 token 预算装配；不存在相似度召回或默认启用行为。
   */
  prepareInjections(request: SkillPackInjectionRequest): SkillPackInjectionPlan {
    assertIdentifier(request.workspaceId, 'workspaceId');
    assertIdentifier(request.agentId, 'agentId');
    assertPositiveInteger(request.maxTokens, 'maxTokens');
    assertEpoch(request.at, 'at');
    if (request.persistence === 'incognito') throw new Error('incognito 会话不得从持久 Skill Pack 账本注入上下文');
    const uniquePackIds = new Set<string>();
    const injected: SkillPackContextInjection[] = [];
    const omitted: SkillPackOmission[] = [];
    let totalEstimatedTokens = 0;
    for (const id of request.packIds) {
      assertIdentifier(id, 'packIds[]');
      if (uniquePackIds.has(id)) continue;
      uniquePackIds.add(id);
      const manifest = this.store.load(id);
      if (!manifest) {
        omitted.push({ packId: id, reason: 'missing' });
        continue;
      }
      if (manifest.status !== 'published') {
        omitted.push({ packId: id, reason: 'not_published' });
        continue;
      }
      if (!scopeAllows(manifest.scope, request.workspaceId, request.agentId)) {
        omitted.push({ packId: id, reason: 'out_of_scope' });
        continue;
      }
      const injection = injectionFrom(manifest);
      if (totalEstimatedTokens + injection.estimatedTokens > request.maxTokens) {
        omitted.push({ packId: id, reason: 'over_token_budget' });
        continue;
      }
      totalEstimatedTokens += injection.estimatedTokens;
      injected.push(injection);
    }
    return {
      schemaVersion: 1,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      at: request.at,
      requestedPackIds: [...uniquePackIds],
      injected: injected.map(copyInjection),
      omitted: omitted.map((item) => ({ ...item })),
      totalEstimatedTokens,
      implicitSelection: false,
    };
  }

  /**
   * 在真正发送模型上下文前，使用该检查阻断已停用、撤销或替换修订的旧注入对象。
   */
  assertInjectionCurrent(injection: SkillPackContextInjection): void {
    if (injection.kind !== 'skill-pack' || !injection.revocation.verifyAtUse || injection.canAuthorize || injection.canGrantCapabilities) {
      throw new Error('Skill Pack injection 违反不可授权的上下文契约');
    }
    const current = this.require(injection.packId);
    if (current.status !== 'published' || current.revision !== injection.packRevision) {
      throw new Error(`Skill Pack ${injection.packId} 已停用、撤销或更新；不得继续注入旧上下文`);
    }
  }

  private transition(id: string, status: SkillPackStatus, reviewedBy: string, at: number, note?: string): SkillPackManifestV1 {
    assertIdentifier(id, 'id');
    validateReviewer(reviewedBy);
    assertEpoch(at, 'at');
    if (note !== undefined && note.length > 2_000) throw new Error('note 不得超过 2000 个字符');
    const current = this.require(id);
    if (!canTransition(current.status, status)) {
      throw new Error(`Skill Pack ${id} 不能从 ${current.status} 变更为 ${status}`);
    }
    const next: SkillPackManifestV1 = {
      ...current,
      source: copySource(current.source),
      scope: copyScope(current.scope),
      injectionPolicy: copyPolicy(current.injectionPolicy),
      revision: current.revision + 1,
      status,
      reviewedBy,
      note: note?.trim() || current.note,
      updatedAt: at,
    };
    this.store.append(next);
    return copySkillPackManifest(next);
  }

  private require(id: string): SkillPackManifestV1 {
    assertIdentifier(id, 'id');
    const manifest = this.store.load(id);
    if (!manifest) throw new Error(`Skill Pack ${id} 不存在`);
    return manifest;
  }
}
