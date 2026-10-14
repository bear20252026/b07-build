// 一个文件=一种作用：MCP 客户端会话机——握手、请求关联、通知、超时与关闭语义。
//
// 借鉴 ZCode `adapters/src/mcp` 的会话面，裁剪到 b07 当前所需最小集：
// initialize 握手（版本协商）→ notifications/initialized → tools/list →
// tools/call → notifications/tools/list_changed 置 stale。资源订阅、
// sampling、OAuth 不在本批（按需后续批次）。
//
// 硬规则：
//   1. 未 ready 的任何调用 fail-closed（session-not-ready），绝不在握手上
//      失败后继续发请求；
//   2. 每个请求可超时（默认 30s，对齐 ZCode 执行期限），超时即拒且摘除
//      pending——迟到的响应按未知 id 丢弃；
//   3. 传输断开 = 会话死亡：全部未决请求失败，会话进入 closed；
//   4. 业务失败（isError）与协议失败分开走：前者是 ok:true 的结果字段，
//      后者才是 ok:false——调用方（工具网关）据此决定怎么呈现。

import {
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  encodeMcpFrame,
  isMcpNotification,
  isMcpResponse,
  negotiateMcpProtocolVersion,
  parseMcpFrame,
  type McpInitializeResult,
  type McpJsonRpcResponse,
  type McpRequestId,
} from './mcp-client-wire.js';
import {
  McpProtocolError,
  type McpCallToolOutcome,
  type McpCallToolResult,
  type McpWireTransport,
} from './mcp-client-transport.js';

export type McpSessionState = 'created' | 'connecting' | 'ready' | 'closed';

export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface McpClientSessionOptions {
  readonly serverId: string;
  readonly transport: McpWireTransport;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly protocolVersions?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** 注入请求 id 生成器（测试用确定性 id）。 */
  readonly nextId?: () => McpRequestId;
}

