import type { RegisterScheduleRequest, ScheduleManifestV1 } from '@awo/agent-runtime';
import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

function scheduleSummary(manifest: ScheduleManifestV1): ScheduleManifestV1 {
  return {
    ...manifest,
    taskTemplate: { ...manifest.taskTemplate, requestedCapabilities: [...manifest.taskTemplate.requestedCapabilities] },
    trigger: { ...manifest.trigger },
    budget: { ...manifest.budget },
  };
}

/**
 * Schedule metadata 与 approval inbox 的 HTTP 适配器。
 * 只创建/审查不可执行 run 记录，不注册 timer、runner 或任何自动执行能力。
 */
export const handleScheduleRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  const { schedules } = dependencies;
  if (request.method === 'GET' && url.pathname === '/api/schedules/approval-inbox') {
    sendJson(response, 200, schedules.approvalInbox());
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/schedules') {
    sendJson(response, 200, schedules.listSchedules().map(scheduleSummary));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/schedules') {
    const body = await readJsonBody(request) as Record<string, unknown>;
    if (
      typeof body.id !== 'string' || typeof body.displayName !== 'string' || !body.taskTemplate || !body.trigger || !body.budget
      || typeof body.requiresApproval !== 'boolean' || (body.note !== undefined && typeof body.note !== 'string')
    ) {
      sendJson(response, 400, { error: 'Schedule 候选必须提供 id、displayName、taskTemplate、trigger、budget 与 requiresApproval' });
      return true;
    }
    try {
      sendJson(response, 201, scheduleSummary(schedules.registerCandidate({
        ...(body as unknown as Omit<RegisterScheduleRequest, 'at'>), at: Date.now(),
      })));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Schedule 候选无效' });
    }
    return true;
  }

  if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] === 'runs' && segments.length === 4) {
    try {
      sendJson(response, 200, schedules.listRuns(segments[2]));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Schedule runs 查询无效' });
    }
    return true;
  }

  /** 显式窗口规划只形成不可执行 run 记录；不存在后台 timer 或 runner。 */
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] === 'runs' && segments.length === 4) {
    const body = await readJsonBody(request) as { runId?: unknown };
    if (typeof body.runId !== 'string') {
      sendJson(response, 400, { error: 'Schedule run 规划必须提供独立 runId' });
      return true;
    }
    try {
      sendJson(response, 201, schedules.planDueRun({ scheduleId: segments[2], runId: body.runId, at: Date.now() }));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Schedule run 规划无效' });
    }
    return true;
  }

  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] && segments.length === 4) {
    const operation = segments[3];
    if (operation !== 'review' && operation !== 'enable' && operation !== 'disable' && operation !== 'revoke') {
      sendJson(response, 404, { error: 'Schedule 操作必须是 review、enable、disable 或 revoke' });
      return true;
    }
    const body = await readJsonBody(request) as { reviewedBy?: unknown; note?: unknown };
    if (typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')) {
      sendJson(response, 400, { error: 'Schedule 状态变更必须提供 reviewedBy，note 只能为字符串' });
      return true;
    }
    try {
      const manifest = operation === 'review'
        ? schedules.review(segments[2], body.reviewedBy, Date.now(), body.note)
        : operation === 'enable'
          ? schedules.enable(segments[2], body.reviewedBy, Date.now(), body.note)
          : operation === 'disable'
            ? schedules.disable(segments[2], body.reviewedBy, Date.now(), body.note)
            : schedules.revoke(segments[2], body.reviewedBy, Date.now(), body.note);
      sendJson(response, 200, scheduleSummary(manifest));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Schedule 状态变更无效' });
    }
    return true;
  }

  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'scheduled-runs' && segments[2] && segments[3] && segments.length === 4) {
    const operation = segments[3];
    if (operation !== 'approve' && operation !== 'deny' && operation !== 'expire') {
      sendJson(response, 404, { error: 'Schedule run 操作必须是 approve、deny 或 expire' });
      return true;
    }
    const body = await readJsonBody(request) as { reviewedBy?: unknown; note?: unknown };
    if ((operation !== 'expire' && typeof body.reviewedBy !== 'string') || (body.note !== undefined && typeof body.note !== 'string')) {
      sendJson(response, 400, { error: operation === 'expire' ? 'Schedule run expire 的 note 只能为字符串' : 'Schedule run 决定必须提供 reviewedBy，note 只能为字符串' });
      return true;
    }
    try {
      const run = operation === 'approve'
        ? schedules.approveRun(segments[2], body.reviewedBy as string, Date.now(), body.note)
        : operation === 'deny'
          ? schedules.denyRun(segments[2], body.reviewedBy as string, Date.now(), body.note)
          : schedules.expireRun(segments[2], Date.now(), body.note);
      sendJson(response, 200, run);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Schedule run 操作无效' });
    }
    return true;
  }

  return false;
};
