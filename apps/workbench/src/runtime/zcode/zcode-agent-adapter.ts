import {
  SESSION_COMMAND_REASON_CODES,
  SessionCommandLedger,
  acceptSessionCommand,
  createSessionCommand,
  createSessionLogSync,
  isStaleSessionCommand,
  rejectSessionCommand,
  sessionCommandId,
  withCommandBase,
  type SessionCommand,
  type SessionCommandAck,
  type SessionLogBase,
  type SessionLogEntry,
  type SessionLogReplay,
  type SessionLogSync,
} from '@awo/protocol';
import { ZCodeProtocolClient, ZCodeProtocolError, type ZCodeProtocolDeps, type ZCodeServerRequestId } from './zcode-protocol-client';

/**
 * ZCode Agent 适配器：把 NOVA 的会话语义映射到 ZCode Protocol。
 *
 * 覆盖的闭环（对应 ZCode `session/send` / `session/subscribe` 协议文档）：
 * - connect：spawn agent-server + `session/create` + `session/subscribe`（事件流水位）；
 * - send：`session/send { sessionId, inputId, content }`（协议立即 ACK，turn 进度走通知）；
 *   inputId 取命令的 commandId——重试复用同一 id 才是幂等键，换 id 等于第二次副作用；
 *   基准取会话权威水位（state.updated.revision）作为 expectedRevision，被 -32009 判
 *   stale 时采纳对端回的实际水位，不带着过期基准原地重放；
 * - 事件：seq 连续性、缺口补齐、快照权威替换全部由 `@awo/protocol` 的会话收敛机
 *   承担（借 ZCode V4 的同步语义），适配层只做信封归属判断与载荷转发；
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

/**
 * ZCode 服务端 CAS 拒绝（`assertExpectedRevision`）的 JSON-RPC 错误码：
 * 会话结构水位与 `expectedRevision` 不一致。按码识别，不按错误文本猜。
 */
const ZCODE_STALE_REVISION_CODE = -32009;

/** 收敛机承载的日志条目载荷：事件方法名 + 原始信封（投影层要的形态）。 */
type SessionEventEntry = { readonly method: string; readonly event: ZCodeEventEnvelope & Record<string, unknown> };

/** 一次提交的结果：`sent` 才是真发出；`settled`/`in-flight` 表示零重复副作用。 */
export type ZCodeSendOutcome =
  | { readonly kind: 'sent'; readonly command: SessionCommand; readonly ack: SessionCommandAck }
  | { readonly kind: 'settled'; readonly ack: SessionCommandAck }
  | { readonly kind: 'in-flight'; readonly command: SessionCommand };

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

/**
 * CAS 失败应答里的服务端实际水位（`data.actualRevision`）。
 * 采纳它当下一次基准——带着过期基准原地重放只会次次被拒。
 */
function actualRevisionFromErrorData(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const actual = (data as Record<string, unknown>).actualRevision;
  return typeof actual === 'number' && Number.isInteger(actual) && actual >= 0 ? actual : undefined;
}

/** 补发批里的事件名：v1 把类型放在 `type`，通知路径则用 JSON-RPC method。 */
function eventNameOf(event: ZCodeEventEnvelope & Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type : 'session/event';
}

/** ACK 里服务端宣告的最高序号（订阅点水位）；非法形状按「未宣告」处理。 */
function subscribeEventSeq(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const seq = (result as Record<string, unknown>).eventSeq;
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : undefined;
}

export class ZCodeAgentAdapter {
  private client: ZCodeProtocolClient | undefined;
  private session: string | undefined;
  /** 会话结构水位的最近权威读数（state.updated.revision）：命令 CAS 基准只认这个来源。 */
  private lastRevision: number | undefined;
  private readonly clientId = sessionCommandId();
  private readonly commands = new SessionCommandLedger();
  /** seq 连续 / 缺口补齐 / 快照权威替换全在这里（协议包），适配层不再自己数序号。 */
  private readonly sync: SessionLogSync<SessionEventEntry, unknown>;
  private readonly options: ZCodeAgentAdapterOptions;

