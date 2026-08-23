import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLocalGateway } from '../src/gateway-application.js';

const DATABASE_VARIABLES = [
  'AWO_SNAPSHOT_DB', 'AWO_KNOWLEDGE_WORKSPACE_DB', 'AWO_KNOWLEDGE_WORKSPACE_DIR', 'AWO_RECEIPT_DB', 'AWO_SUBTASK_DB', 'AWO_MCP_MANIFEST_DB',
  'AWO_EXTENSION_MANIFEST_DB', 'AWO_EXTENSION_PLAN_DB', 'AWO_PROVIDER_PROFILE_DB', 'AWO_API_USAGE_DB', 'AWO_BROWSER_SESSION_DB', 'AWO_SKILL_PACK_DB', 'AWO_KNOWLEDGE_IMPORT_DB', 'AWO_AGENT_ADAPTER_MANIFEST_DB',
  'AWO_AGENT_ADAPTER_SESSION_DB', 'AWO_AGENT_ADAPTER_MAILBOX_DB', 'AWO_SCHEDULE_MANIFEST_DB', 'AWO_SCHEDULE_RUN_DB', 'AWO_RUN_TRAJECTORY_DB', 'AWO_PROJECT_WORKSPACE_DB',
  'AWO_ADMINISTRATOR_LEASE_DB', 'AWO_TRUSTED_DESKTOP_ISSUER_DB', 'AWO_COMPONENT_PROVENANCE_DB', 'AWO_COMPONENT_LOCKFILE_DB',
  'AWO_COMPONENT_MANAGEMENT_RECEIPT_DB', 'AWO_NATIVE_HOST_BRIDGE_TRUST_DB', 'AWO_NATIVE_HOST_CHALLENGE_DB', 'AWO_WINDOWS_NATIVE_RELEASE_EVIDENCE_DB',
] as const;

async function withGateway<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'awo-provider-connection-http-'));
  const previous = new Map<string, string | undefined>();
  for (const key of DATABASE_VARIABLES) {
    previous.set(key, process.env[key]);
    process.env[key] = join(root, `${key.toLowerCase()}.sqlite`);
  }
  process.env.AWO_KNOWLEDGE_WORKSPACE_DIR = join(root, 'knowledge-workspaces');
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-never-returned';
  const app = startLocalGateway(0);
  try {
    return await run(`http://127.0.0.1:${await app.ready}`);
  } finally {
    await app.close();
    for (const key of DATABASE_VARIABLES) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
}

