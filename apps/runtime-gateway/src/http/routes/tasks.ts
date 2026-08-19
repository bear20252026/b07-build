import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { decodeTaskSubmitIntentV1 } from '@awo/protocol';
import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

function isReadOnlySubtaskRole(value: unknown): value is 'explore' | 'scout' {
  return value === 'explore' || value === 'scout';
}

function runKey(taskId: string, runId: string): string {
  return `${taskId}:${runId}`;
}

function commandFingerprint(command: string, fields: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify({ command, ...fields })).digest('hex');
}

function idempotencyKey(request: IncomingMessage): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

/** 任务 intent HTTP 适配器；所有执行仍经既有 Profile、Policy、审批与预算链路。 */
export const handleTaskRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  const { runtime, commandReceipts, requests, eventsByRun, approvedActions, readOnlySubtasks, runTrajectory, createTaskRequest, createEvent } = dependencies;
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJsonBody(request);
    let intent;
    try {
      intent = decodeTaskSubmitIntentV1(body);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '任务提交 contract 无效' });
      return true;
    }
    const key = idempotencyKey(request);
    if (!key) {
      sendJson(response, 400, { error: '任务提交必须提供 Idempotency-Key' });
      return true;
    }
    const goal = intent.goal;
    const fingerprint = commandFingerprint('submit', { goal, profileId: intent.profileId });
    const existing = commandReceipts.get('submit', key);
    const claimed = commandReceipts.claim(existing ?? {
      schemaVersion: 1,
      command: 'submit',
      idempotencyKey: key,
      fingerprint,
      taskId: `task-${randomUUID()}`,
      runId: `run-${randomUUID()}`,
      goal,
      profileId: intent.profileId,
      acceptedAt: Date.now(),
    });
    if (claimed.receipt.fingerprint !== fingerprint) {
      sendJson(response, 409, { error: 'Idempotency-Key 已绑定到不同任务意图' });
      return true;
    }
    if (claimed.kind === 'replayed' && claimed.receipt.snapshot) {
      sendJson(response, 200, claimed.receipt.snapshot);
      return true;
    }
    const runtimeRequest = createTaskRequest(claimed.receipt.goal, claimed.receipt.profileId, { taskId: claimed.receipt.taskId, runId: claimed.receipt.runId });
    requests.set(runKey(runtimeRequest.taskId, runtimeRequest.runId), runtimeRequest);
    const snapshot = await runtime.submit(runtimeRequest);
    commandReceipts.complete('submit', key, snapshot, Date.now());
    sendJson(response, claimed.kind === 'claimed' ? 201 : 200, snapshot);
    return true;
  }

  if (!(segments[0] === 'api' && segments[1] === 'tasks' && segments.length >= 4)) return false;
  const [, , taskId, runId, operation, nodeId] = segments;
  const key = runKey(taskId, runId);
  const runtimeRequest = requests.get(key);
  if (request.method === 'GET' && !operation) {
    const snapshot = runtime.snapshot(taskId, runId);
    if (!snapshot) sendJson(response, 404, { error: '任务快照不存在' });
    else {
      const knownAttempt = Number(url.searchParams.get('sinceAttempt'));
      if (Number.isInteger(knownAttempt) && knownAttempt === snapshot.attempt) sendJson(response, 204);
      else sendJson(response, 200, snapshot);
    }
    return true;
  }
  if (request.method === 'GET' && operation === 'events') {
    const events = eventsByRun.get(key);
    if (!events) sendJson(response, 404, { error: '当前本地网关没有此任务的事件流' });
    else sendJson(response, 200, events);
    return true;
  }
  if (request.method === 'GET' && operation === 'trajectory') {
    const events = runTrajectory.list(taskId, runId);
    if (events.length === 0) sendJson(response, 404, { error: '当前本地网关没有此任务的运行轨迹' });
    else sendJson(response, 200, events);
    return true;
  }
  if (request.method === 'POST' && operation === 'subtasks' && segments.length === 5) {
    const parentSnapshot = runtime.snapshot(taskId, runId);
    if (!parentSnapshot) {
      sendJson(response, 404, { error: '父任务快照不存在，不能创建子任务' });
      return true;
    }
    const body = await readJsonBody(request) as { subtaskId?: unknown; role?: unknown; goal?: unknown; budget?: { maxInputTokens?: unknown; maxOutputTokens?: unknown; maxToolCalls?: unknown } };
    if (
      typeof body.subtaskId !== 'string' || !isReadOnlySubtaskRole(body.role) || typeof body.goal !== 'string'
      || !body.budget || typeof body.budget.maxInputTokens !== 'number' || typeof body.budget.maxOutputTokens !== 'number' || typeof body.budget.maxToolCalls !== 'number'
    ) {
      sendJson(response, 400, { error: '子任务必须具有 subtaskId、explore/scout role、goal 与完整预算' });
      return true;
    }
    readOnlySubtasks.spawn({
      subtaskId: body.subtaskId, parentTaskId: taskId, parentRunId: runId, role: body.role, goal: body.goal,
      budget: { maxInputTokens: body.budget.maxInputTokens, maxOutputTokens: body.budget.maxOutputTokens, maxToolCalls: body.budget.maxToolCalls }, at: Date.now(),
    });
    const snapshot = await readOnlySubtasks.run(body.subtaskId, {
      async run(context) {
        return {
          summary: `${context.role} 只读子任务已完成父任务状态检查；未执行写入、网络、Shell 或浏览器操作。`, estimatedOutputTokens: 24,
          citations: [{ kind: 'task_output', sourceId: taskId, sourceUri: `local://task/${taskId}/${runId}`, excerpt: `父任务当前状态：${parentSnapshot.status}。` }],
        };
      },
    }, Date.now());
    sendJson(response, 201, snapshot);
    return true;
  }
  if (request.method === 'GET' && operation === 'subtasks' && nodeId && segments.length === 6) {
    const snapshot = readOnlySubtasks.snapshot(nodeId);
    if (!snapshot || snapshot.parentTaskId !== taskId || snapshot.parentRunId !== runId) sendJson(response, 404, { error: '只读子任务不存在或不属于指定父任务' });
    else sendJson(response, 200, snapshot);
    return true;
  }
  if (request.method === 'GET' && operation === 'subtasks' && nodeId && segments[6] === 'summary' && segments.length === 7) {
    const snapshot = readOnlySubtasks.snapshot(nodeId);
    if (!snapshot || snapshot.parentTaskId !== taskId || snapshot.parentRunId !== runId) {
      sendJson(response, 404, { error: '只读子任务不存在或不属于指定父任务' });
      return true;
    }
    sendJson(response, 200, readOnlySubtasks.summaryReference(nodeId));
    return true;
  }
  if (!runtimeRequest) {
    sendJson(response, 404, { error: '当前本地网关没有此任务的可恢复请求；请在同一网关会话中提交任务' });
    return true;
  }
  if (request.method === 'POST' && operation === 'resume') {
    const commandKey = idempotencyKey(request);
    if (!commandKey) {
      sendJson(response, 400, { error: '任务恢复必须提供 Idempotency-Key' });
      return true;
    }
    const fingerprint = commandFingerprint('resume', { taskId, runId });
    const claimed = commandReceipts.claim({ schemaVersion: 1, command: 'resume', idempotencyKey: commandKey, fingerprint, taskId, runId, goal: runtimeRequest.goal, profileId: runtimeRequest.profileId, acceptedAt: Date.now() });
    if (claimed.kind === 'replayed' && claimed.receipt.snapshot) {
      sendJson(response, 200, claimed.receipt.snapshot);
      return true;
    }
    const snapshot = await runtime.resume(runtimeRequest);
    commandReceipts.complete('resume', commandKey, snapshot, Date.now());
    sendJson(response, 200, snapshot);
    return true;
  }
  if (request.method === 'POST' && operation === 'approvals' && nodeId) {
    if (!runtimeRequest.nodes.some((node) => node.id === nodeId)) {
      sendJson(response, 404, { error: '审批节点不存在' });
      return true;
    }
    const commandKey = idempotencyKey(request);
    if (!commandKey) {
      sendJson(response, 400, { error: '任务审批必须提供 Idempotency-Key' });
      return true;
    }
    const fingerprint = commandFingerprint('approve', { taskId, runId, nodeId });
    const claimed = commandReceipts.claim({ schemaVersion: 1, command: 'approve', idempotencyKey: commandKey, fingerprint, taskId, runId, nodeId, goal: runtimeRequest.goal, profileId: runtimeRequest.profileId, acceptedAt: Date.now() });
    if (claimed.kind === 'replayed' && claimed.receipt.snapshot) {
      sendJson(response, 200, claimed.receipt.snapshot);
      return true;
    }
    approvedActions.add(`${runId}:${nodeId}`);
    const approvalEvent = createEvent('approval.resolved', taskId, runId, { actionId: `${runId}:${nodeId}`, decision: 'approved', resolvedBy: 'local-user' });
    eventsByRun.get(key)?.push(approvalEvent);
    runTrajectory.recordTaskEvent(approvalEvent, 'approval');
    const snapshot = await runtime.resume(runtimeRequest);
    commandReceipts.complete('approve', commandKey, snapshot, Date.now());
    sendJson(response, 200, snapshot);
    return true;
  }

  sendJson(response, 404, { error: '未找到任务运行时路由' });
  return true;
};
