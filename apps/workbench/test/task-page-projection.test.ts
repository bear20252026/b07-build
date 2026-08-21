import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkbenchTaskSnapshot } from '../src/runtime/task-client.js';
import { createTaskPageProjection } from '../src/components/workspace/task-page-projection.js';

function snapshot(overrides: Partial<WorkbenchTaskSnapshot> = {}): WorkbenchTaskSnapshot {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    runId: 'run-1',
    profileId: 'build',
    authorityMode: 'review',
    status: 'running',
    nodeOutcomes: { plan: 'ok', review: 'blocked' },
    stats: { totalNodes: 2, startedNodes: 2, completedNodes: 1, failedNodes: 0, blockedNodes: 1, maxObservedConcurrency: 1 },
    attempt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('任务页把当前 task/run 投影为目标、执行、审查和成果四种固定工作块', () => {
  const projection = createTaskPageProjection({ snapshot: snapshot(), activeGoal: '整理项目交付', eventCount: 4, taskFileCount: 2, deliveryCount: 1 });

  assert.equal(projection.heading, '整理项目交付');
  assert.deepEqual(projection.blocks.map((block) => block.id), ['intent', 'execution', 'review', 'outcomes']);
  assert.equal(projection.blocks[1]?.tone, 'active');
  assert.match(projection.blocks[1]?.description ?? '', /1\/2/);
  assert.equal(projection.blocks[2]?.title, '存在待确认步骤');
  assert.equal(projection.blocks[3]?.title, '2 个受控文件');
});

test('失败或完成状态只改变摘要语义，不创建恢复、审批或交付副作用', () => {
  const failed = createTaskPageProjection({ snapshot: snapshot({ status: 'failed', nodeOutcomes: { execute: 'failed' }, stats: { totalNodes: 1, startedNodes: 1, completedNodes: 0, failedNodes: 1, blockedNodes: 0, maxObservedConcurrency: 1 } }), activeGoal: undefined, eventCount: 0, taskFileCount: 0, deliveryCount: 0 });
  const completed = createTaskPageProjection({ snapshot: snapshot({ status: 'completed', nodeOutcomes: { deliver: 'ok' }, stats: { totalNodes: 1, startedNodes: 1, completedNodes: 1, failedNodes: 0, blockedNodes: 0, maxObservedConcurrency: 1 } }), activeGoal: undefined, eventCount: 3, taskFileCount: 0, deliveryCount: 0 });

  assert.equal(failed.blocks[1]?.title, '运行需恢复');
  assert.equal(failed.blocks[1]?.tone, 'danger');
  assert.equal(completed.blocks[1]?.title, '运行已完成');
  assert.equal(completed.blocks[1]?.tone, 'success');
});
