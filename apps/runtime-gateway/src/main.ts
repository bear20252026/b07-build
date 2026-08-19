import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentProfileId, CapabilityPolicyRule, TaskEvent } from '@awo/protocol';
import {
  InMemoryApprovalPort,
  LocalTaskRuntimeService,
  RuleBasedCapabilityPolicy,
  SqliteTaskSnapshotStore,
  type DAGNode,
  type TaskRuntimeRequest,
} from '@awo/agent-runtime';

const PORT = Number(process.env.AWO_RUNTIME_PORT ?? 4318);
const SNAPSHOT_PATH = resolve(process.env.AWO_SNAPSHOT_DB ?? '.awo/task-snapshots.sqlite');
const store = new SqliteTaskSnapshotStore(SNAPSHOT_PATH);
const runtime = new LocalTaskRuntimeService(store);
const requests = new Map<string, TaskRuntimeRequest>();
const eventsByRun = new Map<string, TaskEvent[]>();
const approvedActions = new Set<string>();

const BASELINE_RULES: readonly CapabilityPolicyRule[] = [
  { capability: 'document.parse', decision: 'allow', reason: '本地任务模板允许文档解析' },
  { capability: 'model.chat', decision: 'allow', reason: '本地任务模板允许受控模型推理' },
  { capability: 'filesystem.read', decision: 'allow', reason: '本地任务模板允许只读检查' },
  { capability: 'filesystem.write', decision: 'require_approval', reason: '写入意图必须经本地审批' },
  { capability: 'network.fetch', decision: 'require_approval', reason: '网络访问必须经本地审批' },
  { capability: 'shell.execute', decision: 'require_approval', reason: 'Shell 执行必须经本地审批' },
  { capability: 'browser.control', decision: 'require_approval', reason: '浏览器控制必须经本地审批' },
];

function runKey(taskId: string, runId: string): string {
  return `${taskId}:${runId}`;
}

function isProfileId(value: unknown): value is AgentProfileId {
  return value === 'build' || value === 'plan' || value === 'explore';
}

function event(type: TaskEvent['type'], taskId: string, runId: string, payload: Record<string, unknown>): TaskEvent {
  return {
    protocolVersion: '1.0',
    eventId: `gateway:${runId}:${type}:${randomUUID()}`,
    taskId,
    runId,
    at: Date.now(),
    type,
    ...payload,
  } as TaskEvent;
}

function taskNodes(profileId: AgentProfileId): readonly DAGNode[] {
  const readOnly = [
    {
      id: 'understand',
      kind: 'model' as const,
      tool: { name: 'local.task.understand', args: {}, capability: 'model.chat' as const, risk: 'low' as const },
      idempotencyKey: 'understand:v1',
      deps: [],
    },
    {
      id: 'inspect',
      kind: 'tool' as const,
      tool: { name: 'workspace.inspect', args: {}, capability: 'filesystem.read' as const, risk: 'low' as const },
      idempotencyKey: 'inspect:v1',
      deps: ['understand'],
    },
  ];
  if (profileId !== 'build') return readOnly;
  return [
    ...readOnly,
    {
      id: 'deliver',
      kind: 'tool',
      tool: { name: 'workspace.write.intent', args: {}, capability: 'filesystem.write', risk: 'medium' },
      idempotencyKey: 'deliver:v1',
      deps: ['inspect'],
    },
  ];
}

function createRequest(goal: string, profileId: AgentProfileId): TaskRuntimeRequest {
  const taskId = `task-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const events: TaskEvent[] = [
    event('task.created', taskId, runId, { goal }),
    event('agent.profile.selected', taskId, runId, { profileId }),
    event('plan.proposed', taskId, runId, {
      steps: taskNodes(profileId).map((node) => ({ id: node.id, description: node.tool.name, risk: node.tool.risk })),
    }),
  ];
  const request: TaskRuntimeRequest = {
    taskId,
    runId,
    goal,
    profileId,
    nodes: taskNodes(profileId),
    baselinePolicy: new RuleBasedCapabilityPolicy(BASELINE_RULES),
    approvals: new InMemoryApprovalPort(approvedActions),
    runner: {
      async run(node) {
        // 网关模板只证明端到端控制路径；不会修改文件、调用网络或执行 Shell。
        return { ok: true, outputRef: `local://task/${taskId}/${node.id}` };
      },
    },
    emit(nextEvent) {
      events.push(nextEvent);
    },
  };
  eventsByRun.set(runKey(taskId, runId), events);
  return request;
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function jsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 64 * 1024) {
        reject(new Error('request body exceeds 64KiB'));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.once('error', reject);
    request.once('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await jsonBody(request) as { goal?: unknown; profileId?: unknown };
      if (typeof body.goal !== 'string' || !body.goal.trim() || !isProfileId(body.profileId)) {
        send(response, 400, { error: 'goal 和 profileId 必须有效' });
        return;
      }
      const runtimeRequest = createRequest(body.goal.trim(), body.profileId);
      requests.set(runKey(runtimeRequest.taskId, runtimeRequest.runId), runtimeRequest);
      send(response, 201, await runtime.submit(runtimeRequest));
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'tasks' && segments.length >= 4) {
      const [, , taskId, runId, operation, nodeId] = segments;
      const key = runKey(taskId, runId);
      const runtimeRequest = requests.get(key);
      if (request.method === 'GET' && !operation) {
        const snapshot = runtime.snapshot(taskId, runId);
        if (!snapshot) send(response, 404, { error: '任务快照不存在' });
        else send(response, 200, snapshot);
        return;
      }
      if (request.method === 'GET' && operation === 'events') {
        const events = eventsByRun.get(key);
        if (!events) send(response, 404, { error: '当前本地网关没有此任务的事件流' });
        else send(response, 200, events);
        return;
      }
      if (!runtimeRequest) {
        send(response, 404, { error: '当前本地网关没有此任务的可恢复请求；请在同一网关会话中提交任务' });
        return;
      }
      if (request.method === 'POST' && operation === 'resume') {
        send(response, 200, await runtime.resume(runtimeRequest));
        return;
      }
      if (request.method === 'POST' && operation === 'approvals' && nodeId) {
        if (!runtimeRequest.nodes.some((node) => node.id === nodeId)) {
          send(response, 404, { error: '审批节点不存在' });
          return;
        }
        approvedActions.add(`${runId}:${nodeId}`);
        eventsByRun.get(key)?.push(event('approval.resolved', taskId, runId, {
          actionId: `${runId}:${nodeId}`,
          decision: 'approved',
          resolvedBy: 'local-user',
        }));
        send(response, 200, await runtime.resume(runtimeRequest));
        return;
      }
    }
    send(response, 404, { error: '未找到任务运行时路由' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown local runtime error';
    send(response, message.includes('64KiB') || message.includes('JSON') ? 400 : 500, { error: message });
  }
}

const server = createServer((request, response) => { void handle(request, response); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Work OS runtime gateway listening on http://127.0.0.1:${PORT}`);
});

function shutdown(): void {
  server.close(() => store.close());
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
