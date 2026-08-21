import assert from 'node:assert/strict';
import test from 'node:test';
import { TASK_TEMPLATES, createTaskCloseoutProjection } from '../src/components/workspace/task-templates-and-closeout.js';

const snapshot = { schemaVersion: 1, taskId: 'task-one', runId: 'run-one', profileId: 'plan' as const, authorityMode: 'review' as const, status: 'completed' as const, nodeOutcomes: { done: 'ok' as const }, attempt: 1, updatedAt: 1 };

test('模板目录仅包含静态目标和推荐工作方式，不携带执行或 Provider 字段', () => {
  assert.equal(TASK_TEMPLATES.length, 3);
  assert.deepEqual(Object.keys(TASK_TEMPLATES[0]!).sort(), ['authorityMode', 'goal', 'id', 'profileId', 'title']);
});

test('收尾审查仅在任务、审批、文件、ZIP 与引用均满足时标为可审查交付', () => {
  assert.equal(createTaskCloseoutProjection({ snapshot, fileCount: 1, deliveryCount: 1, citationCount: 1 }).ready, true);
  assert.equal(createTaskCloseoutProjection({ snapshot: { ...snapshot, status: 'blocked', nodeOutcomes: { approve: 'blocked' } }, fileCount: 1, deliveryCount: 1, citationCount: 1 }).ready, false);
  assert.equal(createTaskCloseoutProjection({ snapshot, fileCount: 1, deliveryCount: 0, citationCount: 1 }).ready, false);
});
