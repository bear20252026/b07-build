import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { decodeTaskSubmitIntentV1 } from '@awo/protocol';
import { readJsonBody, sendAttachment, sendJson } from '../boundary.js';
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
  const { runtime, commandReceipts, requests, eventsByRun, approvedActions, readOnlySubtasks, runTrajectory, runWorkspace, taskFiles, createTaskRequest, createEvent } = dependencies;
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJsonBody(request, 3 * 1024 * 1024);
    let intent;
    try {
      intent = decodeTaskSubmitIntentV1(body);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '任务提交 contract 无效' });
      return true;
    }
    if (intent.inputProvenance.some((input) => input.sourceKind === 'upload')) {
      sendJson(response, 400, { error: '浏览器不得自行声明 upload provenance；Gateway 必须从实际上传字节计算摘要' });
      return true;
    }
    let uploads: readonly { id: string; name: string; content: Buffer; contentDigest: string; provenance: import('@awo/protocol').InputProvenanceV1 }[];
    try {
      uploads = (intent.uploads ?? []).map((upload) => {
        const content = Buffer.from(upload.contentBase64, 'base64');
        if (content.length === 0 || content.length > 256 * 1024 || content.toString('base64') !== upload.contentBase64) throw new Error('上传内容无效、为空或超过 256KiB 上限');
        const contentDigest = createHash('sha256').update(content).digest('hex');
        return { id: upload.id, name: upload.name, content, contentDigest, provenance: { schemaVersion: 1 as const, inputId: `upload-${createHash('sha256').update(upload.id).digest('hex').slice(0, 40)}`, trust: 'external-untrusted' as const, sourceKind: 'upload' as const, contentDigest } };
      });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '上传内容无效' });
      return true;
    }
    try {
      uploads.forEach((upload) => taskFiles.validateUploadedFile(`uploads/${upload.name}`, upload.content));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '上传文件不符合本机任务输入区策略' });
      return true;
    }
    const allInputProvenance = [...intent.inputProvenance, ...uploads.map((upload) => upload.provenance)];
    const key = idempotencyKey(request);
    if (!key) {
      sendJson(response, 400, { error: '任务提交必须提供 Idempotency-Key' });
      return true;
    }
    const goal = intent.goal;
    const administratorLeaseDigest = intent.administratorLease
      ? createHash('sha256').update(JSON.stringify({
        operatorId: intent.administratorLease.operatorId,
        allowedCapabilities: [...intent.administratorLease.allowedCapabilities].sort(),
        reason: intent.administratorLease.reason,
      })).digest('hex')
      : 'none';
    const inputProvenanceDigest = createHash('sha256').update(JSON.stringify(allInputProvenance)).digest('hex');
    const uploadDigest = createHash('sha256').update(JSON.stringify(uploads.map((upload) => ({ id: upload.id, name: upload.name, contentDigest: upload.contentDigest })))).digest('hex');
    const modelSelectionDigest = createHash('sha256').update(JSON.stringify(intent.modelSelection ?? null)).digest('hex');
    const fingerprint = commandFingerprint('submit', { goal, profileId: intent.profileId, authorityMode: intent.authorityMode, administratorLeaseDigest, inputProvenanceDigest, uploadDigest, modelSelectionDigest });
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
      authorityMode: intent.authorityMode,
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
    if (intent.authorityMode === 'admin') {
      // Browser/loopback HTTP 没有可验证的本地操作者身份时，绝不把 body 当作管理员凭据。
      // 领域层已具备租约验证；只有未来经过可信桌面宿主认证的 issuer 才能签发租约。
      sendJson(response, 403, { error: '当前 Gateway 未配置可信本地管理员租约签发器；Admin Authority 默认关闭' });
      return true;
    }
    const runtimeRequest = createTaskRequest(
      claimed.receipt.goal,
      claimed.receipt.profileId,
      claimed.receipt.authorityMode ?? 'review',
      { taskId: claimed.receipt.taskId, runId: claimed.receipt.runId },
      allInputProvenance,
      intent.modelSelection,
    );
    requests.set(runKey(runtimeRequest.taskId, runtimeRequest.runId), runtimeRequest);
    const taskEvents = eventsByRun.get(runKey(runtimeRequest.taskId, runtimeRequest.runId));
    if (!taskEvents) throw new Error('任务事件账本未初始化；拒绝写入上传文件');
    for (const upload of uploads) {
      const artifactId = `upload-${createHash('sha256').update(`${runtimeRequest.taskId}:${runtimeRequest.runId}:${upload.id}:${upload.contentDigest}`).digest('hex').slice(0, 48)}`;
      const uploadEvent = createEvent('artifact.created', runtimeRequest.taskId, runtimeRequest.runId, { artifactId, mime: 'application/octet-stream', path: `uploads/${upload.name}` });
      taskEvents.push(uploadEvent);
      runTrajectory.recordTaskEvent(uploadEvent, 'gateway.intent');
      const artifact = runWorkspace.recordTaskEvent(uploadEvent);
      if (!artifact) throw new Error('上传工件账本拒绝记录；未写入任务文件');
      taskFiles.publishUploadedFile({ taskId: runtimeRequest.taskId, runId: runtimeRequest.runId, artifactLedgerId: artifact.artifactLedgerId, logicalPath: `uploads/${upload.name}`, content: upload.content, createdAt: uploadEvent.at });
    }
    const snapshot = await runtime.submit(runtimeRequest);
    runWorkspace.recordCheckpoint(snapshot, true);
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
  if (request.method === 'GET' && operation === 'workspace') {
    const snapshot = runtime.snapshot(taskId, runId);
    if (!snapshot) sendJson(response, 404, { error: '任务快照不存在' });
    else sendJson(response, 200, runWorkspace.listArtifacts(taskId, runId));
    return true;
  }
  if (request.method === 'GET' && operation === 'checkpoints') {
    const snapshot = runtime.snapshot(taskId, runId);
    if (!snapshot) sendJson(response, 404, { error: '任务快照不存在' });
    else sendJson(response, 200, runWorkspace.listCheckpoints(taskId, runId));
    return true;
  }
  if (operation === 'files') {
    const snapshot = runtime.snapshot(taskId, runId);
    if (!snapshot) {
      sendJson(response, 404, { error: '任务快照不存在' });
      return true;
    }
    if (request.method === 'GET' && !nodeId && segments.length === 5) {
      sendJson(response, 200, taskFiles.listFiles(taskId, runId));
      return true;
    }
    if (request.method === 'GET' && nodeId && segments[6] === 'preview' && segments.length === 7) {
      try {
        sendJson(response, 200, taskFiles.preview(taskId, runId, nodeId));
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : '任务文件预览不可用' });
      }
      return true;
    }
    if (request.method === 'GET' && nodeId && segments[6] === 'diff' && segments.length === 7) {
      try {
        sendJson(response, 200, taskFiles.diff(taskId, runId, nodeId));
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : '任务文件差异不可用' });
      }
      return true;
    }
  }
  if (operation === 'deliveries') {
    const snapshot = runtime.snapshot(taskId, runId);
    if (!snapshot) {
      sendJson(response, 404, { error: '任务快照不存在' });
      return true;
    }
    if (request.method === 'GET' && !nodeId && segments.length === 5) {
      sendJson(response, 200, taskFiles.listDeliveries(taskId, runId));
      return true;
    }
    if (request.method === 'POST' && !nodeId && segments.length === 5) {
      const commandKey = idempotencyKey(request);
      if (!commandKey) {
        sendJson(response, 400, { error: '创建交付包必须提供 Idempotency-Key' });
        return true;
      }
      try {
        sendJson(response, 201, taskFiles.createDelivery(taskId, runId, Date.now(), commandKey));
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : '任务交付包创建失败' });
      }
      return true;
    }
    if (request.method === 'GET' && nodeId && segments.length === 6) {
      try {
        const delivery = taskFiles.readDelivery(taskId, runId, nodeId);
        sendAttachment(response, delivery.content, `ai-work-os-${taskId}-${runId}-${nodeId}.zip`);
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : '任务交付包不可用' });
      }
      return true;
    }
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
    const claimed = commandReceipts.claim({ schemaVersion: 1, command: 'resume', idempotencyKey: commandKey, fingerprint, taskId, runId, goal: runtimeRequest.goal, profileId: runtimeRequest.profileId, authorityMode: runtimeRequest.authorityMode ?? 'review', acceptedAt: Date.now() });
    if (claimed.kind === 'replayed' && claimed.receipt.snapshot) {
      sendJson(response, 200, claimed.receipt.snapshot);
      return true;
    }
    const snapshot = await runtime.resume(runtimeRequest);
    runWorkspace.recordCheckpoint(snapshot, true);
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
    const claimed = commandReceipts.claim({ schemaVersion: 1, command: 'approve', idempotencyKey: commandKey, fingerprint, taskId, runId, nodeId, goal: runtimeRequest.goal, profileId: runtimeRequest.profileId, authorityMode: runtimeRequest.authorityMode ?? 'review', acceptedAt: Date.now() });
    if (claimed.kind === 'replayed' && claimed.receipt.snapshot) {
      sendJson(response, 200, claimed.receipt.snapshot);
      return true;
    }
    approvedActions.add(`${runId}:${nodeId}`);
    const approvalEvent = createEvent('approval.resolved', taskId, runId, { actionId: `${runId}:${nodeId}`, decision: 'approved', resolvedBy: 'local-user' });
    eventsByRun.get(key)?.push(approvalEvent);
    runTrajectory.recordTaskEvent(approvalEvent, 'approval');
    const snapshot = await runtime.resume(runtimeRequest);
    runWorkspace.recordCheckpoint(snapshot, true);
    commandReceipts.complete('approve', commandKey, snapshot, Date.now());
    sendJson(response, 200, snapshot);
    return true;
  }

  sendJson(response, 404, { error: '未找到任务运行时路由' });
  return true;
};
