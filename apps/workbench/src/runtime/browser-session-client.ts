export type WorkbenchBrowserSessionStatus = 'requested' | 'authorized' | 'paused' | 'ended' | 'failed';
export type WorkbenchBrowserSessionEventType = 'requested' | 'authorized' | 'paused' | 'resumed' | 'ended' | 'failed';

/**
 * 浏览器侧只接受 Gateway 的脱敏会话投影；不会携带完整 URL、页面内容、cookie、密码或任何执行权限。
 */
export interface WorkbenchBrowserSession {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  status: WorkbenchBrowserSessionStatus;
  adapterId: 'browser.local-preview';
  targetHost: string;
  scopeDigest: string;
  requestedBy: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  reason?: string;
  canExecute: false;
  canReadPageContent: false;
  canReadBrowserSecrets: false;
  canControlDesktop: false;
}

export interface WorkbenchBrowserSessionEvent {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  revision: number;
  type: WorkbenchBrowserSessionEventType;
  at: number;
  by: string;
  reason?: string;
  canExecute: false;
}

type BrowserSessionAction = 'authorize' | 'pause' | 'resume' | 'end';

const SESSION_FIELDS = new Set(['schemaVersion', 'sessionId', 'revision', 'status', 'adapterId', 'targetHost', 'scopeDigest', 'requestedBy', 'createdAt', 'updatedAt', 'updatedBy', 'reason', 'canExecute', 'canReadPageContent', 'canReadBrowserSecrets', 'canControlDesktop']);
const EVENT_FIELDS = new Set(['schemaVersion', 'eventId', 'sessionId', 'revision', 'type', 'at', 'by', 'reason', 'canExecute']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{1,253}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function isEpoch(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function safeError(response: Response, fallback: string): Promise<never> { return response.text().then((text) => Promise.reject(new Error(text || `${fallback} (${response.status})`))); }

function assertSession(value: unknown): asserts value is WorkbenchBrowserSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览会话摘要无效');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => !SESSION_FIELDS.has(key))
    || item.schemaVersion !== 1 || typeof item.sessionId !== 'string' || !IDENTIFIER.test(item.sessionId)
    || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || !['requested', 'authorized', 'paused', 'ended', 'failed'].includes(String(item.status))
    || item.adapterId !== 'browser.local-preview' || typeof item.targetHost !== 'string' || !HOST.test(item.targetHost)
    || typeof item.scopeDigest !== 'string' || !DIGEST.test(item.scopeDigest) || typeof item.requestedBy !== 'string' || !IDENTIFIER.test(item.requestedBy)
    || !isEpoch(item.createdAt) || !isEpoch(item.updatedAt) || typeof item.updatedBy !== 'string' || !IDENTIFIER.test(item.updatedBy)
    || (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500))
    || item.canExecute !== false || item.canReadPageContent !== false || item.canReadBrowserSecrets !== false || item.canControlDesktop !== false
  ) throw new Error('浏览会话摘要包含未声明、敏感或可执行字段');
}

function assertEvent(value: unknown): asserts value is WorkbenchBrowserSessionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览会话审计事件无效');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => !EVENT_FIELDS.has(key))
    || item.schemaVersion !== 1 || typeof item.eventId !== 'string' || !IDENTIFIER.test(item.eventId)
    || typeof item.sessionId !== 'string' || !IDENTIFIER.test(item.sessionId) || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1
    || !['requested', 'authorized', 'paused', 'resumed', 'ended', 'failed'].includes(String(item.type)) || !isEpoch(item.at)
    || typeof item.by !== 'string' || !IDENTIFIER.test(item.by) || (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500)) || item.canExecute !== false
  ) throw new Error('浏览会话审计事件包含未声明、敏感或可执行字段');
}

function assertOperator(by: string): string {
  const normalized = by.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error('操作者标识必须是安全标识符');
  return normalized;
}

function normalizedReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 500) throw new Error('原因不得超过 500 个字符');
  return normalized;
}

export class HttpBrowserSessionClient {
  /** Workbench 仅指向固定本机 Gateway；不会将控制面请求发往任意远程主机。 */
  constructor(private readonly baseUrl = 'http://127.0.0.1:4318/api/browser-sessions') {}

  async list(limit = 100): Promise<readonly WorkbenchBrowserSession[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('读取数量必须是 1-500 的整数');
    const response = await fetch(`${this.baseUrl}?limit=${limit}`, { headers: { accept: 'application/json' } });
    if (!response.ok) return safeError(response, '浏览会话读取失败');
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('浏览会话列表无效');
    payload.forEach(assertSession);
    return [...payload].sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
  }

  async events(sessionId: string, limit = 100): Promise<readonly WorkbenchBrowserSessionEvent[]> {
    if (!IDENTIFIER.test(sessionId) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('浏览会话标识或读取数量无效');
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(sessionId)}/events?limit=${limit}`, { headers: { accept: 'application/json' } });
    if (!response.ok) return safeError(response, '浏览会话审计读取失败');
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('浏览会话审计列表无效');
    payload.forEach(assertEvent);
    return [...payload].sort((left, right) => right.revision - left.revision || right.at - left.at);
  }

  async create(input: { by: string; targetUrl: string; reason?: string }): Promise<WorkbenchBrowserSession> {
    const by = assertOperator(input.by);
    const reason = normalizedReason(input.reason);
    let target: URL;
    try { target = new URL(input.targetUrl.trim()); } catch { throw new Error('目标必须是有效 HTTPS URL'); }
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(target.hostname) || target.hostname.includes(':')) throw new Error('目标仅允许公网 HTTPS 主机，且不允许凭据、本机、IP 或自定义端口');
    return this.mutate('', 'create', { by, targetUrl: target.toString(), ...(reason ? { reason } : {}) });
  }

  async transition(sessionId: string, action: BrowserSessionAction, input: { by: string; reason?: string }): Promise<WorkbenchBrowserSession> {
    if (!IDENTIFIER.test(sessionId)) throw new Error('浏览会话标识无效');
    const by = assertOperator(input.by);
    const reason = normalizedReason(input.reason);
    return this.mutate(`/${encodeURIComponent(sessionId)}/${action}`, action, { by, ...(reason ? { reason } : {}) });
  }

  private async mutate(path: string, action: BrowserSessionAction | 'create', body: Record<string, string>): Promise<WorkbenchBrowserSession> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-awo-operator-intent': `browser-session-${action}-v1` },
      body: JSON.stringify(body),
    });
    if (!response.ok) return safeError(response, '浏览会话操作未完成');
    const payload: unknown = await response.json();
    assertSession(payload);
    return payload;
  }
}
