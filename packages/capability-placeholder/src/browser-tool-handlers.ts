// 一个文件=一种作用：浏览器工具面的执行缝与 fail-closed 缺省实现。
//
// b07 没有浏览器自动化引擎，因此缺省处理器对**任何**调用都返回明确的不可用
// 失败：稳定的错误码 + 可读原因，绝不静默成功、绝不返回空结果假装成功。
//
// 同时留出可注入的 handler 缝（`BrowserToolHandler`）：未来接入真实后端时，
// 只需注入一个实现，工具面契约（browser-tool-surface.ts）与调用方都不用改。
// 缺省实现永远是全拒——把「不可用」当默认，而不是当异常分支。

import type { ToolRegistry } from '@awo/protocol';

import { BROWSER_TOOL_UNAVAILABLE_CODE, BROWSER_TOOL_UNAVAILABLE_TEXT } from './placeholder-marker.js';
import { createBrowserToolRegistry, findBrowserToolSpec } from './browser-tool-surface.js';

/** 调用了一个未登记工具的稳定错误码（与「后端不可用」区分，便于外部归因）。 */
export const BROWSER_TOOL_NOT_REGISTERED_CODE = 'browser_tool_not_registered';

/** 一次工具调用（canonical 工具名 + 参数 + 可选中断信号）。 */
export interface BrowserToolCall {
  readonly toolName: string;
  readonly arguments?: unknown;
  readonly signal?: AbortSignal;
}

/** 与 MCP 工具结果同形：`content` + `isError`；失败时带稳定 `errorCode`。 */
export interface BrowserToolCallResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError: boolean;
  readonly errorCode?: string;
}

/** 工具处理器契约：缺省实现全拒，真实实现可注入同一接口。 */
export interface BrowserToolHandler {
  call(call: BrowserToolCall): Promise<BrowserToolCallResult>;
}

/**
 * fail-closed 缺省处理器：一切调用都以「后端不可用」失败收尾。
 * 不读参数、不看工具名——没有可用后端时，问什么都不可用。
 */
export function createUnavailableBrowserToolHandler(): BrowserToolHandler {
  return {
    async call(call: BrowserToolCall): Promise<BrowserToolCallResult> {
      return {
        content: [{ type: 'text', text: `${BROWSER_TOOL_UNAVAILABLE_TEXT}（工具：${call.toolName}）` }],
        isError: true,
        errorCode: BROWSER_TOOL_UNAVAILABLE_CODE,
      };
    },
  };
}

/** 工具执行器契约：先做工具面校验，再委派给处理器。 */
export interface BrowserToolExecutor {
  execute(call: BrowserToolCall): Promise<BrowserToolCallResult>;
}

/** 执行器装配选项：处理器与注册表都可注入（缺省 = 全拒处理器 + 全量注册表）。 */
export interface BrowserToolExecutorOptions {
  readonly handler?: BrowserToolHandler;
  readonly registry?: ToolRegistry;
}

/**
 * 装配浏览器工具执行器。
 * 未登记的工具名**在执行前**即失败（稳定错误码），不会漏到处理器里被当成可用工具。
 */
export function createBrowserToolExecutor(options: BrowserToolExecutorOptions = {}): BrowserToolExecutor {
  const handler = options.handler ?? createUnavailableBrowserToolHandler();
  const registry = options.registry ?? createBrowserToolRegistry();

  return {
    async execute(call: BrowserToolCall): Promise<BrowserToolCallResult> {
      if (!registry.has(call.toolName) || findBrowserToolSpec(call.toolName) === undefined) {
        return {
          content: [{ type: 'text', text: `浏览器工具面没有登记工具：${call.toolName}` }],
          isError: true,
          errorCode: BROWSER_TOOL_NOT_REGISTERED_CODE,
        };
      }
      return handler.call(call);
    },
  };
}
