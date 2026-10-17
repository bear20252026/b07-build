import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_TOOL_SPECS } from '@awo/capability-placeholder/browser-tools';
import type { BrowserToolCall, BrowserToolCallResult, BrowserToolHandler } from '@awo/capability-placeholder/browser-handlers';
import {
  BROWSER_TOOL_NAME_PREFIX,
  browserAgentTools,
  browserToolResult,
  createBrowserToolExecutor,
  isBrowserToolName,
} from '../src/runtime/browser-agent-tools';
import { modelAcceptsImageInput, unsupportedImageInputText } from '../src/runtime/model-image-input';

// ---------------------------------------------------------------------------
// 本项缺陷（两段）：
// ① `createCdpBrowserToolHandler` 等三个导出**没有任何生产调用方**，实际 Agent 只注入
//    WORKSPACE_TOOLS —— 有 Rust 命令、有 TS 适配器，却没有入口。
// ② 打通入口后，截图被折叠成一句"图未附上"的文本 —— 因为 `execute` 的契约只返回 string。
// 本文件的用例钉住"入口存在"与"图片真的走多模态通道"这两件事。
// ---------------------------------------------------------------------------

/** 一个模型接受图片输入的会话（默认用 DeepSeek —— 不在已知文本模型表里）。 */
const IMAGE_OK = { providerId: 'deepseek', model: 'deepseek-v4-pro' } as const;
/** 已知不接受图片输入的会话（依据见 model-image-input.ts）。 */
const TEXT_ONLY = { providerId: 'mimo', model: 'mimo-v2.5-pro' } as const;

function handlerOf(result: BrowserToolCallResult | ((call: BrowserToolCall) => BrowserToolCallResult)): BrowserToolHandler & { readonly calls: BrowserToolCall[] } {
  const calls: BrowserToolCall[] = [];
  return {
    calls,
    async call(call: BrowserToolCall): Promise<BrowserToolCallResult> {
      calls.push(call);
      return typeof result === 'function' ? result(call) : result;
    },
  };
}

// ---------------------------------------------------------------------------
// 工具清单
// ---------------------------------------------------------------------------

test('工具清单与公开声明一一对应', () => {
  const tools = browserAgentTools();
  assert.equal(tools.length, 13);
  assert.equal(tools.length, BROWSER_TOOL_SPECS.length);
  assert.deepEqual(tools.map((tool) => tool.name), BROWSER_TOOL_SPECS.map((spec) => spec.name));
});

test('工具名带浏览器前缀且可被识别', () => {
  for (const tool of browserAgentTools()) {
    assert.ok(tool.name.startsWith(BROWSER_TOOL_NAME_PREFIX), tool.name);
    assert.equal(isBrowserToolName(tool.name), true);
  }
  assert.equal(isBrowserToolName('workspace_write_file'), false);
});

test('工具声明是可用的对象 schema 且必填项与声明一致', () => {
  const navigate = browserAgentTools().find((tool) => tool.name.endsWith('__navigate'));
  assert.ok(navigate);
  const parameters = navigate.parameters as { type: string; properties: Record<string, unknown>; required: string[] };
  assert.equal(parameters.type, 'object');
  assert.ok('url' in parameters.properties);
  assert.ok(parameters.required.includes('url'));
  assert.match(navigate.description, /会改动页面状态/);
});

test('只读工具在描述里标为只读', () => {
  const snapshot = browserAgentTools().find((tool) => tool.name.endsWith('__snapshot'));
  assert.ok(snapshot);
  assert.match(snapshot.description, /只读/);
});

// ---------------------------------------------------------------------------
// 结果：图片走多模态通道
// ---------------------------------------------------------------------------

test('模型接受图片时截图作为图片发出而不是折叠成文本', () => {
  // 这是本项修复的核心：图片必须真的到模型眼前。
  const base64 = 'A'.repeat(5_000);
  const result = browserToolResult(
    { content: [{ type: 'image', data: base64, mimeType: 'image/png' }], isError: false },
    IMAGE_OK,
  );
  assert.deepEqual(result.images, [{ mediaType: 'image/png', base64Data: base64 }]);
  // 文本里**不得**出现 base64：那会吃掉几十万字符的窗口，截断它则产出坏数据。
  assert.equal(result.text.includes(base64), false);
});

test('模型不接受图片时降级成文本且不携带图片', () => {
  // 把图发出去会让上游 404 打掉整回合 —— 那比"看图失败"更糟。
  const base64 = 'A'.repeat(5_000);
  const result = browserToolResult(
    { content: [{ type: 'image', data: base64, mimeType: 'image/png' }], isError: false },
    TEXT_ONLY,
  );
  assert.equal(result.images, undefined);
  assert.equal(result.text.includes(base64), false);
  assert.match(result.text, /已捕获截图/);
  assert.match(result.text, /不接受图片输入/);
  // 必须说清图片没被本地丢弃，否则用户会以为截图失败了。
  assert.match(result.text, /没有被本地丢弃/);
});

