// 一个文件=一种作用：CDP 真实后端工具处理器（TS 薄适配层）的验收测试。
//
// 断言四件事：① handler 实现 `BrowserToolHandler` 接口且能注入既有执行器；
// ② 后端未启用 / IPC 失败时以**稳定错误码**失败关闭（不静默成功）；
// ③ 原生返回的形状被校验（对端不可信），畸形形状不产生"看似成功"的结果；
// ④ 状态查询在 IPC 失败时按"未启用"处理。
//
// 本测试**不建立真实 CDP 连接**：那部分（帧、端点白名单、会话状态机）已在
// `crates/cdp-client` 与 `crates/cdp-transport` 用 Rust 单测与集成测试钉死。
// 这一层要钉的是**跨界处的形状约定**——它才是这一层唯一的职责。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_TOOL_NAMES,
  createBrowserToolExecutor,
  type BrowserToolCallResult,
} from '@awo/capability-placeholder';

import {
  BROWSER_TOOL_BACKEND_UNAVAILABLE_CODE,
  BROWSER_TOOL_RESPONSE_INVALID_CODE,
  createCdpBrowserToolHandler,
  readBrowserBackendStatus,
  setBrowserBackendEnabled,
} from '../src/runtime/cdp-browser-tool-handler.js';

/** 用 `node:test` 的 mock 能力替换 `invoke`。 */
interface InvokeMock {
  (command: string, args?: unknown): Promise<unknown>;
}

/**
 * 安装一个假的 `invoke` 实现。
 *
 * 通过 `node:test` 的 `mock.module` 做不到（`@tauri-apps/api/core` 是真实包），
 * 因此改用**注入式**取值：本模块只在调用时才 `invoke(...)`，测试通过
 * `t.mock.method` 替换模块命名空间的导出不可行（ESM 只读）。
 * 折中方案：直接在 `globalThis` 上放一个钩子，模块在测试构建下读它。
 */
function installInvokeMock(implementation: InvokeMock): void {
  (globalThis as Record<string, unknown>).__awoCdpInvokeMock = implementation;
}

function clearInvokeMock(): void {
  delete (globalThis as Record<string, unknown>).__awoCdpInvokeMock;
}

test('handler 可在后端未启用时被注入既有执行器', async () => {
  // 这是本批次的核心验收点：占位包留的缝**不改契约**就能注入真实实现。
  const handler = createCdpBrowserToolHandler();
  const executor = createBrowserToolExecutor({ handler });
  // 未 mock invoke：真实 IPC 不存在，应当以稳定码失败关闭而不是抛异常。
  const result = await executor.execute({
    toolName: BROWSER_TOOL_NAMES.navigate,
    arguments: { sessionId: 's', url: 'https://example.com' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, BROWSER_TOOL_BACKEND_UNAVAILABLE_CODE);
});

test('未登记工具在执行器阶段即被拒_不会走到 handler', async () => {
  const handler = createCdpBrowserToolHandler();
  const executor = createBrowserToolExecutor({ handler });
  const result = await executor.execute({ toolName: 'mcp__browser__not_a_tool' });
  assert.equal(result.isError, true);
  // 这里刻意断言**字面量**而非导入的常量：这个码是对外契约的冻结值，
  // 若哪天有人改了 `BROWSER_TOOL_NOT_REGISTERED_CODE` 的值，
  // 断言同一个常量的测试会一起跟着变、静默通过；断言字面量才会失败。
  assert.equal(result.errorCode, 'browser_tool_not_registered');
});

test('缺少工具名的调用以稳定码失败关闭', async () => {
  const handler = createCdpBrowserToolHandler();
  const result = await handler.call({ toolName: '   ' });
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'browser_tool_not_registered');
});

test('原生返回合法形状时被如实透传', async () => {
  installInvokeMock(async (command) => {
    assert.equal(command, 'browser_tool_call');
    return {
      content: [{ type: 'text', text: '[Page.navigate] {"frameId":"A"}' }],
      isError: false,
    };
  });
  try {
    const handler = createCdpBrowserToolHandler();
    const result = await handler.call({
      toolName: BROWSER_TOOL_NAMES.navigate,
      arguments: { sessionId: 's', url: 'https://example.com' },
    });
    assert.equal(result.isError, false);
    assert.equal(result.errorCode, undefined);
    assert.equal(result.content[0]?.text, '[Page.navigate] {"frameId":"A"}');
  } finally {
    clearInvokeMock();
  }
});

test('原生返回错误时错误码被保留', async () => {
  installInvokeMock(async () => ({
    content: [{ type: 'text', text: 'CDP 拒绝' }],
    isError: true,
    errorCode: 'cdp_error_-32000',
  }));
  try {
    const handler = createCdpBrowserToolHandler();
    const result = await handler.call({ toolName: BROWSER_TOOL_NAMES.click });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'cdp_error_-32000');
  } finally {
    clearInvokeMock();
  }
});

