// 一个文件=一种作用：MCP App 页面实例状态机的验收测试（活跃/忙碌 + 订阅通知）。
//
// 该状态机是组件与页面管理器之间的契约：suspend/destroy 置为不活跃并通知订阅者，
// 工具调用在途计为忙碌（回收会被跳过）。纯逻辑，无需 DOM。

import assert from 'node:assert/strict';
import test from 'node:test';
import { McpAppPage } from '../src/runtime/zcode/mcp-app-page';

test('活跃状态：suspend/destroy 置为不活跃并通知订阅者，activate 复活', () => {
  const page = new McpAppPage('page', 'task');
  let notifications = 0;
  const off = page.subscribe(() => {
    notifications += 1;
  });

  assert.equal(page.running(), true);
  assert.equal(page.getSnapshot(), true);
  page.suspend();
  assert.equal(page.running(), false);
  assert.equal(notifications, 1, '订阅者收到一次通知');
  page.suspend();
  assert.equal(notifications, 1, '状态未变化不重复通知');

  page.activate();
  assert.equal(page.getSnapshot(), true);
  assert.equal(notifications, 2);

  page.destroy();
  assert.equal(page.running(), false);
  off();
  page.activate();
  assert.equal(notifications, 3, '取消订阅后不再收到通知');
});

test('忙碌计数：在途工具调用期间 busy 为真，结束后归零', () => {
  const page = new McpAppPage('page', 'task');
  assert.equal(page.busy(), false);
  page.beginCall();
  page.beginCall();
  assert.equal(page.busy(), true);
  page.endCall();
  assert.equal(page.busy(), true, '仍有在途调用');
  page.endCall();
  assert.equal(page.busy(), false);
  page.endCall();
  assert.equal(page.busy(), false, '不会出现负计数');
});
