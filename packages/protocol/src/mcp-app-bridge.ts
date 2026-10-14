// 一个文件=一种作用：MCP Apps 官方 postMessage 桥（ext-apps JSON-RPC）的编解码与准入。
//
// 背景（R1 审计 R4-02）：此前宿主与沙箱 iframe 之间走 b07 自研的
// {type:'toolCallRequest'} 信封，真实 MCP 应用（用官方 @modelcontextprotocol/
// ext-apps SDK 构建）不说这个协议，宿主对他们不可用。本模块把线格式换成官方
// ext-apps 协议的最小子集——JSON-RPC 2.0 over postMessage：
//
//   应用 → 宿主：ui/initialize（握手）→ ui/notifications/initialized
//               → ping / tools/call / ui/notifications/size-changed
//   宿主 → 应用：对上述请求回 JSON-RPC result / error
//
// 契约以官方 SDK v2.0.0（MIT，github.com/modelcontextprotocol/ext-apps）为准，
// 本文件是其线格式的封闭镜像：运行时零第三方依赖，方法白名单之外一律拒绝
// （fail-closed，与协议包其余部分同一哲学），后续批次按需扩白名单。
// params 刻意比 SDK 更严：SDK 用 passthrough 保前向兼容，宿主是安全边界，
// 未声明字段在本包一律拒绝；白名单内的握手载荷（appCapabilities）按记录透传，
// 因为宿主不依据它做任何决策。

import { MCP_APP_MAX_MESSAGE_CHARS, type McpAppAdmission } from './mcp-app-admission.js';

/** 官方 LATEST_PROTOCOL_VERSION：握手协商的兜底版本（SDK v2.0.0 spec.types）。 */
export const MCP_APP_BRIDGE_PROTOCOL_VERSION = '2026-01-26';
/** 宿主支持的协议版本列表：协商时应用版本命中即沿用，否则回落到 LATEST。 */
export const MCP_APP_BRIDGE_SUPPORTED_PROTOCOL_VERSIONS = ['2026-01-26'] as const;

/** 应用 → 宿主允许的方法白名单（闭集；扩协议必须先扩这里并有测试）。 */
export const MCP_APP_BRIDGE_METHODS = [
  'ui/initialize',
  'ui/notifications/initialized',
  'ui/notifications/size-changed',
  'ping',
  'tools/call',
] as const;
export type McpAppBridgeMethod = (typeof MCP_APP_BRIDGE_METHODS)[number];

/** 白名单里的通知（无 id、宿主不应答）。 */
const NOTIFICATION_METHODS = new Set<string>(['ui/notifications/initialized', 'ui/notifications/size-changed']);

/** JSON-RPC 2.0 标准错误码（宿主拒绝时按原因选用）。 */
export const MCP_APP_BRIDGE_ERROR_CODES = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** MCP Implementation（SDK/core 同形）：name+version 必填，title 可选。 */
export interface McpAppBridgeImplementation {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}

/** 宿主张告的 capabilities（McpUiHostCapabilities 的 b07 子集；只声明真实支持的）。 */
export interface McpAppBridgeHostCapabilities {
  /** 宿主可代应用调用其所属 MCP 服务器的工具（tools/call 代理）。 */
  readonly serverTools?: { readonly listChanged?: boolean };
}

/** 握手时下发给应用的宿主上下文（McpUiHostContext 的 b07 子集）。 */
export interface McpAppBridgeHostContext {
  readonly theme?: 'light' | 'dark';
  readonly platform?: 'web' | 'desktop' | 'mobile';
  readonly displayMode?: 'inline' | 'fullscreen' | 'pip';
  readonly locale?: string;
  readonly timeZone?: string;
}

/** 页面注入给宿主组件的宿主身份描述；缺省字段在 buildMcpAppInitializeResult 补齐。 */
export interface McpAppBridgeHostDescriptor {
  readonly hostInfo: McpAppBridgeImplementation;
  readonly hostCapabilities?: McpAppBridgeHostCapabilities;
  readonly hostContext?: McpAppBridgeHostContext;
}

/** JSON-RPC id：请求应答的关联键（字符串或数字；null 视为缺失）。 */
export type McpAppBridgeId = string | number;

