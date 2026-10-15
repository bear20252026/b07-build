// 一个文件=一种作用：Gen UI 宿主桥分发器——把沙箱 iframe 发来的消息解析成
// `zcode/gen-ui/*` 调用，交给注入的处理器，并构造 JSON-RPC 应答（纯逻辑，无 DOM）。
//
// 复用 `@awo/protocol` 的 gen-ui host-bridge：方法白名单、封闭 params、大小上限、
// 载荷 schema 二次校验都在 parse 阶段完成；本文件只做「解析 → 分发 → 应答」的编排，
// 便于单测（注入假处理器即可覆盖成功/失败/违规三条路径）。

import {
  buildGenUiBridgeError,
  buildGenUiBridgeResponse,
  parseGenUiBridgeMessage,
  MCP_APP_BRIDGE_ERROR_CODES,
  type GenUiTweakMessage,
  type GenUiTweakResult,
  type GenUiWidgetState,
} from '@awo/protocol';

export interface GenUiBridgeHandlers {
  /** 页面请求持久化 Widget 状态。 */
  readonly onSetState: (state: GenUiWidgetState) => void | Promise<void>;
  /** 页面请求发起一次追问（把提示词送进当前会话）。 */
  readonly onFollowUp: (prompt: string, title: string | undefined) => void | Promise<void>;
  /** 页面登记/更新/注销 Tweak 绑定；返回应答（回显采纳的控件）。 */
  readonly onTweak: (message: GenUiTweakMessage) => GenUiTweakResult | Promise<GenUiTweakResult>;
  /** 展示事件（hover / escape），不增加 Agent 能力。 */
  readonly onPresentation?: (event: { hovered?: boolean; escape?: boolean }) => void;
  /** 准入策略违规回调（未知方法、超限、非法载荷），供审计记录。 */
  readonly onViolation?: (reason: string, detail: unknown) => void;
}

export type GenUiBridgeOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'response'; readonly message: Record<string, unknown> }
  | { readonly kind: 'violation'; readonly reason: string; readonly message?: Record<string, unknown> };

export interface GenUiBridgeHost {
  handle(raw: unknown): Promise<GenUiBridgeOutcome>;
}

export function createGenUiBridgeHost(handlers: GenUiBridgeHandlers): GenUiBridgeHost {
  return {
    async handle(raw: unknown): Promise<GenUiBridgeOutcome> {
      const incoming = parseGenUiBridgeMessage(raw);
      if (!incoming.ok) {
        // 非 JSON-RPC 噪声（其他监听器的消息、无关 postMessage）静默忽略。
        if (incoming.reason === 'gen-ui-bridge-not-jsonrpc') return { kind: 'ignored' };
        handlers.onViolation?.(incoming.reason, raw);
        if (incoming.id !== undefined && incoming.code !== undefined) {
          return { kind: 'violation', reason: incoming.reason, message: buildGenUiBridgeError(incoming.id, incoming.code, incoming.reason) };
        }
        return { kind: 'violation', reason: incoming.reason };
      }
      switch (incoming.kind) {
        case 'setState': {
          try {
            await handlers.onSetState(incoming.state);
            return { kind: 'response', message: buildGenUiBridgeResponse(incoming.id, {}) };
          } catch (error) {
            return { kind: 'response', message: buildGenUiBridgeError(incoming.id, MCP_APP_BRIDGE_ERROR_CODES.internalError, messageOf(error)) };
          }
        }
        case 'followUp': {
          try {
            await handlers.onFollowUp(incoming.prompt, incoming.title);
            return { kind: 'response', message: buildGenUiBridgeResponse(incoming.id, {}) };
          } catch (error) {
            return { kind: 'response', message: buildGenUiBridgeError(incoming.id, MCP_APP_BRIDGE_ERROR_CODES.internalError, messageOf(error)) };
          }
        }
        case 'tweak': {
          try {
            const result = await handlers.onTweak(incoming.message);
            return { kind: 'response', message: buildGenUiBridgeResponse(incoming.id, result) };
          } catch (error) {
            return { kind: 'response', message: buildGenUiBridgeError(incoming.id, MCP_APP_BRIDGE_ERROR_CODES.internalError, messageOf(error)) };
          }
        }
        case 'presentation': {
          handlers.onPresentation?.({ ...(incoming.hovered === undefined ? {} : { hovered: incoming.hovered }), ...(incoming.escape === undefined ? {} : { escape: incoming.escape }) });
          return { kind: 'response', message: buildGenUiBridgeResponse(incoming.id, {}) };
        }
      }
    },
  };
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
