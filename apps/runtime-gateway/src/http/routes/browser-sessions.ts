import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

const intents = {
  create: 'browser-session-create-v1',
  authorize: 'browser-session-authorize-v1',
  pause: 'browser-session-pause-v1',
  resume: 'browser-session-resume-v1',
  end: 'browser-session-end-v1',
} as const;

type Action = keyof typeof intents;

function hasIntent(request: { headers: Record<string, string | string[] | undefined> }, action: Action): boolean {
  return request.headers['x-awo-operator-intent'] === intents[action];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function actorAndReason(value: unknown): { by: string; reason?: string } | undefined {
  const body = record(value);
  if (!body || Object.keys(body).some((key) => key !== 'by' && key !== 'reason') || typeof body.by !== 'string' || (body.reason !== undefined && typeof body.reason !== 'string')) return undefined;
  return { by: body.by, reason: body.reason };
}

function limit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : undefined;
}

/** 浏览会话路由只流转用户授权/暂停/结束信号和脱敏审计；不创建浏览器或执行任何页面/桌面动作。 */
export const handleBrowserSessionRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  if (request.method === 'GET' && url.pathname === '/api/browser-sessions') {
    const value = limit(url.searchParams.get('limit'));
    if (url.searchParams.get('limit') !== null && value === undefined) { sendJson(response, 400, { error: 'limit 必须是 1-500 的整数' }); return true; }
    sendJson(response, 200, dependencies.browserSessions.list(value));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/browser-sessions') {
    if (!hasIntent(request, 'create')) { sendJson(response, 403, { error: '创建浏览会话必须由本地操作者显式发起' }); return true; }
    const body = record(await readJsonBody(request));
    if (!body || Object.keys(body).some((key) => key !== 'by' && key !== 'targetUrl' && key !== 'reason') || typeof body.by !== 'string' || typeof body.targetUrl !== 'string' || (body.reason !== undefined && typeof body.reason !== 'string')) {
      sendJson(response, 400, { error: '浏览会话只接受 by、targetUrl 和可选 reason；不得提交页面内容、cookie、secret、能力或执行字段' }); return true;
    }
    try { sendJson(response, 201, dependencies.browserSessions.create({ requestedBy: body.by, targetUrl: body.targetUrl, at: Date.now(), reason: body.reason })); }
    catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : '浏览会话请求无效' }); }
    return true;
  }
  if (segments[0] !== 'api' || segments[1] !== 'browser-sessions' || !segments[2]) return false;
  const sessionId = decodeURIComponent(segments[2]);
  if (request.method === 'GET' && segments[3] === 'events' && segments.length === 4) {
    const value = limit(url.searchParams.get('limit'));
    if (url.searchParams.get('limit') !== null && value === undefined) { sendJson(response, 400, { error: 'limit 必须是 1-500 的整数' }); return true; }
    try { sendJson(response, 200, dependencies.browserSessions.events(sessionId, value)); }
    catch (error) { sendJson(response, 404, { error: error instanceof Error ? error.message : '浏览会话不存在' }); }
    return true;
  }
  const action = segments[3] as Action | undefined;
  if (request.method !== 'POST' || !action || segments.length !== 4 || !(action in intents)) return false;
  if (!hasIntent(request, action)) { sendJson(response, 403, { error: '浏览会话状态变更必须由本地操作者显式发起' }); return true; }
  const body = actorAndReason(await readJsonBody(request));
  if (!body) { sendJson(response, 400, { error: '状态变更只接受 by 和可选 reason；不接受动作、范围、页面内容或执行字段' }); return true; }
  try {
    const at = Date.now();
    const snapshot = action === 'authorize' ? dependencies.browserSessions.authorize(sessionId, body.by, at, body.reason)
      : action === 'pause' ? dependencies.browserSessions.pause(sessionId, body.by, at, body.reason)
      : action === 'resume' ? dependencies.browserSessions.resume(sessionId, body.by, at, body.reason)
      : dependencies.browserSessions.end(sessionId, body.by, at, body.reason);
    sendJson(response, 200, snapshot);
  } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : '浏览会话状态无效' }); }
  return true;
};