test('Provider connections API 只投影脱敏目录，注册与激活均需要显式 operator intent', async () => {
  await withGateway(async (baseUrl) => {
    const listed = await fetch(`${baseUrl}/api/providers/connections`);
    assert.equal(listed.status, 200);
    const catalog = await listed.json() as readonly Record<string, unknown>[];
    assert.equal(catalog.length >= 6, true);
    const openai = catalog.find((item) => item.providerId === 'openai');
    assert.deepEqual(Object.keys(openai ?? {}).sort(), ['canAutoConnect', 'canReadSecret', 'credentialAvailability', 'credentialReference', 'defaultModel', 'displayName', 'driverId', 'profileStatus', 'providerId', 'schemaVersion']);
    assert.equal(JSON.stringify(catalog).includes('sk-test-never-returned'), false);
    assert.equal(JSON.stringify(catalog).includes('https://api.openai.com'), false);

    const prohibited = await fetch(`${baseUrl}/api/providers/connections/openai/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewedBy: 'desktop-owner' }) });
    assert.equal(prohibited.status, 403);
    const badBody = await fetch(`${baseUrl}/api/providers/connections/openai/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' }, body: JSON.stringify({ reviewedBy: 'desktop-owner', apiKey: 'forbidden' }) });
    assert.equal(badBody.status, 400);

    const registered = await fetch(`${baseUrl}/api/providers/connections/openai/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' }, body: JSON.stringify({ reviewedBy: 'desktop-owner' }) });
    assert.equal(registered.status, 201);
    assert.equal((await registered.json() as { profileStatus: string }).profileStatus, 'registered');
    const activated = await fetch(`${baseUrl}/api/providers/connections/openai/activate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' }, body: JSON.stringify({ reviewedBy: 'desktop-owner' }) });
    assert.equal(activated.status, 200);
    const active = await activated.json() as Record<string, unknown>;
    assert.equal(active.profileStatus, 'active');
    assert.equal(JSON.stringify(active).includes('sk-test-never-returned'), false);
  });
});

test('Provider session configuration 仅接收白名单字段并且绝不回显浏览器提交的 API key', async () => {
  await withGateway(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
    const malformed = await fetch(`${baseUrl}/api/providers/connections/openai/configure-session`, { method: 'POST', headers, body: JSON.stringify({ displayName: '我的连接', model: 'gpt-safe', apiKey: 'sk-browser-session-only', endpoint: 'https://forbidden.example' }) });
    assert.equal(malformed.status, 400);
    const malformedAddress = await fetch(`${baseUrl}/api/providers/connections/openai/configure-session`, { method: 'POST', headers, body: JSON.stringify({ apiKey: 'sk-browser-session-only', baseUrl: 'http://localhost:4318/v1' }) });
    assert.equal(malformedAddress.status, 400);
    const configured = await fetch(`${baseUrl}/api/providers/connections/openai/configure-session`, { method: 'POST', headers, body: JSON.stringify({ displayName: '我的连接', model: 'gpt-safe', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-browser-session-only' }) });
    assert.equal(configured.status, 200);
    const status = await configured.json() as Record<string, unknown>;
    assert.equal(status.displayName, '我的连接');
    assert.equal(status.defaultModel, 'gpt-safe');
    assert.equal(status.profileStatus, 'active');
    assert.equal(JSON.stringify(status).includes('sk-browser-session-only'), false);
    assert.equal(JSON.stringify(status).includes('https://api.openai.com'), false);
    const listed = await (await fetch(`${baseUrl}/api/providers/connections`)).text();
    assert.equal(listed.includes('sk-browser-session-only'), false);
    assert.equal(listed.includes('https://api.openai.com'), false);
  });
});

test('Provider infer API 只在显式激活后调用受控 Driver，并以脱敏会话结果返回流式文本', async () => {
  await withGateway(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
    const originalFetch = globalThis.fetch;
    let authorization = '';
    let remoteBody = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (target === 'https://api.openai.com/v1/chat/completions') {
        authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
        remoteBody = String(init?.body ?? '');
        return new Response('data: {"choices":[{"delta":{"content":"gateway "}}]}\n\ndata: {"choices":[{"delta":{"content":"output"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const malformed = await fetch(`${baseUrl}/api/providers/connections/openai/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', apiKey: 'forbidden' }) });
      assert.equal(malformed.status, 400);
      const beforeActivation = await fetch(`${baseUrl}/api/providers/connections/openai/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }) });
      assert.equal(beforeActivation.status, 400);
      assert.equal(authorization, '');
      assert.equal((await fetch(`${baseUrl}/api/providers/connections/openai/register`, { method: 'POST', headers, body: JSON.stringify({ reviewedBy: 'desktop-owner' }) })).status, 201);
      assert.equal((await fetch(`${baseUrl}/api/providers/connections/openai/activate`, { method: 'POST', headers, body: JSON.stringify({ reviewedBy: 'desktop-owner' }) })).status, 200);
      const inferred = await fetch(`${baseUrl}/api/providers/connections/openai/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello from workbench' }) });
      assert.equal(inferred.status, 200);
      const result = await inferred.json() as Record<string, unknown>;
      assert.equal(result.output, 'gateway output');
      assert.equal(result.model, 'gpt-5.6');
      assert.equal(result.canReadSecret, false);
      assert.equal(result.canAutoExecuteTools, false);
      assert.equal(result.canAutoConnect, false);
      assert.equal(JSON.stringify(result).includes('sk-test-never-returned'), false);
      assert.equal(JSON.stringify(result).includes('https://api.openai.com'), false);
      assert.equal(authorization, 'Bearer sk-test-never-returned');
      assert.equal(remoteBody.includes('hello from workbench'), true);
      assert.equal(remoteBody.includes('sk-test-never-returned'), false);
      const usageSummary = await (await fetch(`${baseUrl}/api/usage/summary`)).json() as Record<string, unknown>;
      assert.equal(usageSummary.totalCalls, 1);
      assert.equal(usageSummary.tokenStatus, 'not-reported');
      const usageReceipts = await (await fetch(`${baseUrl}/api/usage/receipts`)).text();
      assert.equal(usageReceipts.includes('hello from workbench'), false);
      assert.equal(usageReceipts.includes('gateway output'), false);
      assert.equal(usageReceipts.includes('sk-test-never-returned'), false);
      assert.equal(usageReceipts.includes('https://api.openai.com'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('DeepSeek session inference 命中官方 chat completions 路径并安全聚合 SSE 输出', async () => {
  await withGateway(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
    const originalFetch = globalThis.fetch;
    let target = '';
    let authorization = '';
    let remoteBody = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (requestedUrl === 'https://api.deepseek.com/chat/completions') {
        target = requestedUrl;
        authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
        remoteBody = String(init?.body ?? '');
        return new Response('data: {"choices":[{"delta":{"reasoning_content":"not returned"}}]}\n\ndata: {"choices":[{"delta":{"content":"Deep"}}]}\n\ndata: {"choices":[{"delta":{"content":"Seek"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const configured = await fetch(`${baseUrl}/api/providers/connections/deepseek/configure-session`, { method: 'POST', headers, body: JSON.stringify({ displayName: '我的 DeepSeek', model: 'deepseek-v4-pro', apiKey: 'sk-deepseek-session-only' }) });
      assert.equal(configured.status, 200);
      assert.equal((await configured.json() as { profileStatus: string }).profileStatus, 'active');
      const inferred = await fetch(`${baseUrl}/api/providers/connections/deepseek/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: '请返回 DeepSeek' }) });
      assert.equal(inferred.status, 200);
      const result = await inferred.json() as Record<string, unknown>;
      assert.equal(target, 'https://api.deepseek.com/chat/completions');
      assert.equal(authorization, 'Bearer sk-deepseek-session-only');
      assert.equal(result.output, 'DeepSeek');
      assert.equal(result.model, 'deepseek-v4-pro');
      assert.equal(remoteBody.includes('"stream":true'), true);
      assert.equal(remoteBody.includes('请返回 DeepSeek'), true);
      assert.equal(remoteBody.includes('sk-deepseek-session-only'), false);
      assert.equal(JSON.stringify(result).includes('sk-deepseek-session-only'), false);
      assert.equal(JSON.stringify(result).includes('https://api.deepseek.com'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('Gateway 桌面附着仅接受已审核 Tauri 或本地开发来源的 CORS 预检', async () => {
  await withGateway(async (baseUrl) => {
    const accepted = await fetch(`${baseUrl}/api/providers/connections`, {
      method: 'OPTIONS',
      headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-awo-operator-intent' },
    });
    assert.equal(accepted.status, 204);
    assert.equal(accepted.headers.get('access-control-allow-origin'), 'tauri://localhost');
    assert.equal(accepted.headers.get('access-control-allow-credentials'), null);
    assert.equal(accepted.headers.get('access-control-allow-headers')?.includes('x-awo-operator-intent'), true);
    const rejected = await fetch(`${baseUrl}/api/providers/connections`, {
      method: 'OPTIONS', headers: { origin: 'https://untrusted.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  });
});


test('Custom compatible Provider 只接受显式 HTTPS session 配置，并通过固定会话端点推理且绝不回显 URL 或 API key', async () => {
  const originalFetch = globalThis.fetch;
  let target = '';
  let modelsTarget = '';
  let authorization = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (requestedUrl.startsWith('https://models.example.test/') && requestedUrl.endsWith('/models')) {
      modelsTarget = requestedUrl;
      authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      return new Response('{"data":[{"id":"owner-model-v1"}]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (requestedUrl === 'https://models.example.test/v1/chat/completions') {
      target = requestedUrl;
      authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      return new Response('data: {"choices":[{"delta":{"content":"custom gateway"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
  await withGateway(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
    const malformed = await fetch(`${baseUrl}/api/providers/connections/custom/configure-session`, { method: 'POST', headers, body: JSON.stringify({ displayName: '我的自有模型', protocol: 'openai-compatible', baseUrl: 'http://localhost:3000/v1', model: 'owner-model-v1', apiKey: 'sk-custom-never-returned' }) });
    assert.equal(malformed.status, 400);
    const configured = await fetch(`${baseUrl}/api/providers/connections/custom/configure-session`, { method: 'POST', headers, body: JSON.stringify({ displayName: '我的自有模型', protocol: 'openai-compatible', baseUrl: 'https://models.example.test/v1', model: 'owner-model-v1', apiKey: 'sk-custom-never-returned' }) });
    assert.equal(configured.status, 200);
    const status = await configured.json() as Record<string, unknown>;
    const providerId = String(status.providerId);
    assert.match(providerId, /^custom-[a-z0-9-]+$/);
    assert.equal(status.profileStatus, 'active');
    assert.equal(JSON.stringify(status).includes('models.example.test'), false);
    assert.equal(JSON.stringify(status).includes('sk-custom-never-returned'), false);
    const listed = await (await fetch(`${baseUrl}/api/providers/connections`)).text();
    assert.equal(listed.includes('models.example.test'), false);
    assert.equal(listed.includes('sk-custom-never-returned'), false);

    try {
      const models = await fetch(`${baseUrl}/api/providers/connections/${encodeURIComponent(providerId)}/models`, { method: 'POST', headers: { 'x-awo-operator-intent': 'provider-connection-v1' } });
      assert.equal(models.status, 200);
      const discovery = await models.json() as Record<string, unknown>;
      assert.deepEqual(discovery.models, ['owner-model-v1']);
      assert.equal(modelsTarget, 'https://models.example.test/v1/models');
      assert.equal(authorization, 'Bearer sk-custom-never-returned');
      assert.equal(JSON.stringify(discovery).includes('models.example.test'), false);
      assert.equal(JSON.stringify(discovery).includes('sk-custom-never-returned'), false);
      const inferred = await fetch(`${baseUrl}/api/providers/connections/${encodeURIComponent(providerId)}/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello custom model' }) });
      assert.equal(inferred.status, 200);
      const result = await inferred.json() as Record<string, unknown>;
      assert.equal(target, 'https://models.example.test/v1/chat/completions');
      assert.equal(authorization, 'Bearer sk-custom-never-returned');
      assert.equal(result.output, 'custom gateway');
      assert.equal(JSON.stringify(result).includes('models.example.test'), false);
      assert.equal(JSON.stringify(result).includes('sk-custom-never-returned'), false);
    } finally {
      // 测试桩在本 Gateway 生命周期内保持有效，供会话服务与推理适配器共同使用。
    }
  });
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('MiMo Token Plan 中国可使用用户填写的官方 Base URL 与 api-key 鉴权，在同一会话探测并推理', async () => {
  const originalFetch = globalThis.fetch;
  let modelsTarget = '';
  let inferenceTarget = '';
  let receivedApiKey = '';
  let remoteBody = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawHeaders = init?.headers;
    const headers = rawHeaders instanceof Headers ? rawHeaders : new Headers(rawHeaders);
    if (requestedUrl === 'https://token-plan-cn.xiaomimimo.com/v1/models') {
      modelsTarget = requestedUrl;
      receivedApiKey = headers.get('api-key') ?? '';
      return new Response('{"data":[{"id":"mimo-v2.5-pro"}]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (requestedUrl === 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions') {
      inferenceTarget = requestedUrl;
      receivedApiKey = headers.get('api-key') ?? '';
      remoteBody = String(init?.body ?? '');
      return new Response('data: {"choices":[{"delta":{"content":"MiMo Token Plan 已连接"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await withGateway(async (baseUrl) => {
      const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
      const configured = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/configure-session`, {
        method: 'POST', headers, body: JSON.stringify({ baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKey: 'tp-session-only-never-returned' }),
      });
      assert.equal(configured.status, 200);
      const configuration = await configured.text();
      assert.equal(configuration.includes('tp-session-only-never-returned'), false);
      assert.equal(configuration.includes('token-plan-cn.xiaomimimo.com'), false);

      const probe = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/probe`, { method: 'POST', headers: { 'x-awo-operator-intent': 'provider-connection-v1' } });
      assert.equal(probe.status, 200);
      assert.equal((await probe.json() as { outcome: string }).outcome, 'reachable');
      assert.equal(modelsTarget, 'https://token-plan-cn.xiaomimimo.com/v1/models');
      assert.equal(receivedApiKey, 'tp-session-only-never-returned');

      const inferred = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: '请只回复连接成功' }) });
      assert.equal(inferred.status, 200);
      const result = await inferred.json() as Record<string, unknown>;
      assert.equal(inferenceTarget, 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
      assert.equal(receivedApiKey, 'tp-session-only-never-returned');
      assert.equal(result.output, 'MiMo Token Plan 已连接');
      assert.equal(remoteBody.includes('请只回复连接成功'), true);
      assert.equal(remoteBody.includes('tp-session-only-never-returned'), false);
      assert.equal(JSON.stringify(result).includes('tp-session-only-never-returned'), false);
      assert.equal(JSON.stringify(result).includes('token-plan-cn.xiaomimimo.com'), false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('MiMo Token Plan 中国 Anthropic-compatible 使用 api-key、Anthropic 版本头并能查询模型', async () => {
  const originalFetch = globalThis.fetch;
  let modelsTarget = '';
  let inferenceTarget = '';
  let receivedApiKey = '';
  let receivedVersion = '';
  let remoteBody = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    if (requestedUrl === 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/models') {
      modelsTarget = requestedUrl;
      receivedApiKey = headers.get('api-key') ?? '';
      receivedVersion = headers.get('anthropic-version') ?? '';
      return new Response('{"data":[{"id":"mimo-v2.5-pro"},{"id":"mimo-v2.5-pro"}]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (requestedUrl === 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages') {
      inferenceTarget = requestedUrl;
      receivedApiKey = headers.get('api-key') ?? '';
      receivedVersion = headers.get('anthropic-version') ?? '';
      remoteBody = String(init?.body ?? '');
      return new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"MiMo Anthropic 已连接"}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await withGateway(async (baseUrl) => {
      const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
      const configured = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/configure-session`, {
        method: 'POST', headers, body: JSON.stringify({ protocol: 'anthropic-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', apiKey: 'tp-anthropic-session-only' }),
      });
      assert.equal(configured.status, 200);
      assert.equal((await configured.text()).includes('tp-anthropic-session-only'), false);

      const models = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/models`, { method: 'POST', headers: { 'x-awo-operator-intent': 'provider-connection-v1' } });
      assert.equal(models.status, 200);
      const discovery = await models.json() as Record<string, unknown>;
      assert.deepEqual(discovery.models, ['mimo-v2.5-pro']);
      assert.equal(modelsTarget, 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/models');
      assert.equal(receivedApiKey, 'tp-anthropic-session-only');
      assert.equal(receivedVersion, '2023-06-01');
      assert.equal(JSON.stringify(discovery).includes('token-plan-cn.xiaomimimo.com'), false);
      assert.equal(JSON.stringify(discovery).includes('tp-anthropic-session-only'), false);

      const inferred = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: '请返回已连接' }) });
      assert.equal(inferred.status, 200);
      const result = await inferred.json() as Record<string, unknown>;
      assert.equal(inferenceTarget, 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages');
      assert.equal(receivedApiKey, 'tp-anthropic-session-only');
      assert.equal(receivedVersion, '2023-06-01');
      assert.equal(result.output, 'MiMo Anthropic 已连接');
      assert.equal(remoteBody.includes('请返回已连接'), true);
      assert.equal(remoteBody.includes('tp-anthropic-session-only'), false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Provider 会话协议只接受 OpenAI-compatible 或 Anthropic-compatible，模型查询拒绝正文', async () => {
  await withGateway(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
    const invalid = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/configure-session`, { method: 'POST', headers, body: JSON.stringify({ protocol: 'unknown-compatible', apiKey: 'tp-test' }) });
    assert.equal(invalid.status, 400);
    const modelsWithBody = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/models`, { method: 'POST', headers, body: JSON.stringify({ apiKey: 'must-not-be-read' }) });
    assert.equal(modelsWithBody.status, 400);
    assert.equal((await modelsWithBody.text()).includes('must-not-be-read'), false);
  });
});


test('Provider infer-stream 将上游标准 SSE 文本分块即时送到桌面端，不回显地址或 API key', async () => {
  const originalFetch = globalThis.fetch;
  let target = '';
  let requestBody = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (requestedUrl === 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions') {
      target = requestedUrl;
      requestBody = String(init?.body ?? '');
      return new Response('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\ndata: {"choices":[{"delta":{"content":"第二段"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await withGateway(async (baseUrl) => {
      const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
      const configured = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/configure-session`, {
        method: 'POST', headers, body: JSON.stringify({ baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKey: 'tp-stream-session-only' }),
      });
      assert.equal(configured.status, 200);
      const streamed = await fetch(`${baseUrl}/api/providers/connections/mimo-token-plan-cn/infer-stream`, {
        method: 'POST', headers, body: JSON.stringify({ prompt: '请流式回复' }),
      });
      assert.equal(streamed.status, 200);
      assert.equal(streamed.headers.get('content-type')?.startsWith('text/event-stream'), true);
      const stream = await streamed.text();
      assert.equal(target, 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
      assert.equal(requestBody.includes('请流式回复'), true);
      assert.equal(stream.includes('event: text'), true);
      assert.equal(stream.includes('第一段'), true);
      assert.equal(stream.includes('第二段'), true);
      assert.equal(stream.indexOf('第一段') < stream.indexOf('第二段'), true);
      assert.equal(stream.includes('event: done'), true);
      assert.equal(stream.includes('tp-stream-session-only'), false);
      assert.equal(stream.includes('token-plan-cn.xiaomimimo.com'), false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('Custom compatible Provider infer-stream 将标准 SSE 文本分块实时送到桌面端', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (requestedUrl === 'https://stream-custom.example.test/v1/chat/completions') {
      return new Response('data: {"choices":[{"delta":{"content":"自定义"}}]}\n\ndata: {"choices":[{"delta":{"content":"流式模型"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await withGateway(async (baseUrl) => {
      const headers = { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' };
      const configured = await fetch(`${baseUrl}/api/providers/connections/custom/configure-session`, {
        method: 'POST', headers,
        body: JSON.stringify({ displayName: '我的流式模型', protocol: 'openai-compatible', baseUrl: 'https://stream-custom.example.test/v1', model: 'owner-stream-v1', apiKey: 'sk-custom-stream-only' }),
      });
      const status = await configured.json() as { providerId: string };
      assert.equal(configured.status, 200);
      const response = await fetch(`${baseUrl}/api/providers/connections/${encodeURIComponent(status.providerId)}/infer-stream`, {
        method: 'POST', headers, body: JSON.stringify({ prompt: '请返回自定义流式文本' }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.equal(stream.includes('自定义'), true);
      assert.equal(stream.includes('流式模型'), true);
      assert.equal(stream.indexOf('自定义') < stream.indexOf('流式模型'), true);
      assert.equal(stream.includes('sk-custom-stream-only'), false);
      assert.equal(stream.includes('stream-custom.example.test'), false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
