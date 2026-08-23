import assert from 'node:assert/strict';
import test from 'node:test';
import { messageWindowStart } from '../src/components/workspace/chat-timeline-window.js';

test('聊天时间线默认只挂载最近 60 条消息，旧消息可按窗口加载', () => {
  assert.equal(messageWindowStart(0), 0);
  assert.equal(messageWindowStart(60), 0);
  assert.equal(messageWindowStart(121), 61);
  assert.equal(messageWindowStart(121, 1), 1);
  assert.equal(messageWindowStart(121, 100), 61);
});
