// 一个文件=一种作用：审批请求队列状态机的验收测试（R1 审计 R2-05 的
// 「恰好应答一次」语义钉子——React 状态函数不再承担事务语义）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalRequestQueue, type ApprovalQueueEntry } from '../src/runtime/zcode/approval-request-queue';

function entry(id: string, overrides: Partial<ApprovalQueueEntry> = {}): ApprovalQueueEntry {
  return {
    id,
    kind: 'permission',
    toolName: 'read_note',
    reason: '',
    riskLevel: 'low',
    inputPreview: '（无参数）',
    resolve: () => undefined,
    ...overrides,
  };
}

test('恰好一次：respond 成功后再次应答同一 id 是 no-op', () => {
  const queue = new ApprovalRequestQueue();
  const decisions: string[] = [];
  queue.add(entry('r1', { resolve: (decision) => decisions.push(decision) }));
  assert.equal(queue.respond('r1', 'allow'), true);
  assert.equal(queue.respond('r1', 'deny'), false, '重复应答必须被拒绝');
  assert.equal(queue.respond('r1', 'deny'), false);
  assert.deepEqual(decisions, ['allow'], 'resolve 只被调用一次');
  assert.equal(queue.size, 0);
});

test('并发入队：requestId 冲突保留先到者，两条请求互不覆盖', () => {
  const queue = new ApprovalRequestQueue();
  const resolved: string[] = [];
  queue.add(entry('same', { resolve: (decision, reason) => resolved.push(`first:${decision}:${reason ?? ''}`) }));
  queue.add(entry('same', { resolve: () => resolved.push('second') }));
  assert.equal(queue.size, 1, '重复 id 不入队');
  queue.respond('same', 'deny', 'busy');
  assert.deepEqual(resolved, ['first:deny:busy'], '应答必须给先到请求，不能给后来者');
});

test('denyAll：全部未决请求得到明确拒绝且队列清空', () => {
  const queue = new ApprovalRequestQueue();
  const resolved: string[] = [];
  queue.add(entry('a', { resolve: (decision, reason) => resolved.push(`a:${decision}:${reason ?? ''}`) }));
  queue.add(entry('b', { resolve: (decision, reason) => resolved.push(`b:${decision}:${reason ?? ''}`) }));
  queue.denyAll('session closed');
  assert.equal(queue.size, 0);
  assert.deepEqual(resolved, ['a:deny:session closed', 'b:deny:session closed']);
});

test('userInput 条目可携带 questions 与 content 应答', () => {
  const queue = new ApprovalRequestQueue();
  let received: { decision?: string; content?: unknown } = {};
  queue.add(entry('q1', {
    kind: 'userInput',
    questions: [{ question: '选择方案', options: [{ value: 'a', label: '方案 A' }, { value: 'b', label: '方案 B' }] }],
    resolve: (decision, _reason, content) => { received = { decision, content }; },
  }));
  queue.respond('q1', 'allow', undefined, { answers: [{ question: '选择方案', value: 'a' }] });
  assert.equal(received.decision, 'allow');
  assert.deepEqual(received.content, { answers: [{ question: '选择方案', value: 'a' }] });
});
