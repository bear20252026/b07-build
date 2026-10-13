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

/**
 * 用户输入反向请求（interaction/requestUserInput）的上下文。
 * 响应契约与权限请求**不同**（ZCode zcodeUserInputResponseSchema）：
 * `{ action: 'accept' | 'decline' | 'cancel', content?, reason? }`——
 * R1 审计 04 曾把两种请求共用一套 decision 应答，导致用户输入请求收到错误格式。
 */
export interface ZCodeUserInputRequestContext {
  readonly method: string;
  readonly params: unknown;
  respond(action: 'accept' | 'decline' | 'cancel', content?: unknown, reason?: string): void;
}

export interface ZCodeAgentAdapterOptions {
  readonly executable: string;
  readonly workspace: ZCodeWorkspaceRef;
  readonly deps?: ZCodeProtocolDeps;
  readonly runId?: string;
  /** 权限反向请求裁决；缺省以完整协议应答执行 deny（fail-closed）。 */
  onPermissionRequest?(context: ZCodePermissionRequestContext): void;
  /** 用户输入反向请求裁决；缺省以完整协议应答执行 decline（fail-closed）。 */
  onUserInputRequest?(context: ZCodeUserInputRequestContext): void;
  onEvent?(event: ZCodeAgentEvent): void;
  onExit?(code: number | null): void;
}

/** 本地桌面适配层固定使用连续投递。 */
const DELIVERY_KIND = 'desktop-continuous';

/** seq 缺口缓冲上限：超过即判定补齐无望，标记会话不完整。 */
const PENDING_EVENTS_CAP = 256;
/** 补发重试间隔（毫秒）。 */
const RESYNC_RETRY_MS = 1_500;

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
  private streamIncomplete = false;
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
    this.streamIncomplete = false;
    const client = new ZCodeProtocolClient({
      executable: this.options.executable,
      workingDirectory: this.options.workspace.workspacePath,
      deps: this.options.deps,
      runId: this.options.runId,
    });
    client.onNotification((method, params) => this.onNotification(method, params));
    client.onServerRequest((id, method, params) => this.onServerRequest(id, method, params));
    // 退出状态必须传到上层：否则进程异常退出后 UI 仍显示「已连接」（R1 审计 06）。
    client.onExit((code) => this.options.onExit?.(code));
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

  /** 消费 session/subscribe 应答：先补发事件（按实际分发推进水位），再探测缺口。 */
  private applySubscribeResult(result: unknown): void {
    if (!result || typeof result !== 'object') return;
    const candidate = result as Record<string, unknown>;
    if (Array.isArray(candidate.events)) {
      for (const event of candidate.events) this.dispatchSessionEvent(typeof event === 'object' && event !== null && typeof (event as Record<string, unknown>).type === 'string' ? String((event as Record<string, unknown>).type) : 'session/event', event);
    }
    if (typeof candidate.eventSeq === 'number') {
      // R1 审计 R2：服务端最高序号（eventSeq）与客户端连续处理到的序号（lastSeq）
      // 必须分开——后续补发结果只在真正分发过事件时推进 lastSeq，eventSeq 超前
      // 即视为仍有缺口并再次重发订阅；绝不把未投影的事件当作已处理。
      // 仅当水位尚未初始化时才用 eventSeq 设定订阅起点（订阅点之前的事件
      // 不属于本会话视图，缺口探测从这里开始）。
      if (this.lastSeq === undefined) {
        this.lastSeq = candidate.eventSeq;
      } else if (candidate.eventSeq > this.lastSeq) {
        this.scheduleResync();
      }
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
    if (this.streamIncomplete) return; // 已标记不完整的流：不再放行，等下次 connect 重置。
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

  /** seq 缺口时以 afterSeq 重发订阅补齐；并发重同步合并为一次，失败延迟重试。 */
  private scheduleResync(): void {
    if (this.resyncInFlight || this.streamIncomplete) return;
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
        // 补发失败：保留缺口并延迟重试（R1 审计 06——不再按序放行不连续事件，
        // 那会悄悄跳过丢失的序号，让投影层误以为看到了完整事件流）。
      } finally {
        this.resyncInFlight = false;
        if (this.pendingEvents.size > PENDING_EVENTS_CAP) {
          // 补齐遥遥无期：明确标记会话不完整并放弃缓冲，绝不静默丢事件。
          this.streamIncomplete = true;
          this.pendingEvents.clear();
          this.options.onEvent?.({ kind: 'notification', method: 'session/streamIncomplete', payload: { reason: 'zcode-event-gap-unresolved' } });
          return;
        }
        if (this.pendingEvents.size > 0) {
          setTimeout(() => this.scheduleResync(), RESYNC_RETRY_MS);
        }
      }
    })();
  }

  /** 事件流是否因未补齐的缺口而不再完整（UI 可据此提示用户）。 */
  get isStreamIncomplete(): boolean {
    return this.streamIncomplete;
  }

  private onServerRequest(id: ZCodeServerRequestId, method: string, params: unknown): void {
    const client = this.client;
    if (!client) return;
    if (method === 'interaction/requestPermission') {
      const respond = (decision: 'allow' | 'deny' | 'escalate' | 'modify', reason?: string, modifiedInput?: unknown): void => {
        // 应答形状 = zcodePermissionResponseSchema。
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
      return;
    }
    if (method === 'interaction/requestUserInput') {
      // 用户输入的响应契约是 { action, content?, reason? }，不是权限的 { decision }。
      const respond = (action: 'accept' | 'decline' | 'cancel', content?: unknown, reason?: string): void => {
        void client.respond(id, {
          action,
          ...(content === undefined ? {} : { content }),
          ...(reason === undefined ? {} : { reason }),
        }).catch(() => undefined);
      };
      if (this.options.onUserInputRequest) {
        this.options.onUserInputRequest({ method, params, respond });
        return;
      }
      respond('decline', undefined, 'no user-input handler attached');
      return;
    }
    // 未支持的反向请求：立即以错误帧拒绝，不让 server 挂起等待。
    void client.respondError(id, -32601, `unsupported server request: ${method}`).catch(() => undefined);
  }
}
