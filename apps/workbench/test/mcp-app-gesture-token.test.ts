// 一个文件=一种作用：MCP App 沙箱手势 token 注册表的验收测试（P2-2）。
//
// 全部用可注入假时钟覆盖「过期」与「一次性消费」，不依赖真实 sleep。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  McpAppGestureTokenRegistry,
  MCP_APP_USER_GESTURE_TTL_MS,
} from '../src/runtime/zcode/mcp-app-gesture-token';

/** 可控时钟：测试显式推进时间。 */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

test('TTL 常量与上游一致：5 秒', () => {
  assert.equal(MCP_APP_USER_GESTURE_TTL_MS, 5_000);
});

test('fail-closed：没有打过标的实例消费失败', () => {
  const registry = new McpAppGestureTokenRegistry({ now: () => 0 });
  assert.equal(registry.consume('instance-a'), false);
});

test('打标后 5 秒窗口内消费成功，且只成功一次（一次性）', () => {
  const clock = fakeClock();
  const registry = new McpAppGestureTokenRegistry({ now: clock.now });
  registry.mark('instance-a');
  assert.equal(registry.consume('instance-a'), true, '窗口内首次消费放行');
  assert.equal(registry.consume('instance-a'), false, '同一 token 不可重放');
});

test('超过 TTL 后消费失败，但仍然被清空（过期也一次性）', () => {
  const clock = fakeClock();
  const registry = new McpAppGestureTokenRegistry({ now: clock.now });
  registry.mark('instance-a');
  clock.advance(MCP_APP_USER_GESTURE_TTL_MS + 1);
  assert.equal(registry.consume('instance-a'), false, '过期即拒');
  clock.advance(-(MCP_APP_USER_GESTURE_TTL_MS + 1)); // 回到打标时刻
  assert.equal(registry.consume('instance-a'), false, '过期消费已清空，不能重放');
});

test('边界：恰好等于 TTL 仍放行，超过一毫秒即拒', () => {
  const clock = fakeClock();
  const registry = new McpAppGestureTokenRegistry({ now: clock.now });
  registry.mark('exact');
  clock.advance(MCP_APP_USER_GESTURE_TTL_MS);
  assert.equal(registry.consume('exact'), true);

  const clock2 = fakeClock();
  const registry2 = new McpAppGestureTokenRegistry({ now: clock2.now });
  registry2.mark('over');
  clock2.advance(MCP_APP_USER_GESTURE_TTL_MS + 1);
  assert.equal(registry2.consume('over'), false);
});

test('按实例隔离：一个实例的 token 不能给另一个实例用', () => {
  const clock = fakeClock();
  const registry = new McpAppGestureTokenRegistry({ now: clock.now });
  registry.mark('instance-a');
  assert.equal(registry.consume('instance-b'), false, '未打标实例仍 fail-closed');
  assert.equal(registry.consume('instance-a'), true, 'a 自己的 token 仍在');
});

test('重新打标刷新窗口（覆盖旧值）', () => {
  const clock = fakeClock();
  const registry = new McpAppGestureTokenRegistry({ now: clock.now });
  registry.mark('instance-a');
  clock.advance(MCP_APP_USER_GESTURE_TTL_MS - 100);
  registry.mark('instance-a'); // 新手势，窗口重新起算
  clock.advance(200); // 距首次已超 5 秒，距新打标仅 200ms
  assert.equal(registry.consume('instance-a'), true);
});

test('forget 丢弃实例 token；size 反映持有量', () => {
  const clock = fakeClock();
  const registry = new McpAppGestureTokenRegistry({ now: clock.now });
  registry.mark('instance-a');
  registry.mark('instance-b');
  assert.equal(registry.size, 2);
  registry.forget('instance-a');
  assert.equal(registry.size, 1);
  assert.equal(registry.consume('instance-a'), false, 'forget 后 fail-closed');
  registry.clear();
  assert.equal(registry.size, 0);
});

test('缺省 TTL 为 5 秒（不注入 ttlMs 时按上游常量）', () => {
  const clock = fakeClock();
  const registry = new McpAppGestureTokenRegistry({ now: clock.now });
  registry.mark('instance-a');
  clock.advance(MCP_APP_USER_GESTURE_TTL_MS + 1);
  assert.equal(registry.consume('instance-a'), false);
});
