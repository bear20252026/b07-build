// 一个文件=一种作用：MCP App 实例租约的验收测试（R1 审计 R4-03 的
// 「插件切换后旧结果绝不投递到新实例」语义钉子）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { McpAppInstanceLease } from '../src/runtime/zcode/mcp-app-lease';

test('同代际：请求入账后结果放行并消耗记录', () => {
  const lease = new McpAppInstanceLease();
  lease.rotate();
  lease.issue('call-1');
  assert.equal(lease.pendingCount, 1);
  assert.equal(lease.deliver('call-1'), true);
  assert.equal(lease.deliver('call-1'), false, '同一请求结果只能投递一次');
  assert.equal(lease.pendingCount, 0);
});

test('代际轮转：iframe 重载后旧实例的迟到结果被丢弃', () => {
  const lease = new McpAppInstanceLease();
  lease.rotate();
  lease.issue('call-A');
  // 插件 B 在同一 iframe 加载：代际轮转。
  lease.rotate();
  assert.equal(lease.deliver('call-A'), false, '旧实例的结果绝不能投递到新实例');
  // 新实例的请求正常放行。
  lease.issue('call-B');
  assert.equal(lease.deliver('call-B'), true);
});

test('从未入账的请求结果直接丢弃', () => {
  const lease = new McpAppInstanceLease();
  lease.rotate();
  assert.equal(lease.deliver('forged'), false);
});

test('rotate 返回递增代际，且轮转会清空旧代际的未决记录', () => {
  const lease = new McpAppInstanceLease();
  const first = lease.rotate();
  lease.issue('a');
  const second = lease.rotate();
  assert.equal(second, first + 1);
  assert.equal(lease.pendingCount, 0, '轮转即失效，旧未决记录不再占用');
});
