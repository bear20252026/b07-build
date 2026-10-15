// 一个文件=一种作用：Gen UI 宿主桥——`zcode/gen-ui/*` 方法（guest → host 请求）与
// `zcode/gen-ui/context`（host → guest 上下文通知）的编解码，以及宿主上下文的投影。
//
// 复用（不另造隔离）：信封沿用本包 `mcp-app-bridge.ts` 的 JSON-RPC 2.0 与错误码；
// iframe 沙箱属性与 CSP 注入沿用 `mcp-app-admission.ts`（见 gen-ui/policy.ts）；静态域
// 白名单来自 `gen-ui/contract.ts` 的 `GEN_UI_STATIC_DOMAINS`。本文件只负责**方法分发契约**，
// 不含 DOM 与渲染。
//
// 与上游（ZCode plugin-sandbox/protocol.ts + renderer/plugin-sandbox/genUi.ts）的关系：
// 上游用官方 @modelcontextprotocol/ext-apps SDK 承载握手与上下文；b07 的 MCP 桥已是
// ext-apps 线格式的封闭镜像、且不引入该 SDK，故 Gen UI 的四个自定义方法在此单列一层，
// 与 MCP 方法共用同一 postMessage 通道与错误码，而不是塞进 MCP 方法白名单。

import { MCP_APP_BRIDGE_ERROR_CODES } from '../mcp-app-bridge.js';
import {
  GEN_UI_STATE_METHOD,
  GEN_UI_FOLLOW_UP_METHOD,
  GEN_UI_TWEAK_METHOD,
  GEN_UI_PRESENTATION_METHOD,
  parseGenUiWidgetState,
  parseGenUiFollowUp,
  type GenUiWidgetState,
} from './contract.js';
import { parseGenUiTweakMessage, type GenUiTweakMessage, type GenUiTweakAnnotation } from './tweak-protocol.js';

/** guest → host 允许的方法白名单（闭集；扩协议必须先扩这里并有测试）。 */
export const GEN_UI_BRIDGE_METHODS = [GEN_UI_STATE_METHOD, GEN_UI_FOLLOW_UP_METHOD, GEN_UI_TWEAK_METHOD, GEN_UI_PRESENTATION_METHOD] as const;
export type GenUiBridgeMethod = (typeof GEN_UI_BRIDGE_METHODS)[number];

/** host → guest 的上下文通知方法（承载 widgetState/theme/tweak 标注）。 */
export const GEN_UI_CONTEXT_NOTIFICATION = 'zcode/gen-ui/context';

/** 单条 Gen UI 消息的序列化字符上限：比 MCP 桥宽（follow-up 载荷可达 64KiB）。 */
export const GEN_UI_BRIDGE_MAX_MESSAGE_CHARS = 128 * 1024;

export type GenUiBridgeId = string | number;

export type GenUiBridgeIncoming =
  | { readonly ok: true; readonly kind: 'setState'; readonly id: GenUiBridgeId; readonly state: GenUiWidgetState }
  | { readonly ok: true; readonly kind: 'followUp'; readonly id: GenUiBridgeId; readonly prompt: string; readonly title?: string }
  | { readonly ok: true; readonly kind: 'tweak'; readonly id: GenUiBridgeId; readonly message: GenUiTweakMessage }
  | { readonly ok: true; readonly kind: 'presentation'; readonly id: GenUiBridgeId; readonly hovered?: boolean; readonly escape?: boolean }
  | { readonly ok: false; readonly reason: string; readonly code?: number; readonly id?: GenUiBridgeId };

const MAX_ID_CHARS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(params: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(params).every((key) => allowed.includes(key));
}

function serializedLength(raw: unknown): number | undefined {
  try {
    return JSON.stringify(raw).length;
  } catch {
    return undefined;
  }
}

function readId(value: unknown): GenUiBridgeId | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS) return value;
  return undefined;
}

/**
 * 解析 guest → host 的 Gen UI 请求（与 MCP 桥同一纪律：白名单方法、封闭 params、
 * 大小上限、载荷 schema 二次校验）。拒绝结果带 JSON-RPC 错误码与（可提取的）id，
 * 宿主据此回 error 而不是静默丢弃。
 */
