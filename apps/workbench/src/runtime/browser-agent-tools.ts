// 浏览器工具面接进 Agent 回合的桥。
//
// ## 为什么需要这一层
//
// `cdp-browser-tool-handler.ts` 提供了真实后端（Rust CDP 命令 + 结果校验），
// `browser-tool-surface.ts` 提供了公开声明，但两者此前**没有任何生产调用方**：
// 实际聊天 Agent 只注入 `WORKSPACE_TOOLS`。结果是"有 Rust 命令、有 TS 适配器，
// 但正常聊天流程没有浏览器工具入口"——一条完整但悬空的能力链。
//
// 本模块补上中间那段：把公开声明翻译成模型能看到的工具清单，把模型发起的调用
// 路由到处理器，再把结果收敛成一段文本。
//
// ## 为什么结果要收敛成文本
//
// `runAgentTurn` 的 `execute` 契约是返回**文本**（工具结果以 `role: "tool"` 回填）。
// 图片块（截图）因此不能原样进上下文：
// - 直接把 base64 塞进文本会让一次截图吃掉几十万字符的窗口；
// - 工具结果目前也没有多模态通道（`DirectProviderMessage.images` 只用于用户消息）。
//
// 所以截图被折叠成一句**如实**的描述（类型与体积），并明确告知模型"图本身没有附上"。
// 这不是把图片当文本截断——那条路会产出损坏的半个 base64；这里根本不传数据。
// 让模型看见图片需要多模态的工具结果通道，属于后续工作（见交接说明）。

import { BROWSER_TOOL_SPECS } from '@awo/capability-placeholder/browser-tools';
import type { BrowserToolCallResult, BrowserToolHandler } from '@awo/capability-placeholder/browser-handlers';
import { createCdpBrowserToolHandler } from './cdp-browser-tool-handler';
import type { DirectProviderTool } from './direct-provider-client';

/** 浏览器工具的 canonical 名前缀（`mcp__browser__`）。 */
export const BROWSER_TOOL_NAME_PREFIX = 'mcp__browser__';

/** 本回合是否该把某个工具名交给浏览器处理器。 */
export function isBrowserToolName(name: string): boolean {
  return name.startsWith(BROWSER_TOOL_NAME_PREFIX);
}

/**
 * 从公开声明构造模型可见的工具清单。
 *
 * 描述里带上只读标注：模型据此知道哪些调用会改动外部世界。
 */
export function browserAgentTools(): readonly DirectProviderTool[] {
  return BROWSER_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: `${spec.descriptor.description}${spec.descriptor.readOnly ? '（只读，不会改动页面状态）' : '（会改动页面状态）'}`,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        spec.parameters.map((parameter) => [
          parameter.name,
          { type: parameter.type, description: parameter.description },
        ]),
      ),
      required: spec.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    },
  }));
}

/**
 * 把工具结果收敛成一段文本。
 *
 * 文本块原样拼接；图片块折叠成描述（**不传 base64**）。未知块跳过而不是编造。
 */
export function browserToolResultText(result: BrowserToolCallResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'image') {
      const bytes = typeof block.data === 'string' ? block.data.length : 0;
      parts.push(
        `[已捕获截图（${block.mimeType ?? 'image/png'}，base64 ${bytes} 字符）。` +
          '图本身未附在工具结果里——当前工具结果没有多模态通道。' +
          '需要页面内容请改用 snapshot。]',
      );
    }
  }
  const text = parts.join('\n');
  if (result.isError) {
    return `${result.errorCode ? `[${result.errorCode}] ` : ''}${text || '浏览器工具调用失败（后端未给出原因）。'}`;
  }
  return text || '浏览器工具调用成功，但没有返回内容。';
}

/** 浏览器工具的执行器：把一次调用交给真实后端。 */
export interface BrowserToolExecutor {
  execute(name: string, rawArguments: string): Promise<string>;
}

/**
 * 造一个执行器。
 *
 * `arguments` 是模型拼出来的原始 JSON 文本：解析失败必须**如实报错**而不是
 * 当成空参数继续——空参数会让工具在"没有目标"的情况下执行。
 */
export function createBrowserToolExecutor(
  handler: BrowserToolHandler = createCdpBrowserToolHandler(),
): BrowserToolExecutor {
  return {
    async execute(name: string, rawArguments: string): Promise<string> {
      let parsed: unknown;
      const trimmed = rawArguments.trim();
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return `工具参数不是合法 JSON，未执行任何浏览器命令：${rawArguments.slice(0, 200)}`;
        }
      }
      try {
        const result = await handler.call({ toolName: name, arguments: parsed });
        return browserToolResultText(result);
      } catch (error: unknown) {
        // 处理器契约是"失败返回结果而不是抛出"，真抛了说明契约被违反；
        // 但**不能**让异常冒泡到 Agent 回合——那会丢掉整回合的执行痕迹。
        const message = error instanceof Error ? error.message : String(error ?? '');
        return `浏览器工具调用抛出异常，未完成：${message || '（无描述）'}`;
      }
    },
  };
}
