export type SessionPersistenceMode = 'durable' | 'ephemeral' | 'incognito';
export type SessionSourceKind = 'workbench' | 'task' | 'subtask' | 'schedule';
export type LocalSessionStatus = 'active' | 'archived';

export interface LocalSessionScope {
  /** 未来 persona 隔离键；不得复用 AgentProfileId。 */
  agentId: string;
  workspaceId: string;
  sourceKind: SessionSourceKind;
  sourceId: string;
  persistence: SessionPersistenceMode;
}

/**
 * 会话元数据快照。此模型刻意不包含原始 transcript、模型 token 或工具 payload；这些内容必须经过
 * 独立、脱敏且有界的事件/引用路径消费。
 */
export interface LocalSessionSnapshot {
  schemaVersion: 1;
  sessionId: string;
  scope: Readonly<LocalSessionScope>;
  status: LocalSessionStatus;
  title?: string;
  stateVersion: number;
  createdAt: number;
  lastInteractionAt: number;
  updatedAt: number;
  archivedAt?: number;
  pinned: boolean;
}

export interface SessionSnapshotStore {
  load(sessionId: string): LocalSessionSnapshot | undefined;
  save(snapshot: LocalSessionSnapshot): void;
  list(): readonly LocalSessionSnapshot[];
}

export interface CreateSessionRequest {
  sessionId: string;
  scope: LocalSessionScope;
  at: number;
  title?: string;
}

export interface SessionMutationRequest {
  sessionId: string;
  at: number;
  expectedStateVersion?: number;
}

export interface ResetSessionRequest extends SessionMutationRequest {
  nextSessionId: string;
}

export class SessionVersionConflictError extends Error {
  constructor(sessionId: string, expected: number, actual: number) {
    super(`会话 ${sessionId} 版本冲突：期望 ${expected}，当前为 ${actual}`);
    this.name = 'SessionVersionConflictError';
  }
}

function requireIdentifier(value: string, field: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${field} 必须是 1-128 位的安全标识符`);
  }
}

function requireEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} 必须是非负安全整数毫秒时间戳`);
  }
}

function copyScope(scope: LocalSessionScope): LocalSessionScope {
  return { ...scope };
}

export function copySessionSnapshot(snapshot: LocalSessionSnapshot): LocalSessionSnapshot {
  return { ...snapshot, scope: copyScope(snapshot.scope) };
}

function validateScope(scope: LocalSessionScope): void {
  requireIdentifier(scope.agentId, 'agentId');
  requireIdentifier(scope.workspaceId, 'workspaceId');
  requireIdentifier(scope.sourceId, 'sourceId');
}

function validateCreateRequest(request: CreateSessionRequest): void {
  requireIdentifier(request.sessionId, 'sessionId');
  validateScope(request.scope);
  requireEpoch(request.at, 'at');
  if (request.title !== undefined && request.title.trim().length === 0) {
    throw new Error('title 不能是空白字符串');
  }
}

/** 用于测试和开发的持久化 store 替身；存储和读取均使用防御性副本。 */
export class InMemorySessionSnapshotStore implements SessionSnapshotStore {
  private readonly snapshots = new Map<string, LocalSessionSnapshot>();

  load(sessionId: string): LocalSessionSnapshot | undefined {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot ? copySessionSnapshot(snapshot) : undefined;
  }

  save(snapshot: LocalSessionSnapshot): void {
    this.snapshots.set(snapshot.sessionId, copySessionSnapshot(snapshot));
  }

  list(): readonly LocalSessionSnapshot[] {
    return [...this.snapshots.values()]
      .map(copySessionSnapshot)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
  }
}

/**
 * 本地会话控制面。durable 会话才进入注入的持久化 store；ephemeral 和 incognito 都仅在进程内存中，
 * 其中 incognito 还被 API 显式标识，供后续检索/审计适配器施加更严格边界。
 */
export class LocalSessionControlPlane {
  private readonly transient = new Map<string, LocalSessionSnapshot>();

  constructor(private readonly durableStore: SessionSnapshotStore) {}

