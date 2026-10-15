// 一个文件=一种作用：真实用户交互 → 手势打标绑定的验收测试（P2-2）。
//
// 用事件目标替身验证：只有绑定的真实事件类型会触发打标，解绑后不再触发。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_APP_GESTURE_EVENT_TYPES,
  markMcpAppGestureOnUserInteraction,
  type McpAppGestureEventTarget,
} from '../src/runtime/zcode/mcp-app-gesture-marking';

/** 最小事件目标替身：记录监听器并按类型派发。 */
function fakeTarget(): McpAppGestureEventTarget & { fire: (type: string) => void; listenerCount: () => number } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set<() => void>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount: () => [...listeners.values()].reduce((total, bucket) => total + bucket.size, 0),
  };
}

test('绑定的真实事件类型为 pointerdown 与 keydown', () => {
  assert.deepEqual([...MCP_APP_GESTURE_EVENT_TYPES], ['pointerdown', 'keydown']);
});

test('真实交互事件触发打标', () => {
  const target = fakeTarget();
  let marked = 0;
  markMcpAppGestureOnUserInteraction(target, () => {
    marked += 1;
  });
  target.fire('pointerdown');
  target.fire('keydown');
  assert.equal(marked, 2);
});

test('未绑定的噪声事件不打标', () => {
  const target = fakeTarget();
  let marked = 0;
  markMcpAppGestureOnUserInteraction(target, () => {
    marked += 1;
  });
  target.fire('mousemove');
  target.fire('scroll');
  target.fire('message');
  assert.equal(marked, 0);
});

test('解绑后不再打标且监听器清空', () => {
  const target = fakeTarget();
  let marked = 0;
  const unbind = markMcpAppGestureOnUserInteraction(target, () => {
    marked += 1;
  });
  assert.equal(target.listenerCount(), MCP_APP_GESTURE_EVENT_TYPES.length);
  unbind();
  assert.equal(target.listenerCount(), 0);
  target.fire('pointerdown');
  assert.equal(marked, 0);
});
