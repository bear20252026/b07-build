import { isTaskEvent, type AgentProfileId, type TaskEvent } from '@awo/protocol';

export type WorkbenchTaskStatus = 'created' | 'running' | 'blocked' | 'completed' | 'failed';
export type WorkbenchNodeOutcome = 'ok' | 'failed' | 'blocked';

export interface WorkbenchTaskSnapshot {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  profileId: AgentProfileId;
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

export interface WorkbenchTaskIntent {
  goal: string;
  profileId: AgentProfileId;
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

function assertTrajectoryEvent(value: unknown): asserts value is WorkbenchRunTrajectoryEvent {
  if (!value || typeof value !== 'object') throw new Error('运行轨迹包含无效事件');
  const event = value as Partial<WorkbenchRunTrajectoryEvent>;
  if (event.schemaVersion !== 1 || typeof event.trajectoryEventId !== 'string' || typeof event.taskId !== 'string' || typeof event.runId !== 'string' || typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.at !== 'number' || !Number.isSafeInteger(event.at) || !['task-runtime', 'gateway.intent', 'approval'].includes(String(event.source)) || typeof event.kind !== 'string' || !event.attributes || typeof event.attributes !== 'object' || event.canReplaySideEffects !== false) {
    throw new Error('运行轨迹返回了不兼容的 metadata contract');
  }
}

function assertSnapshot(value: unknown): asserts value is WorkbenchTaskSnapshot {
  if (!value || typeof value !== 'object') throw new Error('任务服务返回了无效快照');
  const snapshot = value as Partial<WorkbenchTaskSnapshot>;
  if (snapshot.schemaVersion !== 1 || typeof snapshot.taskId !== 'string' || typeof snapshot.runId !== 'string') {
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
  ) {}

  async submit(intent: WorkbenchTaskIntent): Promise<WorkbenchTaskSnapshot> {
    return this.request('', {
      method: 'POST',
      body: JSON.stringify({ schemaVersion: 1, ...intent }),
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
