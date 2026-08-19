import type { SessionPersistenceMode } from './session-control-plane.js';

export type MemoryKind = 'preference' | 'durable_fact' | 'working_note' | 'decision' | 'pending_intent';
export type MemoryStatus = 'candidate' | 'confirmed' | 'superseded' | 'retracted';
export type MemoryTrust = 'user_confirmed' | 'trusted_local' | 'untrusted';

export interface MemoryScope {
  agentId: string;
  workspaceId: string;
  /** session 范围的记忆只能在同一 session 被检索；缺省时为 workspace 范围。 */
  sessionId?: string;
  /** 用于按项目/主题分组并给后续 UI 提供可浏览的层次。 */
  path?: string;
  /** incognito 会话不得创建或提升任何持久记忆。 */
  sessionPersistence?: SessionPersistenceMode;
}

export interface MemoryProvenance {
  sourceType: 'user' | 'session' | 'task' | 'knowledge' | 'system';
  sourceId: string;
  trust: MemoryTrust;
  citations?: readonly string[];
}

/**
 * 可持久化的记忆修订。文本只在本地 Store 中保存；模型上下文选择器仅输出有界 excerpt 与出处，
 * 不会把这条记录解释为权限、审批或工具授权。
 */
export interface MemoryRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: Readonly<MemoryScope>;
  content: string;
  excerpt: string;
  estimatedTokens: number;
  provenance: Readonly<MemoryProvenance>;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  supersedes?: string;
}

export interface MemoryRecordDraft {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  estimatedTokens: number;
  provenance: MemoryProvenance;
  at: number;
  expiresAt?: number;
  supersedes?: string;
}

export interface MemoryLedgerStore {
  load(id: string): MemoryRecord | undefined;
  append(record: MemoryRecord): void;
  list(): readonly MemoryRecord[];
}

export interface MemoryContextRequest {
  agentId: string;
  workspaceId: string;
  sessionId?: string;
  query: string;
  at: number;
  maxPreferenceTokens: number;
  maxOtherTokens: number;
}

export interface SelectedMemory {
  record: MemoryRecord;
  score: number;
  reason: 'preference_budget' | 'lexical_match' | 'scope_match';
  /** 记忆永远不等同于实时权限或审批。 */
  canAuthorize: false;
}

export interface MemoryContextSelection {
  preferences: readonly SelectedMemory[];
  otherMemories: readonly SelectedMemory[];
  omittedIds: readonly string[];
  preferenceTokens: number;
  otherTokens: number;
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} 必须是 1-128 位安全标识符`);
  }
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数毫秒时间戳`);
}

