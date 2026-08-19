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
  constructor(private readonly baseUrl = '/api/tasks') {}

  async submit(intent: WorkbenchTaskIntent): Promise<WorkbenchTaskSnapshot> {
    return this.request('', {
      method: 'POST',
      body: JSON.stringify(intent),
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
