import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_BACKEND_UNAVAILABLE_TEXT, backendToggleNote } from '../src/runtime/browser-backend-note';

// ---------------------------------------------------------------------------
// 本仓没有 DOM 测试环境，组件本身只能靠类型检查与构建兜底；
// 但"开关之后该说什么"是纯逻辑，抽出来就有牙齿了。
// ---------------------------------------------------------------------------

test('启用后说明 Agent 现在能调用浏览器工具', () => {
  assert.match(backendToggleNote(false, 0), /已启用后端/);
  assert.match(backendToggleNote(false, 0), /可以调用浏览器工具/);
});

test('关闭时如实报出被断开的会话数', () => {
  // 那个数字是这次操作的实际影响，不说不等于没发生。
  const note = backendToggleNote(true, 3);
  assert.match(note, /已关闭后端/);
  assert.match(note, /断开 3 个会话/);
});

test('没有活动会话时不编造断开数', () => {
  const note = backendToggleNote(true, 0);
  assert.equal(note, '已关闭后端。');
  assert.equal(note.includes('0 个'), false);
});

test('状态不可读时的说明明确按不可用处理', () => {
  assert.match(BROWSER_BACKEND_UNAVAILABLE_TEXT, /读不到后端状态/);
  assert.match(BROWSER_BACKEND_UNAVAILABLE_TEXT, /不会假装可用/);
});