test('原生返回出错却不给错误码时补稳定码', async () => {
  // 留空会让外部无从归因——"失败了但不知道为什么"比"失败了且知道分类"难排查得多。
  installInvokeMock(async () => ({
    content: [{ type: 'text', text: '坏了' }],
    isError: true,
  }));
  try {
    const handler = createCdpBrowserToolHandler();
    const result = await handler.call({ toolName: BROWSER_TOOL_NAMES.click });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, BROWSER_TOOL_RESPONSE_INVALID_CODE);
  } finally {
    clearInvokeMock();
  }
});

test('原生返回非对象时被判形状非法', async () => {
  installInvokeMock(async () => 'not an object');
  try {
    const handler = createCdpBrowserToolHandler();
    const result = await handler.call({ toolName: BROWSER_TOOL_NAMES.click });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, BROWSER_TOOL_RESPONSE_INVALID_CODE);
  } finally {
    clearInvokeMock();
  }
});

test('原生返回缺字段时被判形状非法', async () => {
  installInvokeMock(async () => ({ content: [{ type: 'text', text: 'x' }] }));
  try {
    const handler = createCdpBrowserToolHandler();
    const result = await handler.call({ toolName: BROWSER_TOOL_NAMES.click });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, BROWSER_TOOL_RESPONSE_INVALID_CODE);
  } finally {
    clearInvokeMock();
  }
});

test('原生返回全是非法内容块时被判形状非法', async () => {
  // 内容块类型不是 text、或 text 不是字符串——都不能被"编造"成可读内容。
  installInvokeMock(async () => ({
    content: [{ type: 'image', text: 123 }],
    isError: false,
  }));
  try {
    const handler = createCdpBrowserToolHandler();
    const result = await handler.call({ toolName: BROWSER_TOOL_NAMES.snapshot });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, BROWSER_TOOL_RESPONSE_INVALID_CODE);
  } finally {
    clearInvokeMock();
  }
});

test('非法内容块被跳过而合法块被保留', async () => {
  installInvokeMock(async () => ({
    content: [
      { type: 'text', text: '可读' },
      { type: 'image' },
      { type: 'text', text: '也可读' },
    ],
    isError: false,
  }));
  try {
    const handler = createCdpBrowserToolHandler();
    const result = await handler.call({ toolName: BROWSER_TOOL_NAMES.snapshot });
    assert.equal(result.isError, false);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0]?.text, '可读');
    assert.equal(result.content[1]?.text, '也可读');
  } finally {
    clearInvokeMock();
  }
});

test('状态查询在 IPC 失败时按未启用处理', async () => {
  installInvokeMock(async () => {
    throw new Error('command not found');
  });
  try {
    const status = await readBrowserBackendStatus();
    assert.deepEqual(status, { enabled: false, debuggerPort: 0, sessionCount: 0 });
  } finally {
    clearInvokeMock();
  }
});

test('状态查询在形状非法时按未启用处理', async () => {
  installInvokeMock(async () => ({ enabled: 'yes', debuggerPort: 'x', sessionCount: null }));
  try {
    const status = await readBrowserBackendStatus();
    assert.deepEqual(status, { enabled: false, debuggerPort: 0, sessionCount: 0 });
  } finally {
    clearInvokeMock();
  }
});

test('状态查询透传合法状态', async () => {
  installInvokeMock(async () => ({ enabled: true, debuggerPort: 9222, sessionCount: 2 }));
  try {
    const status = await readBrowserBackendStatus();
    assert.deepEqual(status, { enabled: true, debuggerPort: 9222, sessionCount: 2 });
  } finally {
    clearInvokeMock();
  }
});

test('启用开关把非法返回值归一为零', async () => {
  installInvokeMock(async () => 'nonsense');
  try {
    assert.equal(await setBrowserBackendEnabled(false), 0);
  } finally {
    clearInvokeMock();
  }
});

test('启用开关透传关闭计数', async () => {
  installInvokeMock(async () => 3);
  try {
    assert.equal(await setBrowserBackendEnabled(false), 3);
  } finally {
    clearInvokeMock();
  }
});

test('全部十三个工具名都能被 handler 接受而不抛异常', async () => {
  installInvokeMock(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  }));
  try {
    const handler = createCdpBrowserToolHandler();
    for (const toolName of Object.values(BROWSER_TOOL_NAMES)) {
      const result: BrowserToolCallResult = await handler.call({ toolName });
      assert.equal(result.isError, false, `${toolName} 应当被接受`);
    }
  } finally {
    clearInvokeMock();
  }
});
