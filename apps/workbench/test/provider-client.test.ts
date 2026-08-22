import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpWorkbenchTaskClient } from '../src/runtime/task-client.js';

const CUSTOM_PROVIDER_ID = 'custom-12345678';
const CUSTOM_PROFILE_ID = 'session.custom-12345678';
const OUTPUT = '自定义模型连接正常';
const OUTPUT_DIGEST = 'a'.repeat(64);

test('Workbench Provider client 接受 Gateway 返回的 session.custom 推理结果且不放宽其他字段契约', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      schemaVersion: 1,
      providerId: CUSTOM_PROVIDER_ID,
      profileId: CUSTOM_PROFILE_ID,
      profileRevision: 1,
      model: 'owner-model-v1',
      dataBoundary: 'remote-allowed',
      output: OUTPUT,
      outputDigest: OUTPUT_DIGEST,
      outputCharacters: OUTPUT.length,
      latencyMs: 12,
      canReadSecret: false,
      canAutoExecuteTools: false,
      canAutoConnect: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = new HttpWorkbenchTaskClient(
      '/api/tasks', '/api/local-models/health', '/api/control-plane/diagnostics', '/api/security-posture/audit',
      '/api/components/lock-report', '/api/components/management-receipts', '/api/native-host-authentication',
      '/api/windows/native-release-evidence', '/api/providers/connections',
    );
    const result = await client.inferProviderConnection(CUSTOM_PROVIDER_ID, '验证一次自定义模型');
    assert.equal(requestUrl, `/api/providers/connections/${CUSTOM_PROVIDER_ID}/infer`);
    assert.equal(requestBody.includes('验证一次自定义模型'), true);
    assert.equal(result.profileId, CUSTOM_PROFILE_ID);
    assert.equal(result.output, OUTPUT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Workbench Provider client 仍拒绝伪造的 custom profileId', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    schemaVersion: 1,
    providerId: CUSTOM_PROVIDER_ID,
    profileId: 'session.custom-invalid',
    profileRevision: 1,
    model: 'owner-model-v1',
    dataBoundary: 'remote-allowed',
    output: OUTPUT,
    outputDigest: OUTPUT_DIGEST,
    outputCharacters: OUTPUT.length,
    latencyMs: 12,
    canReadSecret: false,
    canAutoExecuteTools: false,
    canAutoConnect: false,
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const client = new HttpWorkbenchTaskClient(
      '/api/tasks', '/api/local-models/health', '/api/control-plane/diagnostics', '/api/security-posture/audit',
      '/api/components/lock-report', '/api/components/management-receipts', '/api/native-host-authentication',
      '/api/windows/native-release-evidence', '/api/providers/connections',
    );
    await assert.rejects(() => client.inferProviderConnection(CUSTOM_PROVIDER_ID, '验证拒绝'), /供应商推理结果包含未声明/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