  constructor(options: ZCodeAgentAdapterOptions) {
    this.options = options;
    this.sync = createSessionLogSync<SessionEventEntry, unknown>({
      requestReplay: (base, forceSnapshot) => this.requestReplay(base, forceSnapshot),
      // v1 对端的快照载荷是 ZCode 会话状态原样；行级重建属于统一聊天后端批次，
      // 这里先把权威快照如实投递给下游（收敛机的基准同时已复位），绝不静默吞掉。
      applySnapshot: (snapshot) => this.options.onEvent?.({ kind: 'notification', method: 'session/snapshot', payload: snapshot.snapshot }),
      applyEntry: (entry) => this.forward(entry.payload.method, entry.payload.event),
      onIncomplete: (reason) => this.options.onEvent?.({ kind: 'notification', method: 'session/streamIncomplete', payload: { reason } }),
      onRecovered: () => this.options.onEvent?.({ kind: 'notification', method: 'session/streamRecovered', payload: { reason: 'authoritative-snapshot' } }),
    });
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
    this.sync.reset();
    this.commands.clear();
    this.lastRevision = undefined;
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

  /**
   * 提交用户输入；协议立即 ACK，生成进度经 onEvent 推送。
   *
   * 幂等：命令以 {sessionId, commandId} 为键登记在客户端表里——同 id 在途时不重复
   * 提交（一次抖动变成两次执行就是这个环节失控），已裁决时直接复用原裁决。
   * CAS：基准只取会话权威水位 `lastRevision`；被 -32009 判 stale 说明准入阶段就拒了、
   * 没有副作用，于是带对端回的实际水位重发一次（commandId 不变），再失败就交回裁决。
   */
  async send(content: string, commandId?: string): Promise<ZCodeSendOutcome> {
    const client = this.client;
    if (!client || !this.session) throw new Error('zcode-adapter-not-connected');
    const command = createSessionCommand({
      clientId: this.clientId,
      sessionId: this.session,
      type: 'session/send',
      payload: { content },
      ...(commandId === undefined ? {} : { commandId }),
      ...(this.lastRevision === undefined ? {} : { baseRevision: this.lastRevision }),
    });
    const begin = this.commands.begin(command);
    if (begin.kind === 'settled') return { kind: 'settled', ack: begin.ack };
    if (begin.kind === 'in-flight') return { kind: 'in-flight', command: begin.command };
    // 同 id 换内容 = 串号提交，幂等键就此失效；必须显式失败，不能猜该返回哪个结果。
    if (begin.kind === 'conflict') throw new Error(begin.reason);
    const pending = begin.command;
    try {
      await client.request('session/send', this.wireParams(pending));
      const ack = acceptSessionCommand(pending.commandId);
      this.commands.settle(pending, ack);
      return { kind: 'sent', command: pending, ack };
    } catch (error) {
      const ack = this.ackFromFailure(pending, error);
      if (isStaleSessionCommand(ack) && ack.revisionAtDecision !== undefined) {
        const retry = withCommandBase(pending, { revision: ack.revisionAtDecision });
        try {
          await client.request('session/send', this.wireParams(retry));
          const settled = acceptSessionCommand(retry.commandId);
          this.commands.settle(pending, settled);
          return { kind: 'sent', command: retry, ack: settled };
        } catch (retryError) {
          this.commands.settle(pending, this.ackFromFailure(pending, retryError));
          throw retryError;
        }
      }
      this.commands.settle(pending, ack);
      throw error;
    }
  }

  /** 命令 → `session/send` 线参数；inputId 即幂等键，expectedRevision 即 CAS 基准。 */
  private wireParams(command: SessionCommand): Record<string, unknown> {
    const content = (command.payload as { readonly content?: unknown }).content;
    return {
      sessionId: command.sessionId,
      inputId: command.commandId,
      content,
      ...(command.baseRevision === undefined ? {} : { expectedRevision: command.baseRevision }),
    };
  }

  /** 把对端/传输失败归一为命令裁决（带稳定原因码）；stale 时采纳对端实际水位。 */
  private ackFromFailure(command: SessionCommand, error: unknown): SessionCommandAck {
    if (error instanceof ZCodeProtocolError) {
      if (error.protocolCode === ZCODE_STALE_REVISION_CODE) {
        const actual = actualRevisionFromErrorData(error.data);
        if (actual !== undefined) this.lastRevision = actual;
        return rejectSessionCommand(command.commandId, {
          status: 'stale',
          reasonCode: SESSION_COMMAND_REASON_CODES.staleRevision,
          ...(actual === undefined ? {} : { revisionAtDecision: actual }),
          message: error.message,
        });
      }
      if (error.code === 'zcode-transport-closed' || error.code === 'zcode-stdin-write-failed' || error.code === 'zcode-request-timeout') {
        // 结果未知（可能已执行）：只登记 failed，调用方复用 commandId 让对端去重。
        return rejectSessionCommand(command.commandId, {
          status: 'failed',
          reasonCode: SESSION_COMMAND_REASON_CODES.transportClosed,
          message: error.message,
        });
      }
      return rejectSessionCommand(command.commandId, {
        status: 'rejected',
        reasonCode: SESSION_COMMAND_REASON_CODES.invalidEnvelope,
        message: error.message,
      });
    }
    return rejectSessionCommand(command.commandId, {
      status: 'failed',
      reasonCode: SESSION_COMMAND_REASON_CODES.invalidEnvelope,
      message: error instanceof Error ? error.message : String(error),
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
    this.lastRevision = undefined;
    // 会话关闭即作废水位、缓冲与在途命令：重连后不能拿旧水位判连续性，
    // 也不能让已关闭连接上的命令被误判为「已有裁决」。
    this.sync.reset();
    this.commands.clear();
    await client.close();
  }

  /** 订阅会话事件流。订阅失败视为连接失败——事件流不可靠时适配层不假装正常。 */
  private async subscribeSession(): Promise<void> {
    const result = await this.subscribe({ includeSnapshot: false });
    const snapshot = this.snapshotFrom(result);
    if (snapshot !== undefined) {
      this.sync.acceptSnapshot(snapshot);
      return;
    }
    // ACK 里的 events 是「订阅点之后」的补发批：先按批首序号锚定基准，再逐条
    // 交给收敛机——顺序放行、缺口判定、去重全由机器负责，适配层不自己数序号。
    const entries = this.entriesFrom(result);
    if (entries.length > 0) this.sync.bootstrap({ seq: entries[0].seq - 1 });
    for (const entry of entries) this.sync.acceptEntry(entry);
    const eventSeq = subscribeEventSeq(result);
    if (eventSeq !== undefined) this.sync.noteServerSeq(eventSeq);
  }

  /** `session/subscribe` 线参数：afterSeq 续播，includeSnapshot 升级要权威快照。 */
  private async subscribe(request: { readonly afterSeq?: number; readonly includeSnapshot: boolean }): Promise<unknown> {
    const client = this.client;
    if (!client || !this.session) throw new Error('zcode-adapter-not-connected');
    return client.request('session/subscribe', {
      sessionId: this.session,
      deliveryKind: DELIVERY_KIND,
      ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
      includeSnapshot: request.includeSnapshot,
    });
  }

  /**
   * 收敛机的补齐入口。v1 对端没有独立的 replay 方法：
   * `session/subscribe(afterSeq)` 就是续播，升级收敛靠 `includeSnapshot`。
   */
  private async requestReplay(base: SessionLogBase, forceSnapshot: boolean): Promise<SessionLogReplay<SessionEventEntry, unknown>> {
    const result = await this.subscribe({ afterSeq: base.seq, includeSnapshot: forceSnapshot });
    const snapshot = this.snapshotFrom(result);
    if (snapshot !== undefined) return { kind: 'snapshot', snapshot };
    return { kind: 'entries', entries: this.entriesFrom(result) };
  }

  /** 补发批 → 条目：只收信封合法且属于当前会话的事件，其余整体忽略。 */
  private entriesFrom(result: unknown): SessionLogEntry<SessionEventEntry>[] {
    if (!result || typeof result !== 'object') return [];
    const events = (result as Record<string, unknown>).events;
    if (!Array.isArray(events)) return [];
    const entries: SessionLogEntry<SessionEventEntry>[] = [];
    for (const event of events) {
      if (!isEventEnvelope(event) || !this.owns(event)) continue;
      entries.push({ seq: event.seq, payload: { method: eventNameOf(event), event } });
    }
    return entries;
  }

  /**
   * 应答里的权威快照。水位优先取快照自带的 `runtime.eventSeq`，缺失才退回
   * ACK 的 eventSeq——基准必须落在可比的水位上，不能猜。
   */
  private snapshotFrom(result: unknown): { readonly seq: number; readonly snapshot: unknown } | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const candidate = result as Record<string, unknown>;
    if (!candidate.snapshot || typeof candidate.snapshot !== 'object') return undefined;
    const runtime = (candidate.snapshot as Record<string, unknown>).runtime;
    const inner = typeof runtime === 'number' ? undefined : (runtime as Record<string, unknown> | undefined)?.eventSeq;
    const seq = typeof inner === 'number' ? inner : subscribeEventSeq(candidate);
    if (seq === undefined) return undefined;
    return { seq, snapshot: candidate.snapshot };
  }

  /** 事件归属：其它会话（或伪造信封）的事件不得推进本会话水位，也不得进入投影（R1 审计 R4）。 */
  private owns(event: { readonly sessionId: string }): boolean {
    return this.session === undefined || event.sessionId === this.session;
  }

  private onNotification(method: string, params: unknown): void {
    if (isEventEnvelope(params)) {
      if (!this.owns(params)) return;
      this.noteRevision(params);
      // 连续性判断交给收敛机：它按 seq 放行、缓存缺口并自行补齐。
      this.sync.acceptEntry({ seq: params.seq, payload: { method, event: params } });
      return;
    }
    this.noteRevision(params);
    this.options.onEvent?.({ kind: 'notification', method, payload: params });
  }

  /** 采纳会话结构水位（`state.updated.revision`）：命令 CAS 基准的唯一事件来源。 */
  private noteRevision(params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const revision = (params as Record<string, unknown>).revision;
    if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 0) this.lastRevision = revision;
  }

  private forward(method: string, event: ZCodeEventEnvelope & Record<string, unknown>): void {
    const { eventId, sessionId, turnId, seq, traceId, timestamp, deliveryKind, ...rest } = event;
    // 补发批走的是这条路（不经过 onNotification），水位同样要采纳。
    this.noteRevision(rest);
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

  /** 事件流是否因未补齐的缺口而不再完整（UI 可据此提示用户）。 */
  get isStreamIncomplete(): boolean {
    return this.sync.incomplete;
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
