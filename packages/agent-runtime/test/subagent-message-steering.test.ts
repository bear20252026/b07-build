// 一个文件=一种作用：父↔子代理消息路由的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { SubagentMessageRouter, formatCoordinatorMessage } from '../src/index.js';

test('双向路由：父投给子、子回投给父，各自 FIFO 取走', () => {
  const router = new SubagentMessageRouter();
  router.open('child-1');

  router.sendToChild({ id: 'm-1', childId: 'child-1', message: '先看 A', summary: '补充方向', at: 10 });
  router.sendToChild({ id: 'm-2', childId: 'child-1', message: '再看 B', at: 11 });
  router.sendToParent({ id: 'r-1', childId: 'child-1', message: 'A 的结论', at: 12 });

  assert.deepEqual(router.pending('child-1'), { toChild: 2, toParent: 1 });

  const first = router.takeForChild('child-1');
  assert.equal(first?.content, '补充方向\n\n先看 A', 'summary 与正文以空行分隔');
  assert.equal(first?.direction, 'parent-to-child');
  assert.equal(router.takeForChild('child-1')?.content, '再看 B');
  assert.equal(router.takeForChild('child-1'), undefined);
  assert.equal(router.takeForParent('child-1')?.content, 'A 的结论');
});

test('未打开的子代理拒绝投递；重复消息 id 被拒绝', () => {
  const router = new SubagentMessageRouter();
  assert.throws(
    () => router.sendToChild({ id: 'm-1', childId: 'ghost', message: 'hi', at: 1 }),
    /未打开/u,
  );
  router.open('child-1');
  router.sendToChild({ id: 'm-1', childId: 'child-1', message: 'hi', at: 1 });
  assert.throws(
    () => router.sendToChild({ id: 'm-1', childId: 'child-1', message: 'hi again', at: 2 }),
    /已投递/u,
  );
  assert.throws(() => router.open('child-1'), /已打开/u);
});

test('sink 按绑定方向投递，无需重复传 childId', () => {
  const router = new SubagentMessageRouter();
  router.open('child-9');
  router.createParentSink('child-9').send({ id: 'm-1', message: '任务说明', at: 1 });
  router.createChildSink('child-9').send({ id: 'r-1', message: '完成', summary: '结果', at: 2 });
  assert.equal(router.takeForChild('child-9')?.content, '任务说明');
  assert.equal(router.takeForParent('child-9')?.content, '结果\n\n完成');
});

test('空正文与非法时间戳被拒绝', () => {
  const router = new SubagentMessageRouter();
  router.open('child-1');
  assert.throws(() => router.sendToChild({ id: 'm-1', childId: 'child-1', message: '  ', at: 1 }), /正文/u);
  assert.throws(() => router.sendToChild({ id: 'm-2', childId: 'child-1', message: 'ok', at: -1 }), /at/u);
  assert.equal(formatCoordinatorMessage({ message: '正文' }), '正文');
});
