import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpWorkbenchTaskClient } from '../src/runtime/task-client.js';

const snapshot = {
  schemaVersion: 1 as const,
  taskId: 'task-1',
  runId: 'run-1',
  profileId: 'build' as const,
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
  attempt: 1,
  updatedAt: 42,
};

test('HTTP 客户端仅发送意图并返回经验证的任务快照', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  let init: RequestInit | undefined;
  globalThis.fetch = (async (nextUrl, nextInit) => {
    url = String(nextUrl);
    init = nextInit;
    return Response.json(snapshot);
  }) as typeof fetch;
  try {
    const value = await new HttpWorkbenchTaskClient('/api/tasks').submit({ goal: '生成可恢复计划', profileId: 'build' });
    assert.equal(url, '/api/tasks');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { goal: '生成可恢复计划', profileId: 'build' });
    assert.equal(value.status, 'blocked');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('读取快照时保留 404 为缺失语义，并拒绝未知快照版本', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  try {
    assert.equal(await new HttpWorkbenchTaskClient().snapshot('task-1', 'run-1'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json({ ...snapshot, schemaVersion: 2 })) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().snapshot('task-1', 'run-1'), /不兼容/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
