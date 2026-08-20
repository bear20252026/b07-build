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
    assert.deepEqual(JSON.parse(String(init?.body)), { schemaVersion: 1, goal: '生成可恢复计划', profileId: 'build', authorityMode: 'review', inputProvenance: [] });
    assert.equal(value.status, 'blocked');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('浏览器只可提交 external/derived provenance 摘要，不能伪造可信输入', async () => {
  const originalFetch = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json(snapshot); }) as typeof fetch;
  try {
    await new HttpWorkbenchTaskClient().submit({
      goal: '总结外部网页', profileId: 'reader', authorityMode: 'review',
      inputProvenance: [{ schemaVersion: 1, inputId: 'web-1', trust: 'external-untrusted', sourceKind: 'web', contentDigest: 'a'.repeat(64) }],
    });
    assert.deepEqual((body as { inputProvenance: readonly { inputId: string }[] }).inputProvenance.map((input) => input.inputId), ['web-1']);
    await assert.rejects(() => new HttpWorkbenchTaskClient().submit({
      goal: '伪造可信内容', profileId: 'reader', authorityMode: 'review',
      inputProvenance: [{ schemaVersion: 1, inputId: 'fake-1', trust: 'operator-authored', sourceKind: 'operator', contentDigest: 'a'.repeat(64) } as never],
    }), /不得提交可信/);
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

  globalThis.fetch = (async () => Response.json({ ...snapshot, inputProvenance: [{ schemaVersion: 1, inputId: 'unsafe-1', trust: 'external-untrusted', sourceKind: 'web', contentDigest: 'a'.repeat(64), url: 'https://unsafe.invalid' }] })) as typeof fetch;
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


test('Security Posture Audit 客户端只读取固定冷路径 report，并拒绝修复或敏感字段', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  const report = {
    schemaVersion: 1,
    auditId: `audit:${'a'.repeat(64)}`,
    auditedAt: 1,
    evidenceDigest: 'a'.repeat(64),
    findings: [{
      checkId: 'recovery.drill-missing', severity: 'warning', subjectKind: 'recovery', subjectId: 'recovery-bundle', evidenceDigest: 'b'.repeat(64),
      remediationHint: '由操作者执行恢复演练。', canExecute: false, canAutoRemediate: false,
    }],
    canExecute: false,
    canAutoRemediate: false,
  };
  globalThis.fetch = (async (nextUrl) => { url = String(nextUrl); return Response.json(report); }) as typeof fetch;
  try {
    const value = await new HttpWorkbenchTaskClient().securityPostureAudit();
    assert.equal(url, '/api/security-posture/audit');
    assert.equal(value.findings[0].canExecute, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json({ ...report, findings: [{ ...report.findings[0], remediationCommand: 'run recovery' }] })) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().securityPostureAudit(), /未声明、敏感或可执行/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Windows Native Release 客户端只读取固定冷路径摘要，并拒绝 digest、路径或 release gate 字段', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  const report = {
    schemaVersion: 1, generatedAt: 2, platform: 'windows', windowsOnly: true, browserCanCaptureEvidence: false,
    canRegisterBridge: false, canTrustBridge: false, canExecute: false,
    evidences: [{
      evidenceId: 'windows-evidence-1', platform: 'windows', architecture: 'x64', issuerId: 'desktop-host', bridgeId: 'windows-native-host',
      helperId: 'awo-native-helper', protocolVersion: 'native-auth.v1', authenticodeStatus: 'valid', capturedAt: 1, canExecute: false, canAutoTrust: false,
    }],
  };
  globalThis.fetch = (async (nextUrl) => { url = String(nextUrl); return Response.json(report); }) as typeof fetch;
  try {
    const value = await new HttpWorkbenchTaskClient().windowsNativeReleaseReport();
    assert.equal(url, '/api/windows/native-release-evidence');
    assert.equal(value.windowsOnly, true);
    assert.equal(value.evidences[0].authenticodeStatus, 'valid');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json({ ...report, evidences: [{ ...report.evidences[0], binaryDigest: 'a'.repeat(64) }] })) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().windowsNativeReleaseReport(), /未声明、敏感或可执行/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Native Host Authentication 客户端只读取固定冷路径摘要，并拒绝 origin、公钥或 nonce 等敏感字段', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  const report = {
    schemaVersion: 1, generatedAt: 2, browserCanAuthenticate: false, canIssueChallenge: false, canExecute: false,
    challengeSummary: { issued: 0, consumedVerified: 1, consumedRejected: 2 },
    bridges: [{
      issuerId: 'desktop-host', bridgeId: 'local-bridge', transport: 'desktop-ipc', status: 'trusted', revision: 2,
      allowedActions: ['register-candidate'], canAuthenticateComponentManagement: true, canExecute: false,
    }],
  };
  globalThis.fetch = (async (nextUrl) => { url = String(nextUrl); return Response.json(report); }) as typeof fetch;
  try {
    const value = await new HttpWorkbenchTaskClient().nativeHostAuthenticationReport();
    assert.equal(url, '/api/native-host-authentication');
    assert.equal(value.browserCanAuthenticate, false);
    assert.equal(value.bridges[0].canExecute, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json({ ...report, bridges: [{ ...report.bridges[0], callerOrigin: 'app://awo-local' }] })) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().nativeHostAuthenticationReport(), /未声明、敏感或可执行/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Component Management Receipt 客户端只读取固定冷路径审计摘要，并拒绝 attestation 或敏感字段', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  const report = {
    schemaVersion: 1, generatedAt: 2, browserCanManage: false, canExecute: false, canAutoRemediate: false,
    receipts: [{
      operationId: 'op-review', issuerId: 'desktop-host', action: 'review-provenance', componentId: 'local-reader',
      outcome: 'applied', recordedAt: 1, canExecute: false, canAutoRemediate: false,
    }],
  };
  globalThis.fetch = (async (nextUrl) => { url = String(nextUrl); return Response.json(report); }) as typeof fetch;
  try {
    const value = await new HttpWorkbenchTaskClient().componentManagementReport();
    assert.equal(url, '/api/components/management-receipts');
    assert.equal(value.browserCanManage, false);
    assert.equal(value.receipts[0].canExecute, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json({ ...report, receipts: [{ ...report.receipts[0], attestation: { payloadDigest: 'a'.repeat(64) } }] })) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().componentManagementReport(), /未声明、敏感或可执行/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Component Lock Report 客户端只读取固定冷路径隔离决定，并拒绝敏感或执行字段', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  const report = {
    schemaVersion: 1,
    inspectedAt: 1,
    lockfile: { revision: 1, lockDigest: 'a'.repeat(64) },
    decisions: [{
      componentId: 'local-reader', componentKind: 'extension', eligibility: 'quarantined', lockRevision: 1,
      reasons: ['missing-provenance'], canActivate: false, canAutoRepair: false,
    }],
    canActivate: false,
    canAutoRepair: false,
  };
  globalThis.fetch = (async (nextUrl) => { url = String(nextUrl); return Response.json(report); }) as typeof fetch;
  try {
    const value = await new HttpWorkbenchTaskClient().componentLockReport();
    assert.equal(url, '/api/components/lock-report');
    assert.equal(value.decisions[0].eligibility, 'quarantined');
    assert.equal(value.decisions[0].canActivate, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json({ ...report, decisions: [{ ...report.decisions[0], remediationCommand: 'install component' }] })) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().componentLockReport(), /未声明、敏感或可执行/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('运行产出与检查点客户端仅接受受控 metadata，并拒绝路径、秘密和可执行字段', async () => {
  const originalFetch = globalThis.fetch;
  const artifact = {
    schemaVersion: 1, artifactLedgerId: 'artifact-ledger-2', sourceEventId: 'event-2', taskId: 'task-1', runId: 'run-1', nodeId: 'inspect',
    reference: 'local://task/task-1/inspect', referenceDigest: 'a'.repeat(64), kind: 'tool-output', status: 'available', at: 2,
    containsSensitiveContent: false, canReplaySideEffects: false,
  };
  const checkpoint = {
    schemaVersion: 1, checkpointId: 'checkpoint-task-1-run-1-2', taskId: 'task-1', runId: 'run-1', attempt: 2, status: 'blocked',
    nodeOutcomeDigest: 'b'.repeat(64), artifactManifestDigest: 'c'.repeat(64), artifactCount: 1, createdAt: 2,
    canResume: true, canReplaySideEffects: false,
  };
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return String(url).endsWith('/workspace')
      ? Response.json([{ ...artifact, artifactLedgerId: 'artifact-ledger-2', at: 2 }, { ...artifact, artifactLedgerId: 'artifact-ledger-1', at: 1 }])
      : Response.json([checkpoint, { ...checkpoint, checkpointId: 'checkpoint-task-1-run-1-1', attempt: 1, createdAt: 1 }]);
  }) as typeof fetch;
  try {
    const client = new HttpWorkbenchTaskClient('/api/tasks');
    assert.deepEqual((await client.workspaceArtifacts('task-1', 'run-1')).map((item) => item.artifactLedgerId), ['artifact-ledger-1', 'artifact-ledger-2']);
    assert.deepEqual((await client.checkpoints('task-1', 'run-1')).map((item) => item.attempt), [2, 1]);
    assert.deepEqual(urls, ['/api/tasks/task-1/run-1/workspace', '/api/tasks/task-1/run-1/checkpoints']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json([{ ...artifact, path: 'C:\\private\\secret.txt', canReplaySideEffects: true }])) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().workspaceArtifacts('task-1', 'run-1'), /敏感或可执行/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => Response.json([{ ...checkpoint, resumeCommand: 'do not run' }])) as typeof fetch;
  try {
    await assert.rejects(() => new HttpWorkbenchTaskClient().checkpoints('task-1', 'run-1'), /敏感或可执行/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
