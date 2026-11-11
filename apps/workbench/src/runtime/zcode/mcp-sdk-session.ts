// 官方 SDK 的 `Client` → 本仓租约会话形状（`listTools` / `callTool` / `close`）。
//
// ## 为什么还要这一层
//
// SDK 的 `Client` 是通用协议客户端：`callTool({ name, arguments })` 抛异常表示协议失败、
// 返回 `{ isError }` 表示工具自身失败。本仓的 `mcp-pool-executor` 期待的是一个
// **不抛**的 `McpCallToolOutcome`（`ok` / `result` / `reason` / `message`）。
//
// 这层只做形状转换，不碰协议语义 —— 协议、分帧、请求关联、超时取消全交给 SDK。
//
// ## 超时
//
// SDK 的 `RequestOptions.signal` 支持真正的取消（`AbortSignal.timeout`），所以超时不是
// "假装失败、请求还在飞"，而是真的掐断。这比原先手写 session 里那个 `Promise.race` 更干净。

import { Client } from '@modelcontextprotocol/client';

import type { McpCallToolOutcome, McpCallToolResult, McpWireTransport } from './mcp-client-transport';
import { McpWireSdkTransport } from './mcp-sdk-transport';

/** 池租约暴露的会话能力。刻意窄：消费者不该拿到整个 SDK Client。 */
export interface McpLeaseSession {
  listTools(): Promise<readonly unknown[]>;
  callTool(toolName: string, args: unknown, options?: { readonly timeoutMs?: number }): Promise<McpCallToolOutcome>;
  close(): Promise<void>;
}

export interface SdkMcpSessionOptions {
  readonly serverId: string;
  readonly transport: McpWireTransport;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly requestTimeoutMs?: number;
}

/** 把一次调用失败归类成稳定原因码，便于上层做可读提示。 */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'mcp-request-timeout';
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return 'mcp-request-failed';
    if (typeof code === 'string' && code) return code;
    if (/closed|not connected/i.test(error.message)) return 'mcp-transport-closed';
  }
  return 'mcp-request-failed';
}

export class SdkMcpSession implements McpLeaseSession {
  private readonly client: Client;
  private readonly transport: McpWireSdkTransport;
  private closed = false;

  constructor(private readonly options: SdkMcpSessionOptions) {
    this.client = new Client(
      options.clientInfo ?? { name: 'b07-workbench', version: '0.0.0' },
      { capabilities: {} },
    );
    this.transport = new McpWireSdkTransport(options.transport);
  }

  async connect(): Promise<void> {
    // 握手也要有超时：服务器不应答时，`connect()` 会永久挂住，而调用方只会看到
    // "acquire 一直不返回" —— 没有错误、没有原因。配了 `requestTimeoutMs` 就掐断它。
    const timeoutMs = this.options.requestTimeoutMs;
    await this.client.connect(
      this.transport,
      timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) },
    );
  }

  async listTools(): Promise<readonly unknown[]> {
    const listed = await this.client.listTools();
    return listed.tools;
  }

  async callTool(toolName: string, args: unknown, options: { readonly timeoutMs?: number } = {}): Promise<McpCallToolOutcome> {
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    try {
      const result = await this.client.callTool(
        { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
        timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) },
      );
      return { ok: true, result: result as unknown as McpCallToolResult };
    } catch (error) {
      return {
        ok: false,
        reason: reasonOf(error),
        message: error instanceof Error ? error.message : String(error ?? '未知错误'),
      };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 先关协议（发 cancel / 结束会话），再关传输（杀进程）。
    await this.client.close().catch(() => undefined);
    await this.transport.close().catch(() => undefined);
  }
}