test('无法作为图片发出的格式降级成文本', () => {
  // 原生校验会拒绝非白名单 MIME 并抛错打掉整回合；这里先降级。
  const result = browserToolResult(
    { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/tiff' }], isError: false },
    IMAGE_OK,
  );
  assert.equal(result.images, undefined);
  assert.match(result.text, /无法作为图片发出/);
});

test('base64 含非法字符时降级成文本', () => {
  const result = browserToolResult(
    { content: [{ type: 'image', data: 'not base64!!', mimeType: 'image/png' }], isError: false },
    IMAGE_OK,
  );
  assert.equal(result.images, undefined);
});

test('文本块与图片块可以同时存在', () => {
  const result = browserToolResult(
    {
      content: [
        { type: 'text', text: '页面标题：示例' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      isError: false,
    },
    IMAGE_OK,
  );
  assert.match(result.text, /页面标题：示例/);
  assert.equal(result.images?.length, 1);
});

test('纯文本结果不带图片字段', () => {
  const result = browserToolResult(
    { content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }], isError: false },
    IMAGE_OK,
  );
  assert.equal(result.text, '第一行\n第二行');
  assert.equal(result.images, undefined);
});

test('错误结果带上稳定错误码', () => {
  const result = browserToolResult(
    { content: [{ type: 'text', text: '后端未启用。' }], isError: true, errorCode: 'browser_tool_backend_unavailable' },
    IMAGE_OK,
  );
  assert.match(result.text, /browser_tool_backend_unavailable/);
  assert.match(result.text, /后端未启用/);
});

test('错误但没有内容时也要有可读文本', () => {
  const result = browserToolResult({ content: [], isError: true, errorCode: 'x' }, IMAGE_OK);
  assert.match(result.text, /\[x\]/);
  assert.match(result.text, /未给出原因/);
});

test('成功但没有内容块时不谎报有内容', () => {
  const result = browserToolResult({ content: [], isError: false }, IMAGE_OK);
  assert.match(result.text, /没有返回内容/);
});

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

test('执行器把调用与解析后的参数交给处理器', async () => {
  const handler = handlerOf({ content: [{ type: 'text', text: 'ok' }], isError: false });
  const result = await createBrowserToolExecutor(handler, IMAGE_OK).execute('mcp__browser__navigate', '{"sessionId":"s","url":"https://e.com"}');
  assert.equal(result.text, 'ok');
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.calls[0]!.toolName, 'mcp__browser__navigate');
  assert.deepEqual(handler.calls[0]!.arguments, { sessionId: 's', url: 'https://e.com' });
});

test('执行器把截图作为图片带回', async () => {
  const handler = handlerOf({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: false });
  const result = await createBrowserToolExecutor(handler, IMAGE_OK).execute('mcp__browser__take_screenshot', '{"sessionId":"s"}');
  assert.equal(result.images?.length, 1);
  assert.equal(result.images?.[0]?.mediaType, 'image/png');
});

test('参数不是合法JSON时如实报错且不调用处理器', async () => {
  const handler = handlerOf({ content: [{ type: 'text', text: '不该被调用' }], isError: false });
  const result = await createBrowserToolExecutor(handler, IMAGE_OK).execute('mcp__browser__click', '{"selector": ');
  assert.equal(handler.calls.length, 0);
  assert.match(result.text, /不是合法 JSON/);
  assert.match(result.text, /未执行任何浏览器命令/);
});

test('空参数被当成无参数调用', async () => {
  const handler = handlerOf({ content: [{ type: 'text', text: 'ok' }], isError: false });
  await createBrowserToolExecutor(handler, IMAGE_OK).execute('mcp__browser__list_sessions', '   ');
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.calls[0]!.arguments, undefined);
});

test('处理器抛异常时收敛成文本而不是让回合崩掉', async () => {
  const handler: BrowserToolHandler = {
    async call(): Promise<BrowserToolCallResult> {
      throw new Error('IPC 断了');
    },
  };
  const result = await createBrowserToolExecutor(handler, IMAGE_OK).execute('mcp__browser__snapshot', '{}');
  assert.match(result.text, /抛出异常/);
  assert.match(result.text, /IPC 断了/);
});

test('错误结果经过执行器仍带错误码', async () => {
  const handler = handlerOf({
    content: [{ type: 'text', text: '会话不存在。' }],
    isError: true,
    errorCode: 'browser-session-unknown',
  });
  const result = await createBrowserToolExecutor(handler, IMAGE_OK).execute('mcp__browser__snapshot', '{"sessionId":"nope"}');
  assert.match(result.text, /browser-session-unknown/);
});

// ---------------------------------------------------------------------------
// 模型图片能力（参照 ZCode 的 ModelInputFormat.supportsImage / unsupportedInputMediaText）
// ---------------------------------------------------------------------------

test('已知文本模型不接受图片输入', () => {
  assert.equal(modelAcceptsImageInput('mimo', 'mimo-v2.5-pro'), false);
  // 同系列的 mimo-v2.5 支持图片 —— 依据是 streamErrorText 里那句"请切换为 mimo-v2.5"。
  assert.equal(modelAcceptsImageInput('mimo', 'mimo-v2.5'), true);
});

test('大小写不影响判定', () => {
  assert.equal(modelAcceptsImageInput('mimo', 'MiMo-V2.5-Pro'), false);
});

test('没有元数据的模型一律按支持图片处理', () => {
  // 凭空编能力表等于把猜测写成事实；现状就是直接发、靠 404 兜底。
  assert.equal(modelAcceptsImageInput('deepseek', 'deepseek-v4-pro'), true);
  assert.equal(modelAcceptsImageInput('unknown-provider', 'whatever'), true);
  assert.equal(modelAcceptsImageInput('mimo', undefined), true);
});

test('不支持时给出可读的替代文本并指明没丢图', () => {
  const text = unsupportedImageInputText('mimo', 'mimo-v2.5-pro', '描述');
  assert.ok(text);
  assert.match(text, /描述/);
  assert.match(text, /不接受图片输入/);
  assert.match(text, /没有被本地丢弃/);
});

test('支持时不给替代文本', () => {
  assert.equal(unsupportedImageInputText('deepseek', 'deepseek-v4-pro', '描述'), undefined);
});