function assertBudget(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function copyScope(scope: MemoryScope): MemoryScope {
  return { ...scope };
}

function copyProvenance(provenance: MemoryProvenance): MemoryProvenance {
  return { ...provenance, citations: provenance.citations ? [...provenance.citations] : undefined };
}

export function copyMemoryRecord(record: MemoryRecord): MemoryRecord {
  return { ...record, scope: copyScope(record.scope), provenance: copyProvenance(record.provenance) };
}

function terms(value: string): readonly string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function validateScope(scope: MemoryScope): void {
  assertIdentifier(scope.agentId, 'scope.agentId');
  assertIdentifier(scope.workspaceId, 'scope.workspaceId');
  if (scope.sessionId !== undefined) assertIdentifier(scope.sessionId, 'scope.sessionId');
  if (scope.path !== undefined && (scope.path.length === 0 || scope.path.length > 240)) {
    throw new Error('scope.path 必须是 1-240 位非空路径');
  }
}

function validateDraft(draft: MemoryRecordDraft): void {
  assertIdentifier(draft.id, 'id');
  validateScope(draft.scope);
  if (draft.scope.sessionPersistence === 'incognito') {
    throw new Error('incognito 会话不得创建持久 MemoryRecord');
  }
  if (!draft.content.trim()) throw new Error('content 不能为空');
  if (!Number.isSafeInteger(draft.estimatedTokens) || draft.estimatedTokens < 0) {
    throw new Error('estimatedTokens 必须是非负安全整数');
  }
  assertIdentifier(draft.provenance.sourceId, 'provenance.sourceId');
  assertEpoch(draft.at, 'at');
  if (draft.expiresAt !== undefined && draft.expiresAt <= draft.at) {
    throw new Error('expiresAt 必须晚于 at');
  }
  if (draft.supersedes !== undefined) assertIdentifier(draft.supersedes, 'supersedes');
}

function defaultReason(record: MemoryRecord, lexicalScore: number): SelectedMemory['reason'] {
  if (record.kind === 'preference') return 'preference_budget';
  return lexicalScore > 0 ? 'lexical_match' : 'scope_match';
}

function kindWeight(kind: MemoryKind): number {
  return { preference: 5, decision: 4, durable_fact: 3, pending_intent: 2, working_note: 1 }[kind];
}

export class InMemoryMemoryLedgerStore implements MemoryLedgerStore {
  private readonly records = new Map<string, MemoryRecord>();

  load(id: string): MemoryRecord | undefined {
    const record = this.records.get(id);
    return record ? copyMemoryRecord(record) : undefined;
  }

  append(record: MemoryRecord): void {
    const current = this.records.get(record.id);
    if (current && record.revision !== current.revision + 1) {
      throw new Error(`记忆 ${record.id} 的 revision 必须递增`);
    }
    if (!current && record.revision !== 1) throw new Error(`新记忆 ${record.id} 的 revision 必须为 1`);
    this.records.set(record.id, copyMemoryRecord(record));
  }

  list(): readonly MemoryRecord[] {
    return [...this.records.values()]
      .map(copyMemoryRecord)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }
}

/**
 * 受审查的长期记忆账本。它不负责抽取、摘要、模型调用或工具授权；上层需显式将候选升格为 confirmed。
 */
export class MemoryLedger {
  constructor(private readonly store: MemoryLedgerStore) {}

  addCandidate(draft: MemoryRecordDraft): MemoryRecord {
    validateDraft(draft);
    if (this.store.load(draft.id)) throw new Error(`记忆 ${draft.id} 已存在`);
    const record: MemoryRecord = {
      schemaVersion: 1,
      id: draft.id,
      revision: 1,
      kind: draft.kind,
      status: 'candidate',
      scope: copyScope(draft.scope),
      content: draft.content.trim(),
      excerpt: draft.content.trim().slice(0, 320),
      estimatedTokens: draft.estimatedTokens,
      provenance: copyProvenance(draft.provenance),
      createdAt: draft.at,
      updatedAt: draft.at,
      expiresAt: draft.expiresAt,
      supersedes: draft.supersedes,
    };
    this.store.append(record);
    return copyMemoryRecord(record);
  }

  confirm(id: string, at: number): MemoryRecord {
    return this.revise(id, at, (current) => ({ ...current, status: 'confirmed' }));
  }

  retract(id: string, at: number): MemoryRecord {
    return this.revise(id, at, (current) => ({ ...current, status: 'retracted' }));
  }

  supersede(id: string, at: number): MemoryRecord {
    return this.revise(id, at, (current) => ({ ...current, status: 'superseded' }));
  }

  get(id: string): MemoryRecord | undefined {
    assertIdentifier(id, 'id');
    const record = this.store.load(id);
    return record ? copyMemoryRecord(record) : undefined;
  }

  list(): readonly MemoryRecord[] {
    return this.store.list().map(copyMemoryRecord);
  }

  selectForContext(request: MemoryContextRequest): MemoryContextSelection {
    assertIdentifier(request.agentId, 'agentId');
    assertIdentifier(request.workspaceId, 'workspaceId');
    if (request.sessionId !== undefined) assertIdentifier(request.sessionId, 'sessionId');
    assertEpoch(request.at, 'at');
    assertBudget(request.maxPreferenceTokens, 'maxPreferenceTokens');
    assertBudget(request.maxOtherTokens, 'maxOtherTokens');
    const queryTerms = terms(request.query);
    const candidates = this.store.list().flatMap((record) => {
      if (record.status !== 'confirmed' || record.scope.agentId !== request.agentId || record.scope.workspaceId !== request.workspaceId) return [];
      if (record.scope.sessionId !== undefined && record.scope.sessionId !== request.sessionId) return [];
      if (record.expiresAt !== undefined && record.expiresAt <= request.at) return [];
      const lower = `${record.content}\n${record.scope.path ?? ''}`.toLocaleLowerCase();
      const lexicalScore = queryTerms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
      const score = kindWeight(record.kind) + lexicalScore * 10 + (record.scope.sessionId === request.sessionId && request.sessionId ? 2 : 0);
      return [{ record, lexicalScore, score }];
    }).sort((left, right) => right.score - left.score || right.record.updatedAt - left.record.updatedAt || left.record.id.localeCompare(right.record.id));

    const preferences: SelectedMemory[] = [];
    const otherMemories: SelectedMemory[] = [];
    const omittedIds: string[] = [];
    let preferenceTokens = 0;
    let otherTokens = 0;
    for (const candidate of candidates) {
      const isPreference = candidate.record.kind === 'preference';
      const tokens = candidate.record.estimatedTokens;
      const allowed = isPreference
        ? preferenceTokens + tokens <= request.maxPreferenceTokens
        : otherTokens + tokens <= request.maxOtherTokens;
      if (!allowed) {
        omittedIds.push(candidate.record.id);
        continue;
      }
      const selected: SelectedMemory = {
        record: copyMemoryRecord(candidate.record),
        score: candidate.score,
        reason: defaultReason(candidate.record, candidate.lexicalScore),
        canAuthorize: false,
      };
      if (isPreference) {
        preferenceTokens += tokens;
        preferences.push(selected);
      } else {
        otherTokens += tokens;
        otherMemories.push(selected);
      }
    }
    return { preferences, otherMemories, omittedIds, preferenceTokens, otherTokens };
  }

  private revise(id: string, at: number, transform: (current: MemoryRecord) => MemoryRecord): MemoryRecord {
    assertIdentifier(id, 'id');
    assertEpoch(at, 'at');
    const current = this.store.load(id);
    if (!current) throw new Error(`记忆 ${id} 不存在`);
    if (current.scope.sessionPersistence === 'incognito') {
      throw new Error('incognito 会话记忆不得修订或持久化');
    }
    const transformed = transform(copyMemoryRecord(current));
    const next: MemoryRecord = {
      ...transformed,
      scope: copyScope(transformed.scope),
      provenance: copyProvenance(transformed.provenance),
      revision: current.revision + 1,
      updatedAt: at,
    };
    this.store.append(next);
    return copyMemoryRecord(next);
  }
}
