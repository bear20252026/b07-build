// 把本仓已有的 `McpWireTransport`（按行收发）适配成官方 SDK 的 `Transport`。
//
// ## 为什么是适配，不是重写
//
// `McpStdioTransport` 已经把最危险的那段做完了：spawn 走原生 `mcp_start_process`、
// stdout 行进会话、stderr 行进诊断、close 杀进程树。这部分**不该动**。
//
// 而 JSON-RPC 的分帧、请求关联、超时、协议版本协商、工具列表分页 —— 这些是官方 SDK
// 的职责。本仓原先自己写了 460 行（`mcp-client-wire` + `mcp-client-session` +
// `mcp-tool-descriptor`），等于替官方实现打补丁。
//
// 这个文件就是两者的接缝：SDK 认为自己在跟一个 Transport 说话，实际下面是我们
// 已经验证过的 Tauri 通道。
//
// ## 一处刻意的严格
//
// 入站帧解析失败**不静默丢弃**：转成 `onerror`。静默丢弃会让 SDK 那边表现为
// "请求超时"，而真实原因是一个坏帧 —— 排查方向会完全错。

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';

import type { McpWireTransport } from './mcp-client-transport';

/** 把按行收发的 `McpWireTransport` 适配成 SDK 的 `Transport`。 */
export class McpWireSdkTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** stdio 传输没有 HTTP 会话概念，恒为 `undefined`（字段存在是为了满足接口）。 */
  sessionId?: string;

  private unsubscribe?: () => void;
  private started = false;

  constructor(private readonly wire: McpWireTransport) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.wire.subscribe({
      onLine: (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          this.onerror?.(new Error(`MCP 入站帧不是合法 JSON：${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (!parsed || typeof parsed !== 'object') {
          this.onerror?.(new Error('MCP 入站帧不是对象'));
          return;
        }
        this.onmessage?.(parsed as JSONRPCMessage);
      },
      onClose: (reason) => {
        // 先解绑，避免 close() 与 onClose 互相触发。
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        if (reason) this.onerror?.(new Error(`MCP 传输断开：${reason}`));
        this.onclose?.();
      },
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // stdio 是「一行一帧」，换行由传输层补；这里不能带换行。
    await this.wire.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.wire.close();
  }
}