interface PendingEntry {
  readonly resolve: (response: McpJsonRpcResponse) => void;
  readonly reject: (error: McpProtocolError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class McpClientSession {
  private state: McpSessionState = 'created';
  private unsubscribe: (() => void) | undefined;
  private readonly pending = new Map<string, PendingEntry>();
  private sequence = 0;
  private negotiatedVersion: string | undefined;
  private serverCapabilities: Record<string, unknown> | undefined;
  private serverInfo: { name: string; version?: string } | undefined;
  private toolsStale = false;

  constructor(private readonly options: McpClientSessionOptions) {}

  get sessionState(): McpSessionState {
    return this.state;
  }

  get protocolVersion(): string | undefined {
    return this.negotiatedVersion;
  }

  get serverDescriptor(): { name: string; version?: string } | undefined {
    return this.serverInfo;
  }

  get serverCapabilitySet(): Record<string, unknown> | undefined {
    return this.serverCapabilities;
  }

  /** tools/list_changed 到达后置位；listTools 成功会清除。 */
  get toolsChanged(): boolean {
    return this.toolsStale;
  }

  /** 握手：initialize → 协商 → notifications/initialized。幂等（ready 后直接返回）。 */
  async connect(): Promise<McpInitializeResult> {
    if (this.state === 'ready' && this.serverInfo) {
      return {
        protocolVersion: this.negotiatedVersion ?? MCP_PROTOCOL_VERSION,
        capabilities: this.serverCapabilities ?? {},
        serverInfo: this.serverInfo,
      };
    }
    if (this.state === 'closed') throw new McpProtocolError('mcp-transport-closed', '会话已关闭');
    if (this.state === 'connecting') throw new McpProtocolError('mcp-handshake-failed', '握手已在进行');

    this.state = 'connecting';
    this.unsubscribe = this.options.transport.subscribe({
      onLine: (line) => this.handleLine(line),
      onClose: () => this.die('mcp-transport-closed', '传输层断开'),
    });

    const versions = this.options.protocolVersions ?? MCP_SUPPORTED_PROTOCOL_VERSIONS;
    let response: McpJsonRpcResponse;
    try {
      response = await this.request('initialize', {
        protocolVersion: versions[0],
        capabilities: {},
        clientInfo: this.options.clientInfo ?? MCP_CLIENT_INFO,
      });
    } catch (error) {
      // 握手失败 = 会话作废：退订传输，避免半死会话继续收帧。
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      for (const [key, entry] of [...this.pending]) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
        entry.reject(error instanceof McpProtocolError ? error : new McpProtocolError('mcp-handshake-failed', String(error)));
      }
      this.state = 'closed';
      throw error;
    }
    const result = response.result;
    if (typeof result !== 'object' || result === null) {
      this.die('mcp-response-invalid', 'initialize 结果缺失');
      throw new McpProtocolError('mcp-response-invalid', 'initialize 结果缺失');
    }
    const record = result as Record<string, unknown>;
    this.negotiatedVersion =
      typeof record.protocolVersion === 'string' ? negotiateMcpProtocolVersion(record.protocolVersion) : MCP_PROTOCOL_VERSION;
    this.serverCapabilities =
      typeof record.capabilities === 'object' && result !== null && record.capabilities !== null
        ? (record.capabilities as Record<string, unknown>)
        : {};
    const info = record.serverInfo;
    if (typeof info !== 'object' || info === null || typeof (info as Record<string, unknown>).name !== 'string') {
      this.die('mcp-response-invalid', 'initialize 结果缺少 serverInfo.name');
      throw new McpProtocolError('mcp-response-invalid', 'initialize 结果缺少 serverInfo.name');
    }
    this.serverInfo = info as { name: string; version?: string };
    await this.notify('notifications/initialized', {});
    this.state = 'ready';
    return {
      protocolVersion: this.negotiatedVersion,
      capabilities: this.serverCapabilities,
      serverInfo: this.serverInfo,
      ...(typeof record.instructions === 'string' ? { instructions: record.instructions } : {}),
    };
  }

  /** tools/list：返回服务端原始工具数组（归一化在 mcp-tool-descriptor）。 */
  async listTools(): Promise<readonly unknown[]> {
    const response = await this.request('tools/list', {});
    const result = response.result;
    if (typeof result !== 'object' || result === null || !Array.isArray((result as Record<string, unknown>).tools)) {
      throw new McpProtocolError('mcp-response-invalid', 'tools/list 结果缺少 tools 数组');
    }
    this.toolsStale = false;
    return (result as Record<string, unknown>).tools as readonly unknown[];
  }

  /**
   * tools/call。协议成功 = ok:true（result 原样带回，isError 是工具业务的
   * 失败）；协议失败 = ok:false。绝不把业务失败伪装成协议失败。
   */
  async callTool(toolName: string, args: unknown, options: { readonly timeoutMs?: number } = {}): Promise<McpCallToolOutcome> {
    if (this.state !== 'ready') {
      return { ok: false, reason: 'mcp-session-not-ready', message: `会话未就绪（${this.state}）` };
    }
    let response: McpJsonRpcResponse;
    try {
      response = await this.request('tools/call', { name: toolName, arguments: args ?? {} }, options.timeoutMs);
    } catch (error) {
      const protocolError = error instanceof McpProtocolError ? error : undefined;
      return {
        ok: false,
        reason: protocolError?.code ?? 'mcp-request-failed',
        message: protocolError?.message ?? String(error),
      };
    }
    const result = response.result;
    if (typeof result !== 'object' || result === null) {
      return { ok: false, reason: 'mcp-response-invalid', message: 'tools/call 结果不是对象' };
    }
    return { ok: true, result: result as McpCallToolResult };
  }

  /** 关闭：未决请求全部失败，退订传输。幂等。 */
  async close(): Promise<void> {
    this.die('mcp-transport-closed', '会话已主动关闭');
  }

  /** 会话死亡：未决请求全部失败，退订传输，进入 closed。 */
  private die(reason: McpProtocolError['code'], message: string): void {
    for (const [key, entry] of [...this.pending]) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
      entry.reject(new McpProtocolError(reason, message));
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.state = 'closed';
  }

  private async request(method: string, params: unknown, timeoutMs?: number): Promise<McpJsonRpcResponse> {
    if (this.state === 'closed') throw new McpProtocolError('mcp-transport-closed', '会话已关闭');
    this.sequence += 1;
    const id = this.options.nextId ? this.options.nextId() : `${this.options.serverId}:${this.sequence}`;
    const frame = encodeMcpFrame({ jsonrpc: '2.0', id, method, params });
    const entry = new Promise<McpJsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new McpProtocolError('mcp-request-timeout', `${method} 请求超时`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(String(id), { resolve, reject, timer });
    });
    await this.options.transport.send(frame);
    return entry;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.options.transport.send(encodeMcpFrame({ jsonrpc: '2.0', method, params }));
  }

  private handleLine(line: string): void {
    const message = parseMcpFrame(line);
    if (!message) return;
    if (isMcpNotification(message)) {
      if (message.method === MCP_NOTIFICATION_TOOLS_LIST_CHANGED) {
        this.toolsStale = true;
        return;
      }
      this.options.onNotification?.(message.method, message.params);
      return;
    }
    if (!isMcpResponse(message)) return;
    const key = String(message.id);
    const entry = this.pending.get(key);
    if (!entry) return; // 迟到/未知响应：丢弃
    clearTimeout(entry.timer);
    this.pending.delete(key);
    if (message.error) {
      entry.reject(new McpProtocolError('mcp-request-failed', message.error.message, message.error));
      return;
    }
    entry.resolve(message);
  }
}
