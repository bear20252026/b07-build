import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_TOOL_SPECS } from '@awo/capability-placeholder/browser-tools';
import type { BrowserToolCall, BrowserToolCallResult, BrowserToolHandler } from '@awo/capability-placeholder/browser-handlers';
import {
  BROWSER_TOOL_NAME_PREFIX,
  browserAgentTools,
  browserToolResultText,
  createBrowserToolExecutor,
  isBrowserToolName,
} from '../src/runtime/browser-agent-tools';

// ---------------------------------------------------------------------------
// 本项缺陷：`createCdpBrowserToolHandler` 等三个导出**没有任何生产调用方**，
// 实际 Agent 只注入 WORKSPACE_TOOLS。有 Rust 命令、有 TS 适配器，却没有入口。
// 本文件的用例钉住"入口存在且行为正确"这件事。
// ---------------------------------------------------------------------------

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
  // 工作区工具名不得被误判成浏览器工具。
  assert.equal(isBrowserToolName('workspace_write_file'), false);
});

test('工具声明是可用的对象 schema 且必填项与声明一致', () => {
  const tools = browserAgentTools();
  const navigate = tools.find((tool) => tool.name.endsWith('__navigate'));
  assert.ok(navigate);
  const parameters = navigate.parameters as { type: string; properties: Record<string, unknown>; required: string[] };
  assert.equal(parameters.type, 'object');
  assert.ok('url' in parameters.properties);
  assert.ok(parameters.required.includes('url'));
  // 声明里带只读标注：模型据此知道哪些调用会改动外部世界。
  assert.match(navigate.description, /会改动页面状态/);
});

test('只读工具在描述里标为只读', () => {
  const snapshot = browserAgentTools().find((tool) => tool.name.endsWith('__snapshot'));
  assert.ok(snapshot);
  assert.match(snapshot.description, /只读/);
});

test('文本块原样拼接', () => {
  const text = browserToolResultText({
    content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }],
    isError: false,
  });
  assert.equal(text, '第一行\n第二行');
});

test('图片块折叠成描述且不携带base64', () => {
  // 把 base64 塞进文本会让一次截图吃掉几十万字符的窗口；截断它则会产出坏数据。
  const base64 = 'A'.repeat(5_000);
  const text = browserToolResultText({
    content: [{ type: 'image', data: base64, mimeType: 'image/png' }],
    isError: false,
  });
  assert.equal(text.includes(base64), false, '不得把 base64 带进文本');
  assert.match(text, /已捕获截图/);
  assert.match(text, /image\/png/);
  assert.match(text, /5000 字符/);
  // 必须如实说明图没附上，否则模型会以为它看见了图。
  assert.match(text, /未附在工具结果里/);
});

test('错误结果带上稳定错误码', () => {
  const text = browserToolResultText({
    content: [{ type: 'text', text: '后端未启用。' }],
    isError: true,
    errorCode: 'browser_tool_backend_unavailable',
  });
  assert.match(text, /browser_tool_backend_unavailable/);
  assert.match(text, /后端未启用/);
});

test('错误但没有内容时也要有可读文本', () => {
  const text = browserToolResultText({ content: [], isError: true, errorCode: 'x' });
  assert.match(text, /\[x\]/);
  assert.match(text, /未给出原因/);
});

test('成功但没有内容块时不谎报有内容', () => {
  const text = browserToolResultText({ content: [], isError: false });
  assert.match(text, /没有返回内容/);
});

test('执行器把调用与解析后的参数交给处理器', async () => {
  const handler = handlerOf({ content: [{ type: 'text', text: 'ok' }], isError: false });
  const executor = createBrowserToolExecutor(handler);
  const text = await executor.execute('mcp__browser__navigate', '{"sessionId":"s","url":"https://e.com"}');
  assert.equal(text, 'ok');
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.calls[0]!.toolName, 'mcp__browser__navigate');
  assert.deepEqual(handler.calls[0]!.arguments, { sessionId: 's', url: 'https://e.com' });
});

test('参数不是合法JSON时如实报错且不调用处理器', async () => {
  const handler = handlerOf({ content: [{ type: 'text', text: '不该被调用' }], isError: false });
  const executor = createBrowserToolExecutor(handler);
  const text = await executor.execute('mcp__browser__click', '{"selector": ');
  // 当成空参数继续会让工具在"没有目标"的情况下执行 —— 比拒绝更糟。
  assert.equal(handler.calls.length, 0);
  assert.match(text, /不是合法 JSON/);
  assert.match(text, /未执行任何浏览器命令/);
});

test('空参数被当成无参数调用', async () => {
  const handler = handlerOf({ content: [{ type: 'text', text: 'ok' }], isError: false });
  const executor = createBrowserToolExecutor(handler);
  await executor.execute('mcp__browser__list_sessions', '   ');
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.calls[0]!.arguments, undefined);
});

test('处理器抛异常时收敛成文本而不是让回合崩掉', async () => {
  // 处理器契约是"失败返回结果而不是抛出"。真抛了说明契约被违反，
  // 但异常冒泡到 Agent 回合会丢掉整回合的执行痕迹。
  const handler: BrowserToolHandler = {
    async call(): Promise<BrowserToolCallResult> {
      throw new Error('IPC 断了');
    },
  };
  const executor = createBrowserToolExecutor(handler);
  const text = await executor.execute('mcp__browser__snapshot', '{}');
  assert.match(text, /抛出异常/);
  assert.match(text, /IPC 断了/);
});

test('错误结果经过执行器仍带错误码', async () => {
  const handler = handlerOf({
    content: [{ type: 'text', text: '会话不存在。' }],
    isError: true,
    errorCode: 'browser-session-unknown',
  });
  const text = await createBrowserToolExecutor(handler).execute('mcp__browser__snapshot', '{"sessionId":"nope"}');
  assert.match(text, /browser-session-unknown/);
});