  create(request: CreateSessionRequest): LocalSessionSnapshot {
    validateCreateRequest(request);
    if (this.loadInternal(request.sessionId)) {
      throw new Error(`sessionId ${request.sessionId} 已存在`);
    }
    const title = request.title?.trim();
    const snapshot: LocalSessionSnapshot = {
      schemaVersion: 1,
      sessionId: request.sessionId,
      scope: copyScope(request.scope),
      status: 'active',
      title,
      stateVersion: 1,
      createdAt: request.at,
      lastInteractionAt: request.at,
      updatedAt: request.at,
      pinned: false,
    };
    this.saveInternal(snapshot);
    return copySessionSnapshot(snapshot);
  }

  get(sessionId: string): LocalSessionSnapshot | undefined {
    requireIdentifier(sessionId, 'sessionId');
    const snapshot = this.loadInternal(sessionId);
    return snapshot ? copySessionSnapshot(snapshot) : undefined;
  }

  list(): readonly LocalSessionSnapshot[] {
    const merged = new Map<string, LocalSessionSnapshot>();
    for (const snapshot of this.durableStore.list()) merged.set(snapshot.sessionId, snapshot);
    for (const [sessionId, snapshot] of this.transient) merged.set(sessionId, snapshot);
    return [...merged.values()]
      .map(copySessionSnapshot)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
  }

  touch(request: SessionMutationRequest): LocalSessionSnapshot {
    return this.mutate(request, (current) => ({
      ...current,
      lastInteractionAt: request.at,
      updatedAt: request.at,
    }));
  }

  pin(request: SessionMutationRequest, pinned: boolean): LocalSessionSnapshot {
    return this.mutate(request, (current) => ({ ...current, pinned, updatedAt: request.at }));
  }

  archive(request: SessionMutationRequest): LocalSessionSnapshot {
    return this.mutate(request, (current) => ({
      ...current,
      status: 'archived',
      archivedAt: request.at,
      updatedAt: request.at,
    }));
  }

  reset(request: ResetSessionRequest): LocalSessionSnapshot {
    requireIdentifier(request.nextSessionId, 'nextSessionId');
    requireEpoch(request.at, 'at');
    const current = this.requireCurrent(request);
    if (this.loadInternal(request.nextSessionId)) {
      throw new Error(`nextSessionId ${request.nextSessionId} 已存在`);
    }
    const archived = this.next(current, request, (value) => ({
      ...value,
      status: 'archived',
      archivedAt: request.at,
      updatedAt: request.at,
    }));
    this.saveInternal(archived);
    return this.create({
      sessionId: request.nextSessionId,
      scope: copyScope(current.scope),
      at: request.at,
      title: current.title,
    });
  }

  private mutate(
    request: SessionMutationRequest,
    transform: (current: LocalSessionSnapshot) => LocalSessionSnapshot,
  ): LocalSessionSnapshot {
    requireEpoch(request.at, 'at');
    const current = this.requireCurrent(request);
    const next = this.next(current, request, transform);
    this.saveInternal(next);
    return copySessionSnapshot(next);
  }

  private requireCurrent(request: SessionMutationRequest): LocalSessionSnapshot {
    requireIdentifier(request.sessionId, 'sessionId');
    const current = this.loadInternal(request.sessionId);
    if (!current) throw new Error(`sessionId ${request.sessionId} 不存在`);
    if (request.expectedStateVersion !== undefined && request.expectedStateVersion !== current.stateVersion) {
      throw new SessionVersionConflictError(request.sessionId, request.expectedStateVersion, current.stateVersion);
    }
    return current;
  }

  private next(
    current: LocalSessionSnapshot,
    request: SessionMutationRequest,
    transform: (current: LocalSessionSnapshot) => LocalSessionSnapshot,
  ): LocalSessionSnapshot {
    const next = transform(copySessionSnapshot(current));
    return {
      ...next,
      scope: copyScope(next.scope),
      stateVersion: current.stateVersion + 1,
    };
  }

  private loadInternal(sessionId: string): LocalSessionSnapshot | undefined {
    return this.transient.get(sessionId) ?? this.durableStore.load(sessionId);
  }

  private saveInternal(snapshot: LocalSessionSnapshot): void {
    const copy = copySessionSnapshot(snapshot);
    if (copy.scope.persistence === 'durable') {
      this.durableStore.save(copy);
      return;
    }
    this.transient.set(copy.sessionId, copy);
  }
}
