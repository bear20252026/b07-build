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
// ## 结果里的图片怎么走
//
// 图片走**多模态通道**：`AgentToolResult.images` → `role: "tool"` 消息的 `images`
// → 原生 `payload_for` 编成 `image_url` 内容块。截图因此是真的到了模型眼前，
// 而不是只给它一句描述。
//
// 唯一的例外是**已知不接受图片输入的模型**（见 `model-image-input.ts`）：
// 那种情况下图片会被换成一句如实的文本说明（含类型与体积，并明说"图未附上"），
// 以免整回合被上游 404 打掉。这与 ZCode 的 `unsupportedInputMediaText` 同一思路。
//
// 注意这里**从不**把 base64 塞进文本：那条路会产出损坏的半个 base64。

import { BROWSER_TOOL_SPECS } from '@awo/capability-placeholder/browser-tools';
import type { BrowserToolCallResult, BrowserToolHandler } from '@awo/capability-placeholder/browser-handlers';
import { createCdpBrowserToolHandler } from './cdp-browser-tool-handler';
import { unsupportedImageInputText } from './model-image-input';
import type { AgentToolResult } from './agent-tool-loop';
import type { DirectProviderImage, DirectProviderTool } from './direct-provider-client';

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

/** 原生允许的图片 MIME（与 `direct_provider.rs` 的校验保持一致）。 */
const SENDABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

/**
 * 这个图片块能不能作为图片发出去。
 *
 * 与原生校验同口径。**在这里先判一次**是有意的：原生校验失败会抛错并打掉整个回合，
 * 而一次截图不值得让整回合失败 —— 判不过就降级成文本说明。
 */
function isSendableImage(data: string, mimeType: string): boolean {
  return SENDABLE_IMAGE_TYPES.includes(mimeType.toLowerCase()) && /^[A-Za-z0-9+/=]+$/.test(data);
}

/** 图片降级成文本时的说明。 */
function imageTextPlaceholder(dataLength: number, mimeType: string, reason: string): string {
  return `[已捕获截图（${mimeType}，base64 ${dataLength} 字符）。${reason}]`;
}

/**
 * 把工具结果转成 Agent 回合的返回值：文本 +（模型接受时的）图片。
 *
 * 图片走 `images` 而不是塞进文本：塞进文本会让一次截图吃掉几十万字符的窗口，
 * 而截断它产出的是**不可解码的半个 base64**。两条路都不是"把结果交给模型"。
 */
export function browserToolResult(
  result: BrowserToolCallResult,
  imageInput: { readonly providerId: string; readonly model?: string },
): AgentToolResult {
  const parts: string[] = [];
  const images: DirectProviderImage[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      if (typeof block.text === 'string') parts.push(block.text);
      continue;
    }
    if (block.type !== 'image') continue;
    const data = typeof block.data === 'string' ? block.data : '';
    if (!data) continue;
    const mimeType = typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : 'image/png';
    if (!isSendableImage(data, mimeType)) {
      parts.push(imageTextPlaceholder(data.length, mimeType, '该图片格式或内容无法作为图片发出，已改为文本说明。'));
      continue;
    }
    // 已知不吃图片的模型：换成文本，而不是把图发出去让上游 404 打掉整回合。
    const downgraded = unsupportedImageInputText(
      imageInput.providerId,
      imageInput.model,
      imageTextPlaceholder(data.length, mimeType, '当前模型不接受图片输入，故未附图片；需要页面内容可改用 snapshot。'),
    );
    if (downgraded) {
      parts.push(downgraded);
      continue;
    }
    images.push({ mediaType: mimeType, base64Data: data });
    parts.push(`[已附上截图（${mimeType}）。]`);
  }
  const text = parts.join('\n');
  if (result.isError) {
    return { text: `${result.errorCode ? `[${result.errorCode}] ` : ''}${text || '浏览器工具调用失败（后端未给出原因）。'}` };
  }
  return {
    text: text || '浏览器工具调用成功，但没有返回内容。',
    ...(images.length ? { images } : {}),
  };
}

/** 浏览器工具的执行器：把一次调用交给真实后端。 */
export interface BrowserToolExecutor {
  execute(name: string, rawArguments: string): Promise<AgentToolResult>;
}

/**
 * 造一个执行器。
 *
 * `arguments` 是模型拼出来的原始 JSON 文本：解析失败必须**如实报错**而不是
 * 当成空参数继续——空参数会让工具在"没有目标"的情况下执行。
 */
export function createBrowserToolExecutor(
  handler: BrowserToolHandler = createCdpBrowserToolHandler(),
  imageInput: { readonly providerId: string; readonly model?: string } = { providerId: '' },
): BrowserToolExecutor {
  return {
    async execute(name: string, rawArguments: string): Promise<AgentToolResult> {
      let parsed: unknown;
      const trimmed = rawArguments.trim();
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return { text: `工具参数不是合法 JSON，未执行任何浏览器命令：${rawArguments.slice(0, 200)}` };
        }
      }
      try {
        const result = await handler.call({ toolName: name, arguments: parsed });
        return browserToolResult(result, imageInput);
      } catch (error: unknown) {
        // 处理器契约是"失败返回结果而不是抛出"，真抛了说明契约被违反；
        // 但**不能**让异常冒泡到 Agent 回合——那会丢掉整回合的执行痕迹。
        const message = error instanceof Error ? error.message : String(error ?? '');
        return { text: `浏览器工具调用抛出异常，未完成：${message || '（无描述）'}` };
      }
    },
  };
}
