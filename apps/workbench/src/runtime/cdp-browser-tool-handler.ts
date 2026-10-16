// 一个文件=一种作用：CDP 真实后端的 `BrowserToolHandler` 实现（注入到占位包的缝）。
//
// ## 为什么本文件在 workbench 而不在 capability-placeholder
//
// `capability-placeholder` 是**纯契约包**（只依赖 `@awo/protocol`，不做任何 IO）；
// 而真实后端要经 Tauri IPC 走到 Rust 侧的原生连接。把 IO 放进契约包会让一个
// 「照着类型写代码」的包被迫带上前端框架依赖，也会让契约与实现的分界消失。
//
// 因此本文件是**薄适配器**：只做三件事——
//   1. 把 `BrowserToolCall` 翻译成 `browser_tool_call` 命令的入参；
//   2. 校验 Rust 侧回来的形状（不信任 IPC 对端）；
//   3. 把结果还原成 `BrowserToolCallResult`。
// 协议判定（帧、端点白名单、工具映射、会话状态机）**一行都不在这里**——
// 那些全部在 `crates/cdp-client` / `crates/cdp-transport` 且已被单测钉死。
//
// ## fail-closed 纪律
//
// 任何一步不明确都以失败收尾，且带**稳定错误码**。特别是：Rust 侧返回的形状
// 不对时不上抛"未知错误"，而是给出 `browser_tool_response_invalid`——
// 让外部能区分"后端说不可用"与"我们和后端对不上话"。
//
// ## 开关语义
//
// 本 handler 的存在**不等于**工具面可用：后端默认关闭，`createCdpBrowserToolHandler`
// 返回的 handler 在关闭状态下对任何调用都回 `browser_tool_backend_unavailable`。
// 这保持了占位包原有的不变式——「不可用」是默认，而不是异常分支。

import { invoke } from '@tauri-apps/api/core';

import type {
  BrowserToolCall,
  BrowserToolCallResult,
  BrowserToolHandler,
} from '@awo/capability-placeholder/browser-handlers';
// 该码的**唯一定义**在契约包里。这里必须引用而不是抄一份字面量——
// 抄一份意味着两处可以各自漂移，且漂移是静默的（两边都能编译过）。
import { BROWSER_TOOL_NOT_REGISTERED_CODE } from '@awo/capability-placeholder/browser-handlers';

/**
 * 取本次调用要用的 `invoke`。
 *
 * 测试环境（Node，无 Tauri）下 `@tauri-apps/api/core` 的 `invoke` 会因为
 * `window.__TAURI_INTERNALS__` 不存在而抛错，无法用它来验证**形状校验**这段
 * 唯一属于本层的逻辑。因此这里放一个注入点：测试往 `globalThis` 上装一个假
 * 实现即可。生产环境该钩子不存在，走的永远是真实的 `invoke`。
 *
 * 这不是"为测试让步的设计"——形状校验是安全相关的（不信任 IPC 对端），
 * 没有可注入点就只能靠真实 Tauri 进程做端到端测试，而那会让这条纪律
 * 在 CI 里**从不生效**。
 */
type InvokeLike = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const INVOKE_MOCK_KEY = '__awoCdpInvokeMock';

function currentInvoke(): InvokeLike {
  const candidate = (globalThis as Record<string, unknown>)[INVOKE_MOCK_KEY];
  if (typeof candidate === 'function') return candidate as InvokeLike;
  return invoke as unknown as InvokeLike;
}

/** 与 Rust 侧 `browser_tool_backend_unavailable` 逐字相同的稳定码。 */
export const BROWSER_TOOL_BACKEND_UNAVAILABLE_CODE = 'browser_tool_backend_unavailable' as const;

/** Rust 侧返回的形状不对（IPC 对端不可信）时的稳定码。 */
export const BROWSER_TOOL_RESPONSE_INVALID_CODE = 'browser_tool_response_invalid' as const;

/** 原生后端状态（与 Rust 侧 `BrowserBackendStatus` 同形）。 */
export interface BrowserBackendStatus {
  readonly enabled: boolean;
  readonly debuggerPort: number;
  readonly sessionCount: number;
}

/** 一个内容块。 */
interface BrowserToolContent {
  readonly type: 'text';
  readonly text: string;
}

/** 原生返回的原始结果形状（待校验）。 */
interface RawBrowserToolCallResult {
  readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[];
  readonly isError?: unknown;
  readonly errorCode?: unknown;
}

/**
 * 把未知形状的返回值校验成 `BrowserToolCallResult`。
 *
 * **不信任 IPC 对端**：Rust 侧是我们自己写的，但形状校验仍是必要的——
 * 一次重构把字段名改掉、或某个 `serde(rename_all)` 漏掉一个字段，
 * 都会让错误静默传播成"工具调用成功了但内容是 undefined"。
 */
