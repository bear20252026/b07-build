import { ZCodeProtocolClient, type ZCodeProtocolDeps, type ZCodeServerRequestId } from './zcode-protocol-client';

/**
 * ZCode Agent 适配器：把 NOVA 的会话语义映射到 ZCode Protocol。
 *
 * 覆盖的闭环（对应 ZCode `session/send` / `session/subscribe` 协议文档）：
 * - connect：spawn agent-server + `session/create` + `session/subscribe`（事件流水位）；
 * - send：`session/send { sessionId, inputId, content }`（协议立即 ACK，turn 进度走通知）；
 * - 事件：按事件信封（eventId/sessionId/turnId/seq）分发；跟踪 seq 水位，
 *   发现缺口时以 `afterSeq` 重发 `session/subscribe` 补齐（重同步）；
 * - 反向请求：`interaction/requestPermission` / `interaction/requestUserInput`
 *   经 respond 以完整协议应答帧（`{id, result: {decision, ...}}`）回发；
 *   无裁决回调时缺省 deny（fail-closed）；其余反向请求一律 -32601 拒绝；
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
  /** 权限反向请求裁决；缺省以完整协议应答执行 deny（fail-closed）。 */
  onPermissionRequest?(context: ZCodePermissionRequestContext): void;
  onEvent?(event: ZCodeAgentEvent): void;
  onExit?(code: number | null): void;
}

/** 本地桌面适配层固定使用连续投递。 */
const DELIVERY_KIND = 'desktop-continuous';

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
  /** 会话事件水位：已分发的最大 seq（含订阅补发）。 */
  private lastSeq: number | undefined;
  /** seq 缺口期间的缓存事件（等重同步补齐后按序冲刷）。 */
  private pendingEvents = new Map<number, { method: string; event: ZCodeEventEnvelope & Record<string, unknown> }>();
  private resyncInFlight = false;
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
    this.lastSeq = undefined;
    this.pendingEvents = new Map();
    this.resyncInFlight = false;
    const client = new ZCodeProtocolClient({
      executable: this.options.executable,
      workingDirectory: this.options.workspace.workspacePath,
      deps: this.options.deps,
      runId: this.options.runId,
    });
    client.onNotification((method, params) => this.onNotification(method, params));
    client.onServerRequest((id, method, params) => this.onServerRequest(id, method, params));
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
      await this.subscribeSession();
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

  /** 订阅会话事件流。订阅失败视为连接失败——事件流不可靠时适配层不假装正常。 */
  private async subscribeSession(): Promise<void> {
    const client = this.client;
    if (!client || !this.session) return;
    const result = await client.request('session/subscribe', {
      sessionId: this.session,
      deliveryKind: DELIVERY_KIND,
      includeSnapshot: false,
    });
    this.applySubscribeResult(result);
  }

  /** 消费 session/subscribe 应答：先补发事件（推进水位），再落到 eventSeq 快照点。 */
  private applySubscribeResult(result: unknown): void {
    if (!result || typeof result !== 'object') return;
    const candidate = result as Record<string, unknown>;
    if (Array.isArray(candidate.events)) {
      for (const event of candidate.events) this.dispatchSessionEvent(typeof event === 'object' && event !== null && typeof (event as Record<string, unknown>).type === 'string' ? String((event as Record<string, unknown>).type) : 'session/event', event);
    }
    if (typeof candidate.eventSeq === 'number') {
      this.lastSeq = this.lastSeq === undefined ? candidate.eventSeq : Math.max(this.lastSeq, candidate.eventSeq);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (isEventEnvelope(params)) {
      this.dispatchSessionEvent(method, params);
      return;
    }
    this.options.onEvent?.({ kind: 'notification', method, payload: params });
  }

  private forward(method: string, event: ZCodeEventEnvelope & Record<string, unknown>): void {
    const { eventId, sessionId, turnId, seq, traceId, timestamp, deliveryKind, ...rest } = event;
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
  }

  /** 按信封分发事件；seq 水位去重，缺口事件先缓存、补齐后按序冲刷。 */
  private dispatchSessionEvent(method: string, event: ZCodeEventEnvelope & Record<string, unknown>): void {
    const seq = event.seq;
    if (this.lastSeq !== undefined) {
      if (seq <= this.lastSeq) return; // 重复/乱序：丢弃
      if (seq > this.lastSeq + 1) {
        // 缺口：不能立即转发（会把水位推过缺口，让补发事件被去重丢掉），先缓存。
        this.pendingEvents.set(seq, { method, event });
        this.scheduleResync();
        return;
      }
    }
    this.lastSeq = this.lastSeq === undefined ? seq : Math.max(this.lastSeq, seq);
    this.forward(method, event);
    // 补齐后按序冲刷连续的缓存事件。
    let next = this.lastSeq + 1;
    while (this.pendingEvents.has(next)) {
      const buffered = this.pendingEvents.get(next)!;
      this.pendingEvents.delete(next);
      this.lastSeq = next;
      this.forward(buffered.method, buffered.event);
      next += 1;
    }
  }

  /** seq 缺口时以 afterSeq 重发订阅补齐；并发重同步合并为一次。 */
  private scheduleResync(): void {
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    void (async () => {
      try {
        const client = this.client;
        if (!client || client.isExited || !this.session) return;
        const result = await client.request('session/subscribe', {
          sessionId: this.session,
          deliveryKind: DELIVERY_KIND,
          afterSeq: this.lastSeq ?? 0,
          includeSnapshot: false,
        });
        this.applySubscribeResult(result);
      } catch {
        // 补发失败：下面尽力冲刷缓存，不把传输故障放大成适配层异常。
      } finally {
        this.resyncInFlight = false;
        // 尽力冲刷仍未补齐的缓存事件：按 seq 序放行（数据不丢优先于严格连续）。
        const remaining = [...this.pendingEvents.entries()].sort((a, b) => a[0] - b[0]);
        this.pendingEvents.clear();
        for (const [, buffered] of remaining) {
          if (this.lastSeq !== undefined && buffered.event.seq <= this.lastSeq) continue;
          this.lastSeq = this.lastSeq === undefined ? buffered.event.seq : Math.max(this.lastSeq, buffered.event.seq);
          this.forward(buffered.method, buffered.event);
        }
      }
    })();
  }

  private onServerRequest(id: ZCodeServerRequestId, method: string, params: unknown): void {
    const client = this.client;
    if (!client) return;
    if (method !== 'interaction/requestPermission' && method !== 'interaction/requestUserInput') {
      // 未支持的反向请求：立即以错误帧拒绝，不让 server 挂起等待。
      void client.respondError(id, -32601, `unsupported server request: ${method}`).catch(() => undefined);
      return;
    }
    const respond = (decision: 'allow' | 'deny' | 'escalate' | 'modify', reason?: string, modifiedInput?: unknown): void => {
      // 应答形状 = zcodePermissionResponseSchema（两种反向请求共用）。
      void client.respond(id, {
        decision,
        ...(reason === undefined ? {} : { reason }),
        ...(modifiedInput === undefined ? {} : { modifiedInput }),
      }).catch(() => undefined);
    };
    if (this.options.onPermissionRequest) {
      this.options.onPermissionRequest({ method, params, respond });
      return;
    }
    // 无裁决回调：缺省拒绝必须以完整协议应答执行，而不是静默忽略。
    respond('deny', 'no permission handler attached');
  }
}
