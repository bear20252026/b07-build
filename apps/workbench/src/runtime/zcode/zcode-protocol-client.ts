import { startZcodeAgent, stopZcodeAgent, subscribeZcodeProcess, writeZcodeStdin, zcodeProcessErrorText, type ZCodeLinePayload } from './zcode-process-client';

/**
 * ZCode Protocol 的 NDJSON 客户端（协议面）。
 *
 * ZCode agent-server 的线协议（packages/shared/src/zcode-protocol）：
 * - 请求：`{ id, method, params }`，应答 `{ id, result }` 或 `{ id, error: { code, message } }`；
 * - 通知：`{ method, params }`（session 事件、startup/storageState 等）；
 * 每行一个 JSON，UTF-8。
 *
 * 这里只做帧解析、请求/应答关联和通知分发；ZCode 业务语义在 zcode-agent-adapter。
 */

export type ZCodeProtocolMessage =
  | { readonly id: number | string; readonly method: string; readonly params?: unknown }
  | { readonly method: string; readonly params?: unknown }
  | { readonly id: number | string; readonly result: unknown }
  | { readonly id: number | string; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

export interface ZCodeProtocolDeps {
  start(runId: string, executable: string, workingDirectory: string | undefined): Promise<void>;
  writeLine(runId: string, line: string): Promise<void>;
  stop(runId: string): Promise<void>;
  subscribe(handlers: {
    onLine(payload: ZCodeLinePayload): void;
    onExit(payload: { runId: string; code: number | null }): void;
  }): Promise<() => void>;
}

/** 服务端反向请求的 id（协议允许 string | number，见 zcodeProtocolRequestIdSchema）。 */
export type ZCodeServerRequestId = number | string;

/** 服务端反向请求（带 id 的 {id, method, params} 帧）处理器。 */
export type ZCodeServerRequestHandler = (
  id: ZCodeServerRequestId,
  method: string,
  params: unknown,
) => void;

export const defaultZcodeProtocolDeps: ZCodeProtocolDeps = {
  start: (runId, executable, workingDirectory) => startZcodeAgent(runId, executable, workingDirectory),
  writeLine: (runId, line) => writeZcodeStdin(runId, line),
  stop: (runId) => stopZcodeAgent(runId),
  subscribe: (handlers) => subscribeZcodeProcess(handlers),
};

export class ZCodeProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /**
     * 服务端 JSON-RPC 错误码。CAS 拒绝（-32009）等裁决语义必须按码分流——
     * 错误文案是对人看的，随时会变，拿它判流程就是把协议实现绑在字符串上。
     */
    readonly protocolCode?: number,
    /** 错误附带数据（如 stale 拒绝里的实际水位）：原样透传，由调用方解释。 */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

interface PendingEntry {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ZCodeProtocolClientOptions {
  readonly executable: string;
  readonly workingDirectory?: string;
  readonly runId?: string;
  readonly deps?: ZCodeProtocolDeps;
  readonly requestTimeoutMs?: number;
}

/** 一个 agent-server 子进程对应一个 client 实例。 */
export class ZCodeProtocolClient {
  private readonly runId: string;
  private readonly deps: ZCodeProtocolDeps;
  private readonly requestTimeoutMs: number;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private started = false;
  private exited = false;
  private exitCode: number | null | undefined = undefined;
  private unlisten: (() => void) | undefined;
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly serverRequestHandlers = new Set<ZCodeServerRequestHandler>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private readonly stderrLog: string[] = [];

  constructor(private readonly options: ZCodeProtocolClientOptions) {
    this.runId = options.runId ?? `zcode-${crypto.randomUUID()}`;
    this.deps = options.deps ?? defaultZcodeProtocolDeps;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get id(): string {
    return this.runId;
  }

  get isExited(): boolean {
    return this.exited;
  }

  get exitStatus(): number | null | undefined {
    return this.exitCode;
  }

  recentStderr(limit = 10): readonly string[] {
    return this.stderrLog.slice(-limit);
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * 订阅服务端反向请求（`interaction/requestPermission` 等带 id 的请求帧）。
   * 未注册任何处理器时，反向请求会被立即以 -32601 拒绝（fail-closed，
   * 避免 server 挂起等待一个永远不会到来的应答）。
   */
  onServerRequest(handler: ZCodeServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  /** 订阅子进程退出（含退出码）；adapter 用它把退出状态传到会话 UI（R1 审计 06）。 */
  onExit(handler: (code: number | null) => void): () => void {
    // 已退出的客户端立即补发一次：订阅迟到也要看到终态。
    if (this.exited) handler(this.exitCode ?? null);
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** 回发反向请求的应答帧（`{id, result}`）。 */
  async respond(id: ZCodeServerRequestId, result: unknown): Promise<void> {
    await this.deps.writeLine(this.runId, JSON.stringify({ id, result }));
  }

  /** 回发反向请求的错误帧（`{id, error}`）。 */
  async respondError(id: ZCodeServerRequestId, code: number, message: string): Promise<void> {
    await this.deps.writeLine(this.runId, JSON.stringify({ id, error: { code, message } }));
  }

  /** spawn 子进程并接管 stdout/stderr/exit 事件流。 */
  async start(): Promise<void> {
    if (this.started) throw new ZCodeProtocolError('zcode-client-already-started', '该客户端已启动。');
    this.started = true;
    this.unlisten = await this.deps.subscribe({
      onLine: (payload) => this.onLine(payload),
      onExit: (payload) => {
        if (payload.runId !== this.runId) return;
        this.exited = true;
        this.exitCode = payload.code;
        this.rejectAllPending(new ZCodeProtocolError('zcode-transport-closed', `ZCode 协议子进程已退出（code=${payload.code ?? 'null'}）。`));
        for (const handler of this.exitHandlers) {
          try {
            handler(payload.code);
          } catch { /* 单个监听器异常不阻断退出分发。 */ }
        }
      },
    });
    try {
      await this.deps.start(this.runId, this.options.executable, this.options.workingDirectory);
    } catch (error) {
      this.unlisten?.();
      this.unlisten = undefined;
      throw new ZCodeProtocolError('zcode-start-failed', zcodeProcessErrorText(error));
    }
  }

  /**
   * 发送协议请求并等待应答。子进程可能还没来得及读 stdin，但写入会被原生层
   * 排队，协议帧顺序即请求顺序。
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.exited) throw new ZCodeProtocolError('zcode-transport-closed', 'ZCode 协议子进程已退出。');
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZCodeProtocolError('zcode-request-timeout', `ZCode 请求 ${method} 超时。`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.deps.writeLine(this.runId, JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    } catch (error) {
      // 写入失败 = 这条请求永远等不到应答：立即清理挂起项并传播发送错误，
      // 不能把它留在 pending 里空等超时（R1 审计 06）。
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
      }
      throw error instanceof Error ? error : new ZCodeProtocolError('zcode-stdin-write-failed', '写入 ZCode 协议子进程失败。');
    }
    return promise;
  }

  async close(): Promise<void> {
    this.rejectAllPending(new ZCodeProtocolError('zcode-transport-closed', 'ZCode 会话已关闭。'));
    try {
      await this.deps.stop(this.runId);
    } catch { /* 已退出时 stop 报 not-active，忽略。 */ }
    this.unlisten?.();
    this.unlisten = undefined;
  }

  private onLine(payload: ZCodeLinePayload): void {
    if (payload.runId !== this.runId) return;
    if (payload.stream === 'stderr') {
      this.stderrLog.push(payload.text);
      if (this.stderrLog.length > 100) this.stderrLog.shift();
      return;
    }
    let message: ZCodeProtocolMessage;
    try {
      message = JSON.parse(payload.text) as ZCodeProtocolMessage;
    } catch {
      // 非 JSON 行（banner 等）忽略；协议帧只在 stdout 上按行出现。
      return;
    }
    if (!message || typeof message !== 'object') return;
    // 服务端反向请求：带 id 且带 method。必须先于应答/通知分支判断。
    if ('id' in message && 'method' in message) {
      if (this.serverRequestHandlers.size === 0) {
        void this.respondError(message.id as ZCodeServerRequestId, -32601, 'no interaction handler attached')
          .catch(() => undefined);
        return;
      }
      for (const handler of this.serverRequestHandlers) {
        try {
          handler(message.id as ZCodeServerRequestId, message.method, message.params);
        } catch { /* 单个监听器异常不阻断分发。 */ }
      }
      return;
    }
    if ('id' in message && 'result' in message) {
      const entry = this.pending.get(message.id as number);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(message.id as number);
        entry.resolve(message.result);
      }
      return;
    }
    if ('id' in message && 'error' in message) {
      const entry = this.pending.get(message.id as number);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(message.id as number);
        entry.reject(new ZCodeProtocolError(
          `zcode-protocol-error-${message.error.code}`,
          message.error.message,
          message.error.code,
          message.error.data,
        ));
      }
      return;
    }
    if ('method' in message) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(message.method, message.params);
        } catch { /* 单个监听器异常不阻断分发。 */ }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
