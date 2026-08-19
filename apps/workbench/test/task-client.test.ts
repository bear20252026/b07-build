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
    const value = await new HttpWorkbenchTaskClient('/api/tasks').submit({ goal: '生成可恢复计划', profileId: 'build', authorityMode: 'review' });
    assert.equal(url, '/api/tasks');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { schemaVersion: 1, goal: '生成可恢复计划', profileId: 'build', authorityMode: 'review' });
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

test('运行轨迹客户端只读取经验证的不可执行 metadata 并按 sequence 排序', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([
    { schemaVersion: 1, trajectoryEventId: 'trajectory-2', taskId: 'task-1', runId: 'run-1', sequence: 2, at: 2, source: 'task-runtime', kind: 'task.completed', attributes: { completed: true }, canReplaySideEffects: false },
    { schemaVersion: 1, trajectoryEventId: 'trajectory-1', taskId: 'task-1', runId: 'run-1', sequence: 1, at: 1, source: 'gateway.intent', kind: 'task.created', attributes: { goalDigest: 'abc' }, canReplaySideEffects: false },
  ])) as typeof fetch;
  try {
    const trajectory = await new HttpWorkbenchTaskClient().trajectory('task-1', 'run-1');
    assert.deepEqual(trajectory.map((event) => event.sequence), [1, 2]);
    assert.equal(trajectory.every((event) => event.canReplaySideEffects === false), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('运行轨迹客户端拒绝可执行或未声明来源的 payload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([
    { schemaVersion: 1, trajectoryEventId: 'trajectory-unsafe', taskId: 'task-1', runId: 'run-1', sequence: 1, at: 1, source: 'untrusted', kind: 'task.created', attributes: {}, canReplaySideEffects: true },
  ])) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().trajectory('task-1', 'run-1'), /不兼容/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('本地模型健康客户端仅读取脱敏摘要、按 endpoint ID 排序并拒绝 URL 泄露', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (nextUrl) => {
    url = String(nextUrl);
    return Response.json([
      { schemaVersion: 1, id: 'z-local', configuredModelId: 'z-model', offline: false, health: { status: 'unknown', modelIds: [] } },
      { schemaVersion: 1, id: 'a-local', configuredModelId: 'a-model', offline: true, health: { status: 'unhealthy', checkedAt: 12, modelIds: [], error: 'offline' } },
    ]);
  }) as typeof fetch;
  try {
    const models = await new HttpWorkbenchTaskClient().localModelHealth();
    assert.equal(url, '/api/local-models/health');
    assert.deepEqual(models.map((model) => model.id), ['a-local', 'z-local']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json([
    { schemaVersion: 1, id: 'unsafe', configuredModelId: 'model', offline: false, baseUrl: 'http://127.0.0.1:11434', health: { status: 'healthy', modelIds: [] } },
  ])) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().localModelHealth(), /不兼容/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('控制面诊断客户端只读取冷路径脱敏报告，并拒绝敏感或可执行字段', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  const report = {
    schemaVersion: 1, generatedAt: 1, canExecute: false,
    authority: { adminIssuance: 'trusted-desktop-host-required', browserCanIssue: false, canExecute: false },
    extensions: [{ id: 'extension-1', kind: 'tool-adapter', status: 'reviewed', revision: 1, dataBoundary: 'local-only', declaredCapabilities: ['filesystem.read'], findings: [{ severity: 'info', code: 'REVIEW_REQUIRED' }], canExecute: false }],
    skillPacks: [{ id: 'skill-1', status: 'published', revision: 1, version: '1.0.0', estimatedTokens: 100, canAuthorize: false, canGrantCapabilities: false }],
    providers: [{ id: 'provider-1', status: 'active', revision: 1, dataBoundary: 'local-only', driverIds: ['local-openai'] }],
    localModels: [{ id: 'model-1', configuredModelId: 'model', offline: false, healthStatus: 'healthy', checkedAt: 1, modelIds: ['model'] }],
    trustedDesktopIssuers: [{ issuerId: 'host-1', displayName: 'Local Host', platform: 'windows', status: 'trusted', revision: 2, canExecute: false }],
  };
  globalThis.fetch = (async (nextUrl) => { url = String(nextUrl); return Response.json(report); }) as typeof fetch;
  try {
    const value = await new HttpWorkbenchTaskClient().controlPlaneDiagnostics();
    assert.equal(url, '/api/control-plane/diagnostics');
    assert.equal(value.authority.browserCanIssue, false);
    assert.equal(value.extensions[0].canExecute, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json({ ...report, providers: [{ ...report.providers[0], endpointUrl: 'http://127.0.0.1:11434' }] })) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().controlPlaneDiagnostics(), /未声明或敏感/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