export function parseGenUiBridgeMessage(raw: unknown): GenUiBridgeIncoming {
  if (!isPlainObject(raw) || raw.jsonrpc !== '2.0') return { ok: false, reason: 'gen-ui-bridge-not-jsonrpc' };
  const size = serializedLength(raw);
  if (size === undefined) return { ok: false, reason: 'gen-ui-message-unserializable' };
  if (size > GEN_UI_BRIDGE_MAX_MESSAGE_CHARS) return { ok: false, reason: 'gen-ui-message-too-large' };

  const method = raw.method;
  const id = readId(raw.id);
  if (typeof method !== 'string' || !(GEN_UI_BRIDGE_METHODS as readonly string[]).includes(method)) {
    return { ok: false, reason: 'gen-ui-bridge-method-forbidden', code: MCP_APP_BRIDGE_ERROR_CODES.methodNotFound, id };
  }
  // 四个方法都是请求，必须带 id。
  if (id === undefined) return { ok: false, reason: 'gen-ui-bridge-missing-id', code: MCP_APP_BRIDGE_ERROR_CODES.invalidRequest };
  const params = raw.params === undefined ? {} : raw.params;
  if (!isPlainObject(params)) return { ok: false, reason: 'gen-ui-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };

  switch (method) {
    case GEN_UI_STATE_METHOD: {
      if (!rejectUnknownKeys(params, ['state'])) return { ok: false, reason: 'gen-ui-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      const state = parseGenUiWidgetState(params.state);
      if (!state.ok) return { ok: false, reason: state.reason, code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      return { ok: true, kind: 'setState', id, state: state.value };
    }
    case GEN_UI_FOLLOW_UP_METHOD: {
      if (!rejectUnknownKeys(params, ['prompt', 'title'])) return { ok: false, reason: 'gen-ui-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      const followUp = parseGenUiFollowUp(params);
      if (!followUp.ok) return { ok: false, reason: followUp.reason, code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      return { ok: true, kind: 'followUp', id, prompt: followUp.value.prompt, ...(followUp.value.title === undefined ? {} : { title: followUp.value.title }) };
    }
    case GEN_UI_TWEAK_METHOD: {
      if (!rejectUnknownKeys(params, ['type', 'registrationId', 'annotationControls', 'targets', 'targetId'])) {
        return { ok: false, reason: 'gen-ui-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      }
      const message = parseGenUiTweakMessage(params);
      if (!message.ok) return { ok: false, reason: message.reason, code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      return { ok: true, kind: 'tweak', id, message: message.value };
    }
    case GEN_UI_PRESENTATION_METHOD: {
      if (!rejectUnknownKeys(params, ['hovered', 'escape'])) return { ok: false, reason: 'gen-ui-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      if (params.hovered !== undefined && typeof params.hovered !== 'boolean') return { ok: false, reason: 'gen-ui-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      if (params.escape !== undefined && params.escape !== true) return { ok: false, reason: 'gen-ui-bridge-params-invalid', code: MCP_APP_BRIDGE_ERROR_CODES.invalidParams, id };
      return { ok: true, kind: 'presentation', id, ...(params.hovered === undefined ? {} : { hovered: params.hovered }), ...(params.escape === undefined ? {} : { escape: true }) };
    }
    default:
      return { ok: false, reason: 'gen-ui-bridge-method-forbidden', code: MCP_APP_BRIDGE_ERROR_CODES.methodNotFound, id };
  }
}

/** 宿主 → guest 的 JSON-RPC 应答（成功）。 */
export function buildGenUiBridgeResponse(id: GenUiBridgeId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** 宿主 → guest 的 JSON-RPC 错误应答。 */
export function buildGenUiBridgeError(id: GenUiBridgeId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** 宿主上下文输入：状态 / 主题 / Tweak 标注（b07 子集，不携带能力）。 */
export interface GenUiHostContextInput {
  readonly state: GenUiWidgetState | null;
  readonly theme?: 'light' | 'dark';
  readonly annotation?: GenUiTweakAnnotation | null;
}

/** guest 的 `zcode:set_globals` 事件 detail 的 `globals` 字段（对齐上游全局对象形状）。 */
export interface GenUiGlobals {
  readonly widgetState: GenUiWidgetState | null;
  readonly theme?: 'light' | 'dark';
  readonly visualizationAnnotation: GenUiTweakAnnotation | null;
}

/**
 * 把宿主上下文投影为 guest 全局对象：只暴露呈现所需字段，不增加 Agent 能力。
 * 非法状态/标注按 null 处理（guest 侧不做二次校验，投影必须是可信的最后一跳）。
 */
export function projectGenUiGlobals(input: GenUiHostContextInput): GenUiGlobals {
  const state = input.state === null ? null : parseGenUiWidgetState(input.state);
  return {
    widgetState: state !== null && state.ok ? state.value : null,
    ...(input.theme === undefined ? {} : { theme: input.theme }),
    visualizationAnnotation: input.annotation ?? null,
  };
}

/** host → guest 的上下文通知信封（params = globals）。 */
export function buildGenUiContextNotification(globals: GenUiGlobals): Record<string, unknown> {
  return { jsonrpc: '2.0', method: GEN_UI_CONTEXT_NOTIFICATION, params: globals };
}