function toToolCallResult(value: unknown): BrowserToolCallResult {
  if (!value || typeof value !== 'object') {
    return {
      content: [{ type: 'text', text: '浏览器后端返回了非对象结果。' }],
      isError: true,
      errorCode: BROWSER_TOOL_RESPONSE_INVALID_CODE,
    };
  }
  const raw = value as RawBrowserToolCallResult;
  if (!Array.isArray(raw.content) || typeof raw.isError !== 'boolean') {
    return {
      content: [{ type: 'text', text: '浏览器后端返回的结果缺少 content / isError 字段。' }],
      isError: true,
      errorCode: BROWSER_TOOL_RESPONSE_INVALID_CODE,
    };
  }
  const content: BrowserToolContent[] = [];
  for (const block of raw.content) {
    if (!block || typeof block !== 'object') continue;
    // 只接受文本块。Rust 侧目前只会发文本；出现别的类型说明双方对不上，
    // 此时**跳过**而不是编造一个 —— 编造会让上层拿到它没要过的内容。
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    content.push({ type: 'text', text: block.text });
  }
  if (content.length === 0) {
    return {
      content: [{ type: 'text', text: '浏览器后端返回的结果没有任何可读内容块。' }],
      isError: true,
      errorCode: BROWSER_TOOL_RESPONSE_INVALID_CODE,
    };
  }
  const errorCode = typeof raw.errorCode === 'string' && raw.errorCode ? raw.errorCode : undefined;
  // 出错却没有错误码：补一个稳定码，而不是留空——留空会让外部无从归因。
  return raw.isError
    ? {
        content,
        isError: true,
        errorCode: errorCode ?? BROWSER_TOOL_RESPONSE_INVALID_CODE,
      }
    : { content, isError: false };
}

/** 查询原生后端状态。IPC 失败时按"未启用"处理（fail-closed）。 */
export async function readBrowserBackendStatus(): Promise<BrowserBackendStatus> {
  try {
    const value = (await currentInvoke()('browser_backend_status')) as unknown;
    if (!value || typeof value !== 'object') throw new Error('shape');
    const status = value as Partial<BrowserBackendStatus>;
    if (
      typeof status.enabled !== 'boolean' ||
      typeof status.debuggerPort !== 'number' ||
      typeof status.sessionCount !== 'number'
    ) {
      throw new Error('shape');
    }
    return {
      enabled: status.enabled,
      debuggerPort: status.debuggerPort,
      sessionCount: status.sessionCount,
    };
  } catch {
    return { enabled: false, debuggerPort: 0, sessionCount: 0 };
  }
}

/** 启用 / 关闭真实后端。返回被断开的活动会话数。 */
export async function setBrowserBackendEnabled(enabled: boolean): Promise<number> {
  const closed = (await currentInvoke()('browser_backend_set_enabled', { enabled })) as unknown;
  return typeof closed === 'number' && Number.isSafeInteger(closed) && closed >= 0 ? closed : 0;
}

/**
 * 创建 CDP 真实后端的工具处理器。
 *
 * 返回的 handler 实现 `BrowserToolHandler` 接口，因此可以**直接注入**既有的
 * `createBrowserToolExecutor({ handler })`——工具面契约、注册表与调用方都不用改。
 * 这正是那个缝在设计时就留好的用法。
 */
export function createCdpBrowserToolHandler(): BrowserToolHandler {
  return {
    async call(call: BrowserToolCall): Promise<BrowserToolCallResult> {
      // 工具名必须是非空字符串：IPC 对端会用它做 `mcp__browser__` 前缀剥除，
      // 传空串过去只会得到一条无意义的错误。
      if (typeof call.toolName !== 'string' || !call.toolName.trim()) {
        return {
          content: [{ type: 'text', text: '浏览器工具调用缺少工具名。' }],
          isError: true,
          errorCode: BROWSER_TOOL_NOT_REGISTERED_CODE,
        };
      }
      try {
        const raw = (await currentInvoke()('browser_tool_call', {
          request: { toolName: call.toolName, arguments: call.arguments },
        })) as unknown;
        return toToolCallResult(raw);
      } catch (error) {
        // IPC 本身失败（命令未注册、序列化失败等）：明确归因，不假装是工具失败。
        const detail = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `无法调用浏览器原生后端：${detail}` }],
          isError: true,
          errorCode: BROWSER_TOOL_BACKEND_UNAVAILABLE_CODE,
        };
      }
    },
  };
}