/** MCP CallToolResult：宿主把执行结果包装成内容块返回给应用。 */
export interface McpAppBridgeCallToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string; readonly [key: string]: unknown }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export type McpAppBridgeIncoming =
  | { readonly ok: true; readonly kind: 'initialize'; readonly id: McpAppBridgeId; readonly appInfo: McpAppBridgeImplementation; readonly appCapabilities: Record<string, unknown>; readonly protocolVersion: string }
  | { readonly ok: true; readonly kind: 'initialized' }
  | { readonly ok: true; readonly kind: 'sizeChanged'; readonly width?: number; readonly height?: number }
  | { readonly ok: true; readonly kind: 'ping'; readonly id: McpAppBridgeId }
  | { readonly ok: true; readonly kind: 'toolCall'; readonly id: McpAppBridgeId; readonly toolName: string; readonly args: unknown }
  | {
      /** 拒绝时携带 JSON-RPC 错误码（若该回 error）；无 code = 宿主静默忽略（非 JSON-RPC 噪声）。 */
      readonly ok: false;
      readonly reason: string;
      readonly code?: number;
      readonly id?: McpAppBridgeId;
    };

const MAX_ID_CHARS = 64;
const MAX_NAME_CHARS = 128;
const MAX_VERSION_CHARS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** 封闭 params 校验：只允许声明过的键（与协议包其余部分同一纪律）。 */
function rejectUnknownKeys(params: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(params).every((key) => allowed.includes(key));
}

/** 序列化长度上限：结构化克隆允许循环引用，JSON.stringify 可能抛——必须在受控边界内（R1 审计 R4 教训）。 */
function serializedLength(raw: unknown): number | undefined {
  try {
    return JSON.stringify(raw).length;
  } catch {
    return undefined;
  }
}

function parseImplementation(value: unknown): McpAppBridgeImplementation | undefined {
  if (!isPlainObject(value)) return undefined;
  const { name, version, title } = value;
  if (!nonEmptyString(name, MAX_NAME_CHARS) || !nonEmptyString(version, MAX_VERSION_CHARS)) return undefined;
  if (title !== undefined && !nonEmptyString(title, MAX_NAME_CHARS)) return undefined;
  if (!rejectUnknownKeys(value, ['name', 'version', 'title'])) return undefined;
  return title === undefined ? { name, version } : { name, version, title };
}

/**
 * 解析应用 → 宿主的 postMessage 载荷（官方 ext-apps 线格式）。
 *
 * 与已删除的 gateMcpAppMessage 同一职责、同一纪律：白名单方法、封闭 params、
 * 大小上限、工具二次准入。区别在信封：官方 JSON-RPC，且拒绝结果带上错误码
 * 与（可提取的）请求 id，宿主可据此回 error 而不是静默丢弃——真实 SDK 应用
 * 依靠应答感知失败。
 */
