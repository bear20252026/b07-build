import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalEndpointRegistry,
  ModelRouter,
  type ChatRequest,
  type ModelCapabilities,
  type ModelDriver,
} from '../src/index.js';

class FakeDriver implements ModelDriver {
  constructor(private readonly driverId: string, private readonly modelCapabilities: ModelCapabilities) {}

  id(): string { return this.driverId; }
  capabilities(): ModelCapabilities { return { ...this.modelCapabilities }; }
  async *chat(_request: ChatRequest, _apiKey: string): AsyncIterable<string> { yield 'unused'; }
}

function register(registry: LocalEndpointRegistry, id = 'local-qwen'): void {
  registry.register({
    id,
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen3-local',
    capabilities: { supportsTools: true, supportsVision: false },
    contextWindow: 32_768,
  });
}

test('仅允许无凭据的回环本地端点，并规范化 OpenAI /v1 基址', () => {
  const registry = new LocalEndpointRegistry();
  register(registry);
  assert.equal(registry.get('local-qwen')?.baseUrl, 'http://127.0.0.1:11434');
  assert.throws(() => registry.register({
    id: 'remote-endpoint', baseUrl: 'https://example.com', modelId: 'model-a',
    capabilities: { supportsTools: false, supportsVision: false }, contextWindow: 8_192,
  }), /回环/);
  assert.throws(() => registry.register({
    id: 'credential-endpoint', baseUrl: 'http://token@localhost:11434', modelId: 'model-a',
    capabilities: { supportsTools: false, supportsVision: false }, contextWindow: 8_192,
  }), /身份信息/);
});

test('健康探测只发 HEAD/GET，并在 /health 不可用时回退到只读 /v1/models', async () => {
  const registry = new LocalEndpointRegistry(60_000, () => 1_000);
  register(registry);
  const calls: string[] = [];
  const endpoint = await registry.probe('local-qwen', async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith('/health')) return new Response('', { status: init.method === 'HEAD' ? 405 : 404 });
    if (init.method === 'HEAD') return new Response('', { status: 405 });
    return Response.json({ data: [{ id: 'z-model' }, { id: 'a-model' }] });
  });

  assert.deepEqual(calls, [
    'HEAD http://127.0.0.1:11434/health',
    'GET http://127.0.0.1:11434/health',
    'HEAD http://127.0.0.1:11434/v1/models',
    'GET http://127.0.0.1:11434/v1/models',
  ]);
  assert.deepEqual(endpoint.health, {
    status: 'healthy', checkedAt: 1_000, probePath: '/v1/models', probeMethod: 'GET', modelIds: ['a-model', 'z-model'],
  });
  assert.equal(registry.isRoutable('local-qwen', 61_000), true);
  assert.equal(registry.isRoutable('local-qwen', 61_001), false);
});

test('路由器仅在登记本地端点健康且在线时将其作为本地优先候选', async () => {
  const registry = new LocalEndpointRegistry(60_000, () => 1_000);
  register(registry);
  await registry.probe('local-qwen', async () => new Response('', { status: 200 }), 1_000);
  const local = new FakeDriver('local-qwen', {
    contextWindow: 32_768, supportsTools: true, supportsVision: false, isLocal: true, costTier: 'low',
  });
  const remote = new FakeDriver('remote-safe', {
    contextWindow: 128_000, supportsTools: true, supportsVision: false, isLocal: false, costTier: 'medium',
  });
  const router = new ModelRouter(new Map([[local.id(), local], [remote.id(), remote]]), registry, () => 1_000);

  assert.equal(router.decide({ kind: 'research', at: 1_000 }).driver.id(), 'local-qwen');
  registry.setOffline('local-qwen', true);
  assert.equal(router.decide({ kind: 'research', at: 1_000 }).driver.id(), 'remote-safe');
  assert.throws(() => router.decide({ kind: 'research', dataBoundary: 'local-only', at: 1_000 }), /no model/);

  registry.setOffline('local-qwen', false);
  assert.equal(router.decide({ kind: 'research', at: 61_001 }).driver.id(), 'remote-safe');
});
