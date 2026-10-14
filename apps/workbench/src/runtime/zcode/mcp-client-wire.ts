// 一个文件=一种作用：MCP 客户端的线格式契约（JSON-RPC 2.0 over 传输层）+ 协议版本协商常量。
//
// 契约来源：@modelcontextprotocol/core 2.0.0（MIT，ZCode 同款 SDK）。
// LATEST_PROTOCOL_VERSION = "2025-11-25"；与 MCP Apps 的 UI 协议版本
// （ext-apps "2026-01-26"）是两套独立版本，不可混用。
// 编解码为纯函数：传输层（P0-1b 原生 stdio/HTTP）只负责字节进出，不掺语义。

export const MCP_PROTOCOL_VERSION = '2025-11-25' as const;
/** 本客户端可协商的协议版本（新→旧）；服务器从自己支持的下限里挑一个回。 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const MCP_CLIENT_INFO = { name: 'ai-work-os-workbench', version: '0.19.0' } as const;

export type McpRequestId = number | string;

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version?: string };
  instructions?: string;
}

export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id: McpRequestId;
  method: string;
  params?: unknown;
}

export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: McpRequestId;
  result?: unknown;
  error?: McpJsonRpcError;
}

export interface McpJsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type McpWireMessage = McpJsonRpcRequest | McpJsonRpcResponse | McpJsonRpcNotification;

/** JSON-RPC 标准错误码；MCP 在 -32000..-32099 保留服务端自定义码。 */
export const MCP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function isMcpResponse(value: unknown): value is McpJsonRpcResponse {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') return false;
  if (typeof record.id !== 'number' && typeof record.id !== 'string') return false;
  if (typeof record.method === 'string') return false;
  return 'result' in record || 'error' in record;
}

export function isMcpNotification(value: unknown): value is McpJsonRpcNotification {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0' && typeof record.method === 'string' && !('id' in record);
}

/** 帧编解码：stdio 传输一行一帧（LF 结尾，与 ZCode zcodeStdioTransport 同构）。 */
export function encodeMcpFrame(message: McpWireMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** 解析一帧；非 JSON-RPC 2.0 或不可解析返回 undefined（调用方按噪声丢弃）。 */
export function parseMcpFrame(line: string): McpWireMessage | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') return undefined;
  if (typeof record.method === 'string' && !('id' in record)) return { jsonrpc: '2.0', method: record.method, params: record.params };
  if (isMcpResponse(parsed)) return parsed;
  if (typeof record.method === 'string' && (typeof record.id === 'number' || typeof record.id === 'string')) {
    return { jsonrpc: '2.0', id: record.id, method: record.method, params: record.params };
  }
  return undefined;
}

/** 双方版本取交集：服务器回传版本不在我方支持集时按 LATEST 记录并继续（不 fail）。 */
export function negotiateMcpProtocolVersion(serverVersion: string): string {
  return (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(serverVersion) ? serverVersion : MCP_PROTOCOL_VERSION;
}