export function parseMcpAppBridgeMessage(
  raw: unknown,
  admission: Pick<McpAppAdmission, 'admittedToolNames'>,
): McpAppBridgeIncoming {
  if (!isPlainObject(raw)) return { ok: false, reason: 'mcpapp-bridge-not-jsonrpc' };
  if (raw.jsonrpc !== '2.0') return { ok: false, reason: 'mcpapp-bridge-not-jsonrpc' };
  const size = serializedLength(raw);
  if (size === undefined) return { ok: false, reason: 'mcpapp-message-unserializable' };
  if (size > MCP_APP_MAX_MESSAGE_CHARS) return { ok: false, reason: 'mcpapp-message-too-large' };

  const method = raw.method;
  if (typeof method !== 'string' || !(MCP_APP_BRIDGE_METHODS as readonly string[]).includes(method)) {
    return { ok: false, reason: 'mcpapp-bridge-method-forbidden', code: MCP_APP_BRIDGE_ERROR_CODES.methodNotFound, id: readId(raw.id) };
  }

  const isNotification = NOTIFICATION_METHODS.has(method);
  const id = readId(raw.id);
  if (isNotification) {
    if (raw.id !== undefined) return { ok: false, reason: 'mcpapp-bridge-notification-with-id', code: MCP_APP_BRIDGE_ERROR_CODES.invalidRequest };
  } else if (id === undefined) {
    return { ok: false, reason: 'mcpapp-bridge-missing-id', code: MCP_APP_BRIDGE_ERROR_CODES.invalidRequest };
  }
  const params = raw.params === undefined ? {} : raw.params;
  if (!isPlainObject(params)) {
    return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
  }

  switch (method) {
    case 'ui/initialize': {
      if (!rejectUnknownKeys(params, ['appInfo', 'appCapabilities', 'protocolVersion'])) {
        return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      const appInfo = parseImplementation(params.appInfo);
      const protocolVersion = params.protocolVersion;
      if (!appInfo || !nonEmptyString(protocolVersion, MAX_VERSION_CHARS) || !isPlainObject(params.appCapabilities)) {
        return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      return { ok: true, kind: 'initialize', id: id as McpAppBridgeId, appInfo, appCapabilities: params.appCapabilities, protocolVersion };
    }
    case 'ui/notifications/initialized':
      return { ok: true, kind: 'initialized' };
    case 'ui/notifications/size-changed': {
      if (!rejectUnknownKeys(params, ['width', 'height'])) {
        return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams };
      }
      const { width, height } = params;
      if (width !== undefined && typeof width !== 'number') return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams };
      if (height !== undefined && typeof height !== 'number') return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams };
      return { ok: true, kind: 'sizeChanged', ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
    }
    case 'ping':
      // MCP 规范：ping 无参数；封闭纪律下 params 必须缺省或为空对象。
      if (raw.params !== undefined && Object.keys(params).length > 0) {
        return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      return { ok: true, kind: 'ping', id: id as McpAppBridgeId };
    case 'tools/call': {
      if (!rejectUnknownKeys(params, ['name', 'arguments', '_meta'])) {
        return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      const toolName = params.name;
      if (!nonEmptyString(toolName, MAX_NAME_CHARS)) {
        return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      // 工具二次准入：消息里声明的工具必须在白名单内（渲染层伪造未注册调用在此被拦下）。
      if (!admission.admittedToolNames.includes(toolName)) {
        return { ok: false, reason: 'mcpapp-tool-not-admitted', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
        return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      if (params._meta !== undefined && !isPlainObject(params._meta)) {
        return { ok: false, reason: 'mcpapp-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      return { ok: true, kind: 'toolCall', id: id as McpAppBridgeId, toolName, args: params.arguments ?? {} };
    }
    default:
      return { ok: false, reason: 'mcpapp-bridge-method-forbidden', code: MCP_APP_BRIDGE_ERROR_CODES.methodNotFound, id };
  }
}

function readId(value: unknown): McpAppBridgeId | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS) return value;
  return undefined;
}

/** 协议版本协商：应用版本命中支持列表即沿用，否则回落到 LATEST（与 SDK 同一策略）。 */
export function negotiateMcpAppProtocolVersion(appVersion: string): string {
  return (MCP_APP_BRIDGE_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(appVersion)
    ? appVersion
    : MCP_APP_BRIDGE_PROTOCOL_VERSION;
}

/** ui/initialize 的结果载荷（McpUiInitializeResult 的 b07 子集）。 */
export function buildMcpAppInitializeResult(
  descriptor: McpAppBridgeHostDescriptor,
  protocolVersion: string,
): Record<string, unknown> {
  return {
    protocolVersion,
    hostInfo: descriptor.hostInfo,
    hostCapabilities: descriptor.hostCapabilities ?? { serverTools: {} },
    hostContext: descriptor.hostContext ?? { platform: 'desktop' },
  };
}

/** 宿主 → 应用的 JSON-RPC 应答。 */
export function buildMcpAppBridgeResponse(id: McpAppBridgeId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** 宿主 → 应用的 JSON-RPC 错误应答。 */
export function buildMcpAppBridgeError(id: McpAppBridgeId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** 宿主 → 应用的通知（当前批次无发送方；为 host-context-changed 等预留）。 */
export function buildMcpAppBridgeNotification(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
}

/**
 * 把执行器结果包装成官方 CallToolResult。
 *
 * 已经是 {content: [...]} 形状的按原样通过（MCP 服务器原生返回）；其余值包成
 * 单个 text 内容块——工具失败不是协议错误，以 isError: true 的 result 回给应用，
 * 这与 SDK 宿主行为一致（错误码保留给协议/授权层）。
 */
export function mapToolResultToCallToolResult(result: unknown): McpAppBridgeCallToolResult {
  if (isPlainObject(result) && Array.isArray(result.content)) {
    const isError = result.isError;
    return isError === true ? { content: result.content, isError: true } : { content: result.content };
  }
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result) ?? String(result);
  } catch {
    text = String(result);
  }
  return { content: [{ type: 'text', text: text.slice(0, MCP_APP_MAX_MESSAGE_CHARS) }] };
}