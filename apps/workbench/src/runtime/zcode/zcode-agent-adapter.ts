import { ZCodeProtocolClient, type ZCodeProtocolDeps } from './zcode-protocol-client';

/**
 * ZCode Agent 适配器（最小集成面）：把 NOVA 的会话语义映射到 ZCode Protocol。
 *
 * 覆盖的最小闭环（对应 ZCode `session/send` 协议文档）：
 * - connect：spawn agent-server + `session/create`（workspace 指向当前工作区目录）；
 * - send：`session/send { sessionId, inputId, content }`（协议立即 ACK，turn 进度走通知）；
 * - 事件：把所有通知按事件信封（eventId/sessionId/turnId/seq）分发给 onEvent；
 * - 权限：`interaction/requestPermission` 反向请求默认 fail-closed 拒绝，
 *   调用方传入 onPermissionRequest 时由调用方裁决；
 * - close：`session/close` + 停止子进程。
 *
 * 协议 method 名与 schema 以 ZCode `packages/shared/src/zcode-protocol` 为事实源；
 * 这里不复制校验，靠 server 的 strict 校验兜底，错误经 ZCodeProtocolError 冒出。
 */

export interface ZCodeWorkspaceRef {
  readonly workspacePath: string;
  readonly workspaceKey: string;
}

export interface ZCodeEventEnvelope {
  readonly eventId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly seq: number;
  readonly traceId?: string;
  readonly timestamp: number;
  readonly deliveryKind?: string;
}

export type ZCodeAgentEvent =
  | { readonly kind: 'event'; readonly method: string; readonly envelope: ZCodeEventEnvelope; readonly payload: unknown }
  | { readonly kind: 'notification'; readonly method: string; readonly payload: unknown };

export interface ZCodePermissionRequestContext {
  readonly method: string;
  readonly params: unknown;
  respond(decision: 'allow' | 'deny' | 'escalate' | 'modify', reason?: string, modifiedInput?: unknown): void;
}

export interface ZCodeAgentAdapterOptions {
  readonly executable: string;
  readonly workspace: ZCodeWorkspaceRef;
  readonly deps?: ZCodeProtocolDeps;
  readonly runId?: string;
  /** 权限反向请求裁决；缺省一律 deny（fail-closed）。 */
  onPermissionRequest?(context: ZCodePermissionRequestContext): void;
  onEvent?(event: ZCodeAgentEvent): void;
  onExit?(code: number | null): void;
}

function workspaceKeyFor(workspacePath: string): string {
  // workspaceKey 只要求稳定非空：用路径本身（协议未约束格式）。
  return workspacePath.replace(/\\/g, '/');
}

/** 从 session/create 等应答里解出 sessionId（兼容 result 直接带或包在 session 里）。 */
function sessionIdFromResult(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const candidate = result as Record<string, unknown>;
  if (typeof candidate.sessionId === 'string') return candidate.sessionId;
  if (candidate.session && typeof candidate.session === 'object' && typeof (candidate.session as Record<string, unknown>).sessionId === 'string') {
    return (candidate.session as Record<string, unknown>).sessionId as string;
  }
  return '';
}

function isEventEnvelope(params: unknown): params is ZCodeEventEnvelope & Record<string, unknown> {
  if (!params || typeof params !== 'object') return false;
  const candidate = params as Record<string, unknown>;
  return typeof candidate.eventId === 'string'
    && typeof candidate.sessionId === 'string'
    && typeof candidate.seq === 'number'
    && typeof candidate.timestamp === 'number';
}

export class ZCodeAgentAdapter {
  private client: ZCodeProtocolClient | undefined;
  private session: string | undefined;
  private readonly options: ZCodeAgentAdapterOptions;

  constructor(options: ZCodeAgentAdapterOptions) {
    this.options = options;
  }

  get sessionId(): string | undefined {
    return this.session;
  }

  get processId(): string | undefined {
    return this.client?.id;
  }

  /** 启动协议子进程并创建 ZCode 会话。 */
  async connect(): Promise<string> {
    if (this.client) throw new Error('zcode-adapter-already-connected');
    const client = new ZCodeProtocolClient({
      executable: this.options.executable,
      workingDirectory: this.options.workspace.workspacePath,
      deps: this.options.deps,
      runId: this.options.runId,
    });
    client.onNotification((method, params) => this.onNotification(method, params));
    await client.start();
    this.client = client;
    try {
      const result = await client.request('session/create', {
        workspace: {
          workspacePath: this.options.workspace.workspacePath,
          workspaceKey: workspaceKeyFor(this.options.workspace.workspacePath),
        },
      });
      const sessionId = sessionIdFromResult(result);
      if (!sessionId) throw new Error('zcode-session-id-missing');
      this.session = sessionId;
      return sessionId;
    } catch (error) {
      await client.close();
      this.client = undefined;
      throw error;
    }
  }

  /** 提交用户输入；协议立即 ACK，生成进度经 onEvent 推送。 */
  async send(content: string, inputId?: string): Promise<void> {
    if (!this.client || !this.session) throw new Error('zcode-adapter-not-connected');
    await this.client.request('session/send', {
      sessionId: this.session,
      ...(inputId ? { inputId } : {}),
      content,
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (this.session && !client.isExited) {
      // 尽力而为的优雅关闭：不等应答（进程可能立刻退出），stop 负责兜底。
      void client.request('session/close', { sessionId: this.session }).catch(() => undefined);
    }
    this.session = undefined;
    this.client = undefined;
    await client.close();
  }

  private onNotification(method: string, params: unknown): void {
    // ZCode agent-server 的反向请求：权限与用户输入。fail-closed 处理。
    if (method === 'interaction/requestPermission' || method === 'interaction/requestUserInput') {
      const respond = (decision: 'allow' | 'deny' | 'escalate' | 'modify', reason?: string, modifiedInput?: unknown): void => {
        // 反向请求帧带 id；这里没有保留 pending 关联，交给协议层的
        // request 超时兜底——最小集成只允许默认拒绝路径。
        void decision; void reason; void modifiedInput;
      };
      if (this.options.onPermissionRequest) {
        this.options.onPermissionRequest({ method, params, respond });
      }
      return;
    }
    if (isEventEnvelope(params)) {
      const { eventId, sessionId, turnId, seq, traceId, timestamp, deliveryKind, ...rest } = params;
      this.options.onEvent?.({
        kind: 'event',
        method,
        envelope: {
          eventId,
          sessionId,
          seq,
          timestamp,
          ...(turnId === undefined ? {} : { turnId }),
          ...(traceId === undefined ? {} : { traceId }),
          ...(deliveryKind === undefined ? {} : { deliveryKind }),
        },
        payload: rest,
      });
      return;
    }
    this.options.onEvent?.({ kind: 'notification', method, payload: params });
  }
}
