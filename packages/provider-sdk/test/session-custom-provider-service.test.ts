import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvironmentCredentialResolver, SessionCredentialResolver } from '../src/credential-resolver.js';
import { SessionCustomProviderService } from '../src/session-custom-provider-service.js';

function credentials(): SessionCredentialResolver {
  return new SessionCredentialResolver(new EnvironmentCredentialResolver(() => undefined));
}

test('custom OpenAI-compatible provider 只保存会话 metadata，按固定 HTTPS base URL 聚合 SSE 且绝不回显 key 或 endpoint', async () => {
  const resolver = credentials();
  const service = new SessionCustomProviderService(resolver);
  const status = service.configureSession({
    displayName: '我的兼容模型', protocol: 'openai-compatible', baseUrl: 'https://models.example.test/v1/', model: 'owner-model-v1', apiKey: 'sk-custom-session-only',
  });
  assert.match(status.providerId, /^custom-[a-z0-9-]+$/);
  assert.equal(status.profileStatus, 'active');
  assert.match(status.credentialReference, /^session\.custom-[a-z0-9-]+$/);
  assert.equal(JSON.stringify(status).includes('models.example.test'), false);
  assert.equal(JSON.stringify(status).includes('sk-custom-session-only'), false);

  const originalFetch = globalThis.fetch;
  let target = '';
  let authorization = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
    return new Response('data: {"choices":[{"delta":{"content":"custom "}}]}\n\ndata: {"choices":[{"delta":{"content":"output"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const result = await service.infer({ providerId: status.providerId, prompt: 'hello custom provider' });
    assert.equal(target, 'https://models.example.test/v1/chat/completions');
    assert.equal(authorization, 'Bearer sk-custom-session-only');
    assert.equal(result.output, 'custom output');
    assert.equal(result.model, 'owner-model-v1');
    assert.equal(JSON.stringify(result).includes('models.example.test'), false);
    assert.equal(JSON.stringify(result).includes('sk-custom-session-only'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('custom Anthropic-compatible provider 使用标准 messages 端点和 x-api-key，而不会暴露 endpoint', async () => {
  const service = new SessionCustomProviderService(credentials());
  const status = service.configureSession({
    displayName: '我的 Anthropic 兼容模型', protocol: 'anthropic-compatible', baseUrl: 'https://anthropic-gateway.example.test', model: 'owner-anthropic-v1', apiKey: 'sk-anthropic-session-only',
  });
  const originalFetch = globalThis.fetch;
  let target = '';
  let apiKey = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    apiKey = String((init?.headers as Record<string, string> | undefined)?.['x-api-key'] ?? '');
    return new Response('data: {"type":"content_block_delta","delta":{"text":"anthropic output"}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const result = await service.infer({ providerId: status.providerId, prompt: 'hello custom anthropic provider' });
    assert.equal(target, 'https://anthropic-gateway.example.test/v1/messages');
    assert.equal(apiKey, 'sk-anthropic-session-only');
    assert.equal(result.output, 'anthropic output');
    assert.equal(JSON.stringify(status).includes('anthropic-gateway.example.test'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('custom Provider 拒绝非 HTTPS、IP/localhost/私网标记、完整操作路径与 URL 凭据', () => {
  const service = new SessionCustomProviderService(credentials());
  const invalidUrls = [
    'http://models.example.test/v1',
    'https://127.0.0.1/v1',
    'https://localhost/v1',
    'https://owner:secret@models.example.test/v1',
    'https://models.example.test/v1/chat/completions',
    'https://models.example.test/v1?override=1',
    'https://models.local/v1',
  ];
  for (const baseUrl of invalidUrls) {
    assert.throws(() => service.configureSession({ displayName: '拒绝测试', protocol: 'openai-compatible', baseUrl, model: 'safe-model-v1', apiKey: 'sk-invalid-session-only' }));
  }
});

test('custom Provider 只存在于当前 Gateway 会话，新的 service instance 不会恢复 endpoint 或 credential', () => {
  const first = new SessionCustomProviderService(credentials());
  const configured = first.configureSession({ displayName: '临时模型', protocol: 'openai-compatible', baseUrl: 'https://ephemeral.example.test/v1', model: 'ephemeral-model-v1', apiKey: 'sk-ephemeral-session-only' });
  assert.equal(first.list().length, 1);
  const second = new SessionCustomProviderService(credentials());
  assert.equal(second.list().length, 0);
  assert.rejects(second.infer({ providerId: configured.providerId, prompt: 'must fail' }));
});
