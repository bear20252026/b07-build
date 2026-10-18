// 一个文件=一种作用：MCP 客户端传输抽象与调用结果类型。
//
// 传输只负责一行一帧地进出；会话语义（握手/关联/超时/分帧）已交给官方 SDK
// （见 `mcp-sdk-session.ts`），这里只保留**传输接缝**与调用结果形状。
// 真实 stdio 传输由原生侧提供（`mcp-stdio-transport.ts`），测试用内存传输注入。

/** JSON-RPC 错误体（协议层返回的错误，区别于工具自身的 `isError`）。 */
export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpWireTransportHandlers {
  onLine(line: string): void;
  /** 传输层断开；会话据此让全部未决请求失败，不再放行任何调用。 */
  onClose?(reason?: string): void;
}

export interface McpWireTransport {
  /** 发送一帧（不含换行；实现方负责补 LF 或 HTTP 体）。 */
  send(payload: string): Promise<void>;
  close(): Promise<void>;
  /** 订阅入站帧与断开；返回取消订阅函数。 */
  subscribe(handlers: McpWireTransportHandlers): () => void;
}

/** 协议/传输级失败（握手失败、请求超时、会话已关、入站帧非法）。 */
export class McpProtocolError extends Error {
  constructor(
    readonly code:
      | 'mcp-transport-closed'
      | 'mcp-session-not-ready'
      | 'mcp-already-connected'
      | 'mcp-handshake-failed'
      | 'mcp-request-timeout'
      | 'mcp-request-failed'
      | 'mcp-response-invalid'
      | 'mcp-invalid-frame'
      | 'mcp-tool-not-found',
    message: string,
    readonly rpcError?: McpJsonRpcError,
  ) {
    super(message);
  }
}

/** MCP tools/call 的业务结果：isError 表达工具自身失败，不是协议错误。 */
export interface McpCallToolResult {
  content?: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpCallToolOutcome {
  ok: boolean;
  /** 协议层成功时携带服务端原始 CallToolResult（含 isError）。 */
  result?: McpCallToolResult;
  /** 协议层失败时的原因码与消息。 */
  reason?: string;
  message?: string;
}

/** 测试/本地回环传输：成对互联，一侧 send 即另一侧 onLine。 */
export class McpLoopbackTransport implements McpWireTransport {
  private peer: McpLoopbackTransport | undefined;
  private readonly handlers = new Set<McpWireTransportHandlers>();
  private closed = false;

  static pair(): [McpLoopbackTransport, McpLoopbackTransport] {
    const left = new McpLoopbackTransport();
    const right = new McpLoopbackTransport();
    left.peer = right;
    right.peer = left;
    return [left, right];
  }

  async send(payload: string): Promise<void> {
    if (this.closed) throw new McpProtocolError('mcp-transport-closed', '传输已关闭');
    this.peer?.receive(payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.handlers]) handler.onClose?.('loopback-closed');
    this.handlers.clear();
    this.peer?.receiveClose();
  }

  subscribe(handlers: McpWireTransportHandlers): () => void {
    this.handlers.add(handlers);
    return () => this.handlers.delete(handlers);
  }

  private receive(payload: string): void {
    if (this.closed) return;
    for (const handler of [...this.handlers]) handler.onLine(payload);
  }

  private receiveClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.handlers]) handler.onClose?.('peer-closed');
    this.handlers.clear();
  }
}
