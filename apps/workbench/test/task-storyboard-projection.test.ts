import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskStoryboardProjection } from '../src/components/workspace/task-storyboard-projection.js';

const blockedSnapshot = {
  schemaVersion: 1 as const,
  taskId: 'task-1',
  runId: 'run-1',
  profileId: 'build' as const,
  authorityMode: 'review' as const,
  status: 'blocked' as const,
  nodeOutcomes: { inspect: 'ok' as const, write: 'blocked' as const },
  stats: {
    totalNodes: 2,
    startedNodes: 2,
    completedNodes: 1,
    failedNodes: 0,
    blockedNodes: 1,
    maxObservedConcurrency: 1,
  },
  attempt: 2,
  updatedAt: 10,
};

test('任务故事板在未创建任务时不伪造运行、文件或审批状态', () => {
  const value = createTaskStoryboardProjection({ snapshot: undefined, eventCount: 99, taskFileCount: 99, deliveryCount: 99 });

  assert.equal(value.blocks.length, 4);
  assert.deepEqual(value.blocks.map((block) => block.id), ['context', 'execution', 'review', 'deliverables']);
  assert.equal(value.blocks[0]?.title, '等待任务意图');
  assert.equal(value.blocks[3]?.meta, '0 个文件 · 0 个交付包');
});

test('任务故事板将阻塞状态投影为需要明确确认，而不提供绕过审批的动作', () => {
  const value = createTaskStoryboardProjection({ snapshot: blockedSnapshot, eventCount: 3, taskFileCount: 2, deliveryCount: 1 });
  const execution = value.blocks.find((block) => block.id === 'execution');
  const review = value.blocks.find((block) => block.id === 'review');
  const deliverables = value.blocks.find((block) => block.id === 'deliverables');

  assert.equal(execution?.title, '运行已暂停');
  assert.equal(execution?.meta, '1/2 个步骤完成 · 3 个活动事件');
  assert.equal(review?.title, '等待明确确认');
  assert.equal(review?.tone, 'attention');
  assert.equal(deliverables?.meta, '2 个文件 · 1 个交付包');
  assert.match(review?.description ?? '', /检查/);
  assert.doesNotMatch(JSON.stringify(value), /api.?key|credential|endpoint|absolutePath|resumeCommand/i);
});

test('任务故事板分别标记失败与完成，且不将活动事件解释为可重放操作', () => {
  const failed = createTaskStoryboardProjection({
    snapshot: { ...blockedSnapshot, status: 'failed', stats: { ...blockedSnapshot.stats, failedNodes: 1, blockedNodes: 0 } },
    eventCount: 4,
    taskFileCount: 0,
    deliveryCount: 0,
  });
  const complete = createTaskStoryboardProjection({
    snapshot: { ...blockedSnapshot, status: 'completed', stats: { ...blockedSnapshot.stats, completedNodes: 2, blockedNodes: 0 } },
    eventCount: 5,
    taskFileCount: 1,
    deliveryCount: 1,
  });

  assert.equal(failed.blocks.find((block) => block.id === 'execution')?.tone, 'danger');
  assert.equal(failed.blocks.find((block) => block.id === 'review')?.title, '需要人工复核');
  assert.equal(complete.blocks.find((block) => block.id === 'execution')?.tone, 'complete');
  assert.equal(complete.blocks.find((block) => block.id === 'deliverables')?.tone, 'complete');
  assert.match(complete.blocks.find((block) => block.id === 'execution')?.description ?? '', /不能重放副作用/);
});
