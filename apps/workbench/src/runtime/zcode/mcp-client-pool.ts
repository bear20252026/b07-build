// 一个文件=一种作用：MCP 客户端连接池——按服务器复用会话、引用计数、空闲宽限回收。
//
// 借鉴 ZCode `adapters/src/mcp/pool.ts` 的池面（entry + refs + idleGrace +
// stats），裁剪到 b07 所需：key = serverId（+ 隔离范围，session|workspace 二
// 选一，与 ZCode 的 McpConnectionContext.isolation 同义）；引用归零后不立即
// 断，宽限 30s 内的新 acquire 直接复用同一会话（省一次握手）；宽限到点才真
// 关。close() 排空：先拒新 acquire，再关全部 entry（含宽限中的）。
//
// 会话由官方 SDK 承担（`SdkMcpSession`）——协议、分帧、请求关联、超时取消都不再由
// 本仓自己实现。这里只剩**池化**：复用、引用计数、宽限回收。

import type { McpWireTransport } from './mcp-client-transport.js';
import { SdkMcpSession, type McpLeaseSession } from './mcp-sdk-session.js';

export type McpIsolation = 'session' | 'workspace';

export interface McpPoolEntryKey {
  readonly serverId: string;
  readonly isolation: McpIsolation;
  /** session 隔离时的会话标识；workspace 隔离忽略。 */
  readonly scopeId?: string;
}

export interface McpClientPoolOptions {
  /** 传输工厂：真实 stdio/HTTP 传输在 P0-1b 由原生侧提供；测试注入内存传输。 */
  createTransport(entry: McpPoolEntryKey): Promise<McpWireTransport> | McpWireTransport;
  readonly idleGraceMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export interface McpPoolLease {
  readonly entry: McpPoolEntryKey;
  readonly session: McpLeaseSession;
  /** 归还引用；归零后进入空闲宽限而非立即关闭。 */
  release(): void;
}

interface PoolEntry {
  readonly key: string;
  readonly spec: McpPoolEntryKey;
  /** 握手完成后回填；connecting 在途期间为 undefined。 */
  session: SdkMcpSession | undefined;
  transport: McpWireTransport | undefined;
  refs: number;
  closeTimer?: ReturnType<typeof setTimeout>;
  connecting?: Promise<SdkMcpSession>;
}

const DEFAULT_IDLE_GRACE_MS = 30_000;

function entryKey(spec: McpPoolEntryKey): string {
  return spec.isolation === 'session' ? `${spec.isolation}:${spec.scopeId ?? '-'}:${spec.serverId}` : `${spec.isolation}:${spec.serverId}`;
}

export class McpClientPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly idleGraceMs: number;
  private closed = false;

  constructor(private readonly options: McpClientPoolOptions) {
    this.idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  }

  get activeConnections(): number {
    return this.entries.size;
  }

  get pendingCloseConnections(): number {
    return [...this.entries.values()].filter((entry) => entry.closeTimer !== undefined).length;
  }

  /**
   * 取一个已握手的会话租约。同 key 复用进行中的连接（并发 acquire 共享同一次
   * 握手，不重复开进程）；握手失败即拒并清掉半死 entry。
   */
  async acquire(spec: McpPoolEntryKey): Promise<McpPoolLease> {
    if (this.closed) throw new Error('mcp-pool-closed');
    const key = entryKey(spec);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.closeTimer) {
        clearTimeout(existing.closeTimer);
        existing.closeTimer = undefined;
      }
      existing.refs += 1;
      // 并发 acquire 共享同一次在途握手：不重复开进程、不重复 initialize。
      if (existing.connecting) await existing.connecting;
      if (!existing.session) throw new Error('mcp-pool-entry-not-ready');
      return { entry: spec, session: existing.session, release: () => this.release(key) };
    }
    const entry: PoolEntry = {
      key,
      spec,
      session: undefined,
      transport: undefined,
      refs: 1,
      connecting: undefined,
    };
    this.entries.set(key, entry);
    entry.connecting = (async () => {
      const transport = await this.options.createTransport(spec);
      entry.transport = transport;
      entry.session = new SdkMcpSession({
        serverId: spec.serverId,
        transport,
        ...(this.options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      });
      try {
        await entry.session.connect();
      } catch (error) {
        this.entries.delete(key);
        void transport.close().catch(() => undefined);
        throw error;
      }
      return entry.session;
    })();
    try {
      const session = await entry.connecting;
      return { entry: spec, session, release: () => this.release(key) };
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  /** 关闭池：拒绝新 acquire，全部 entry 立即关闭（不等宽限）。 */
  async close(): Promise<void> {
    this.closed = true;
    const closing = [...this.entries.values()].map(async (entry) => {
      if (entry.closeTimer) clearTimeout(entry.closeTimer);
      await entry.session?.close().catch(() => undefined);
      await entry.transport?.close().catch(() => undefined);
    });
    this.entries.clear();
    await Promise.all(closing);
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    entry.closeTimer = setTimeout(() => {
      this.entries.delete(key);
      void entry.session?.close().catch(() => undefined);
      void entry.transport?.close().catch(() => undefined);
    }, this.idleGraceMs);
  }
}
