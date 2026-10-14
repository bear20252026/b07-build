// 一个文件=一种作用：MCP stdio 传输的 Tauri 实现（McpWireTransport 的落地）。
//
// 进程 spawn/监督全在原生侧（crates/process-supervisor 规格校验 +
// desktop-shell mcp_process 命令面）；这里只做三件事：start（mcp_start_process）、
// 订阅行/退出事件（stdout 行进会话，stderr 行是诊断不进会话）、send（写 stdin
// 帧）、close（半关 + 杀进程树，由原生侧收尾）。依赖项可注入以便测试。

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { McpProtocolError, type McpWireTransport, type McpWireTransportHandlers } from './mcp-client-transport';

export const MCP_STDIO_LINE_EVENT = 'mcp-process-line';
export const MCP_STDIO_EXIT_EVENT = 'mcp-process-exit';

export interface McpStdioTransportDeps {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<UnlistenFn>;
}

const defaultDeps: McpStdioTransportDeps = {
  invoke: (command, args) => invoke(command, args),
  listen: (event, handler) => listen(event, handler),
};

function nativeRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export interface McpStdioTransportOptions {
  readonly runId: string;
  /** MCP 服务器可执行文件：PATH 命令名或绝对路径。 */
  readonly executable: string;
  readonly args?: readonly string[];
  readonly env?: readonly (readonly [string, string])[];
  readonly workingDirectory?: string;
  readonly deps?: McpStdioTransportDeps;
}

interface McpStdioLinePayload {
  runId?: unknown;
  stream?: unknown;
  text?: unknown;
}

interface McpStdioExitPayload {
  runId?: unknown;
}

/** stdio 传输：start() 之后才能 subscribe/send；close() 幂等。 */
export class McpStdioTransport implements McpWireTransport {
  private readonly deps: McpStdioTransportDeps;
  private started = false;
  private closed = false;
  private unlisteners: UnlistenFn[] = [];

  constructor(private readonly options: McpStdioTransportOptions) {
    this.deps = options.deps ?? defaultDeps;
  }

  async start(): Promise<void> {
    if (this.closed) throw new McpProtocolError('mcp-transport-closed', '传输已关闭');
    if (this.started) return;
    if (!nativeRuntime() && this.options.deps === undefined) {
      throw new McpProtocolError('mcp-transport-closed', 'mcp-stdio-native-unavailable');
    }
    await this.deps.invoke('mcp_start_process', {
      request: {
        runId: this.options.runId,
        executable: this.options.executable,
        args: this.options.args ?? [],
        env: this.options.env ?? [],
        workingDirectory: this.options.workingDirectory ?? null,
      },
    });
    this.started = true;
  }

  async send(payload: string): Promise<void> {
    if (!this.started || this.closed) {
      throw new McpProtocolError('mcp-transport-closed', '传输未启动或已关闭');
    }
    // 帧由会话机编码（自带 \n）；这里原样透传，原生侧 normalize_frame 兜底校验。
    await this.deps.invoke('mcp_write_stdin', { request: { runId: this.options.runId, line: payload } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const unlisten of this.unlisteners.splice(0)) unlisten();
    if (!this.started) return;
    // 原生侧幂等：run 不存在时按已退出处理，不抛。
    await this.deps.invoke('mcp_stop_process', { request: { runId: this.options.runId } }).catch(() => undefined);
  }

  subscribe(handlers: McpWireTransportHandlers): () => void {
    if (this.closed) return () => undefined;
    let cancelled = false;
    void (async () => {
      this.unlisteners.push(await this.deps.listen(MCP_STDIO_LINE_EVENT, (event) => {
        if (cancelled || this.closed) return;
        const payload = event.payload as McpStdioLinePayload | null;
        if (!payload || payload.runId !== this.options.runId) return;
        // 只有 stdout 是协议帧流；stderr 是服务器诊断日志，不进会话。
        if (payload.stream !== 'stdout' || typeof payload.text !== 'string') return;
        handlers.onLine(payload.text);
      }));
      this.unlisteners.push(await this.deps.listen(MCP_STDIO_EXIT_EVENT, (event) => {
        if (cancelled || this.closed) return;
        const payload = event.payload as McpStdioExitPayload | null;
        if (!payload || payload.runId !== this.options.runId) return;
        this.closed = true;
        handlers.onClose?.('mcp-process-exit');
      }));
    })();
    return () => {
      cancelled = true;
      for (const unlisten of this.unlisteners.splice(0)) unlisten();
    };
  }
}
