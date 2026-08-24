import test from 'node:test';
import assert from 'node:assert/strict';
import { latestScrollTop, shouldScrollToLatest } from '../src/components/workspace/use-chat-auto-scroll';

test('自动滚动只在最新位置实际变化时写入滚动位置', () => {
  assert.equal(latestScrollTop(900, 300), 600);
  assert.equal(shouldScrollToLatest(600, 900, 300), false);
  assert.equal(shouldScrollToLatest(598.5, 900, 300), true);
  assert.equal(shouldScrollToLatest(0, 200, 300), false);
});
