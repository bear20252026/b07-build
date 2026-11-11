// MCP 连接注册表。
//
// ## 它补的是什么
//
// 底层件早就在：`McpClientSession`（`connect` / `listTools`）、`mcp-stdio-transport`
// （经 Tauri 起进程）、`McpClientPool`（按会话/工作区租借）。但**没有一处记录"现在
// 哪些 server 连着、各有多少工具"** —— 于是 `plugin-reference` 的 `liveMcpServers`
// 永远拿不到数据，插件 `@` 引用只能列出空。
//
// 这个注册表就是那一层：连上、记状态、报工具数、能关掉。
//
// ## 三条边界（刻意划在这里）
//
// 1. **不决定 spawn 什么。** 会话由注入的 `createSession` 造。起什么进程、带什么参数、
//    信任不信任，都是安全决策，不该藏在一个注册表里。注册表只负责"连上之后记下来"。
// 2. **失败不外抛。** 一个 server 连不上，其余照常可用；失败原因记在条目里给界面看。
//    抛出去会让"有一个坏 server"变成"整页打不开"。
// 3. **没有可见工具的 server 不算 live。** 列一个工具数为 0 的 server，模型会去调
//    不存在的工具 —— 这正是 `plugin-reference` 要求"provider 可见"的原因。

import { normalizeMcpToolDescriptors } from './mcp-tool-descriptor';

/** 一条连接的对外快照。 */
export interface McpLiveServerSnapshot {
  readonly serverId: string;
  readonly state: 'connecting' | 'ready' | 'failed';
  /** canonical 工具名（`mcp__<server>__<tool>`）。 */
  readonly toolNames: readonly string[];
  /** `failed` 时的原因；`ready` 时为空。 */
  readonly error?: string;
}

/** 注册表需要的最小会话接口（`McpClientSession` 满足它）。 */
export interface McpSessionLike {
  connect(): Promise<unknown>;
  listTools(): Promise<readonly unknown[]>;
  close(): Promise<void>;
}

export interface McpConnectionRegistryOptions {
  /**
   * 为一个 server 建会话。返回 `undefined` 表示**没法建**（例如拿不到启动规格）——
   * 这不是异常，是一种已知状态，会记成 `failed` 并带上 `no-session-spec`。
   */
  createSession(serverId: string): McpSessionLike | undefined;
}

interface RegistryEntry {
  snapshot: McpLiveServerSnapshot;
  session?: McpSessionLike;
  /** 进行中的连接；并发 `connect` 复用它，避免同一个 server 被起两次。 */
  pending?: Promise<McpLiveServerSnapshot>;
}

/** 错误对象转成一句人话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知错误');
}

export class McpConnectionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(private readonly options: McpConnectionRegistryOptions) {}

  /**
   * 连接一个 server。
   *
   * 幂等：已 `ready` 直接返回；正在连则复用同一个 Promise（并发调用不会起两个进程）。
   * 失败不抛，返回 `state: 'failed'` 的快照。
   */
  async connect(serverId: string): Promise<McpLiveServerSnapshot> {
    const existing = this.entries.get(serverId);
    if (existing?.snapshot.state === 'ready') return existing.snapshot;
    if (existing?.pending) return existing.pending;

    // 占位条目**先**登记，再开始连接。
    // 反过来（先连再登记）会有一个真 bug：`performConnect` 在"拿不到会话规格"这条路径上
    // 是**同步**返回的，它写下的 `failed` 会被随后那句占位覆盖成 `connecting` —— 于是
    // 一个明明没配好的 server 永远显示"连接中"。这个顺序是被测试钉住的。
    const entry: RegistryEntry = { snapshot: { serverId, state: 'connecting', toolNames: [] } };
    this.entries.set(serverId, entry);
    const pending = this.performConnect(serverId, entry);
    entry.pending = pending;
    const snapshot = await pending;
    entry.pending = undefined;
    return snapshot;
  }

  private async performConnect(serverId: string, entry: RegistryEntry): Promise<McpLiveServerSnapshot> {
    const session = this.options.createSession(serverId);
    if (!session) {
      // 直接改这条 entry（而不是 `entries.set` 一条新的）—— 否则 `connect` 里那个
      // `entry` 引用会指向一个已被替换掉的对象，后续 `pending` 清理就写丢了。
      entry.snapshot = { serverId, state: 'failed', toolNames: [], error: 'no-session-spec' };
      return entry.snapshot;
    }
    try {
      await session.connect();
      const tools = await session.listTools();
      const descriptors = normalizeMcpToolDescriptors(serverId, tools);
      entry.snapshot = {
        serverId,
        state: 'ready',
        toolNames: descriptors.map((descriptor) => descriptor.name),
      };
      entry.session = session;
      return entry.snapshot;
    } catch (error) {
      // 连不上就把会话收掉：留着它只会在退出时变成一句"进程还在跑"的谜。
      await session.close().catch(() => undefined);
      entry.snapshot = { serverId, state: 'failed', toolNames: [], error: describeError(error) };
      return entry.snapshot;
    }
  }

  /** 全部条目（含失败的）。界面要能显示"这个连不上，原因是…"。 */
  list(): readonly McpLiveServerSnapshot[] {
    return [...this.entries.values()].map((entry) => entry.snapshot).sort((left, right) => left.serverId.localeCompare(right.serverId));
  }

  /**
   * 给 `plugin-reference` 用的 `liveMcpServers`。
   *
   * 只包含 **`ready` 且工具数 > 0** 的 server —— 一个连得上但没有任何可见工具的 server，
   * 列给模型等于让它去调不存在的工具。
   */
  liveMcpServers(): ReadonlyMap<string, { readonly providerVisibleToolCount: number }> {
    const live = new Map<string, { providerVisibleToolCount: number }>();
    for (const entry of this.entries.values()) {
      const { snapshot } = entry;
      if (snapshot.state !== 'ready' || snapshot.toolNames.length === 0) continue;
      live.set(snapshot.serverId, { providerVisibleToolCount: snapshot.toolNames.length });
    }
    return live;
  }

  /** 关掉一个 server。幂等：没连过、已关过都不报错。 */
  async close(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    this.entries.delete(serverId);
    if (!entry.session) return;
    await entry.session.close().catch(() => undefined);
  }

  /** 关掉全部。应用退出、切换工作区时用。 */
  async closeAll(): Promise<void> {
    const sessions = [...this.entries.values()].map((entry) => entry.session).filter((session): session is McpSessionLike => session !== undefined);
    this.entries.clear();
    // 一个关失败不该挡住其余关闭。
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  }
}
