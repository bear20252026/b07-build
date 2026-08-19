import { strict as assert } from 'node:assert';
import test from 'node:test';
import { LocalModelHealthRegistry } from '../src/index.js';

test('LocalModelHealthRegistry 复用回环只读 probe 并暴露脱敏 health 摘要', async () => {
  const registry = new LocalModelHealthRegistry();
  registry.register({ id: 'ollama-local', baseUrl: 'http://127.0.0.1:11434', modelId: 'qwen-local', capabilities: { supportsTools: false, supportsVision: false }, contextWindow: 8192 });
  await registry.probe('ollama-local', async () => new Response(JSON.stringify({ data: [{ id: 'qwen-local' }] }), { status: 200 }), 123);
  assert.deepEqual(registry.listHealth(), [{
    schemaVersion: 1,
    id: 'ollama-local',
    configuredModelId: 'qwen-local',
    offline: false,
    health: { status: 'healthy', checkedAt: 123, probePath: '/health', probeMethod: 'HEAD', modelIds: [] },
  }]);
});

test('LocalModelHealthRegistry 的健康摘要不泄露内部可变数组或 endpoint URL', () => {
  const registry = new LocalModelHealthRegistry();
  registry.register({ id: 'local', baseUrl: 'http://localhost:11434', modelId: 'm1', capabilities: { supportsTools: false, supportsVision: false }, contextWindow: 1024 });
  const summary = registry.listHealth() as unknown as Array<{ health: { modelIds: string[] } }>;
  summary[0].health.modelIds.push('mutated');
  assert.deepEqual(registry.listHealth()[0], {
    schemaVersion: 1,
    id: 'local',
    configuredModelId: 'm1',
    offline: false,
    health: { status: 'unknown', modelIds: [] },
  });
});
