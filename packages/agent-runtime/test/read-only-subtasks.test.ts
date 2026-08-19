import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  InMemorySubtaskSnapshotStore,
  ReadOnlySubtaskPolicy,
  ReadOnlySubtaskService,
  SqliteSubtaskSnapshotStore,
} from '../src/index.js';

const request = {
  subtaskId: 'subtask-0001',
  parentTaskId: 'task-parent',
  parentRunId: 'run-parent',
  role: 'explore' as const,
  goal: '只读检查当前工作区并生成引用摘要。',
  budget: { maxInputTokens: 800, maxOutputTokens: 80, maxToolCalls: 3 },
  at: 100,
};

const worker = {
  async run(context: Parameters<Parameters<ReadOnlySubtaskService['run']>[1]['run']>[0]) {
    assert.equal(context.policy.evaluate({
      capability: 'filesystem.read', risk: 'low', taskId: context.parentTaskId, runId: context.parentRunId, actionId: 'read-1',
    }).decision, 'allow');
    assert.equal(context.policy.evaluate({
      capability: 'filesystem.write', risk: 'low', taskId: context.parentTaskId, runId: context.parentRunId, actionId: 'write-1',
    }).decision, 'deny');
    assert.equal(context.policy.evaluate({
      capability: 'network.fetch', risk: 'low', taskId: context.parentTaskId, runId: context.parentRunId, actionId: 'network-1',
    }).decision, 'deny');
    assert.deepEqual(context.allowedCapabilities, ['document.parse', 'model.chat', 'filesystem.read']);
    return {
      summary: '检查完成：仅发现本地只读配置与可追溯来源。',
      estimatedOutputTokens: 12,
      citations: [{ kind: 'workspace' as const, sourceId: 'source-001', sourceUri: 'file:///workspace/config.md', excerpt: '只读配置。' }],
    };
  },
};

test('只读策略只能允许解析、模型和文件读取，所有副作用能力稳定拒绝', () => {
  const policy = new ReadOnlySubtaskPolicy();
  for (const capability of ['filesystem.write', 'network.fetch', 'shell.execute', 'browser.control'] as const) {
    assert.equal(policy.evaluate({ capability, risk: 'high', taskId: 'task-parent', runId: 'run-parent', actionId: capability }).decision, 'deny');
  }
});

test('Explore 子任务只向父任务回传已完成的摘要和 citation，重放不会二次运行', async () => {
  const store = new InMemorySubtaskSnapshotStore();
  const runtime = new ReadOnlySubtaskService(store);
  runtime.spawn(request);
  assert.throws(() => runtime.summaryReference(request.subtaskId), /已完成/);

  const completed = await runtime.run(request.subtaskId, worker, 110);
  assert.equal(completed.status, 'completed');
  assert.equal(store.history(request.subtaskId).length, 3);
  const reference = runtime.summaryReference(request.subtaskId);
  assert.deepEqual(reference, {
    subtaskId: 'subtask-0001', parentTaskId: 'task-parent', parentRunId: 'run-parent', role: 'explore',
    summary: '检查完成：仅发现本地只读配置与可追溯来源。',
    citations: [{ kind: 'workspace', sourceId: 'source-001', sourceUri: 'file:///workspace/config.md', excerpt: '只读配置。' }],
    estimatedTokens: 12, canAuthorize: false,
  });
  const replay = await runtime.run(request.subtaskId, worker, 120);
  assert.equal(replay.revision, completed.revision);
  assert.equal(store.history(request.subtaskId).length, 3);
});

test('超出独立摘要预算会记录 failed 终态，且不会泄露为父任务摘要', async () => {
  const runtime = new ReadOnlySubtaskService(new InMemorySubtaskSnapshotStore());
  runtime.spawn({ ...request, subtaskId: 'subtask-budget', at: 200 });
  const failed = await runtime.run('subtask-budget', {
    async run() {
      return {
        summary: '预算超限结果。', estimatedOutputTokens: 81,
        citations: [{ kind: 'task_output', sourceId: 'source-002', sourceUri: 'local://task/output', excerpt: '结果。' }],
      };
    },
  }, 210);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'output_rejected');
  assert.throws(() => runtime.summaryReference('subtask-budget'), /已完成/);
});

test('SQLite 子任务快照追加完整历史并能在重开后提供父级摘要引用', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-read-only-subtasks-'));
  const filePath = join(directory, 'subtasks.sqlite');
  try {
    const store = new SqliteSubtaskSnapshotStore(filePath);
    const runtime = new ReadOnlySubtaskService(store);
    runtime.spawn({ ...request, subtaskId: 'subtask-sqlite', at: 300 });
    await runtime.run('subtask-sqlite', worker, 310);
    assert.equal(store.history('subtask-sqlite').length, 3);
    store.close();

    const reopenedStore = new SqliteSubtaskSnapshotStore(filePath);
    const reopened = new ReadOnlySubtaskService(reopenedStore);
    assert.equal(reopened.summaryReference('subtask-sqlite').canAuthorize, false);
    assert.equal(reopenedStore.history('subtask-sqlite')[0]?.status, 'created');
    reopenedStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
