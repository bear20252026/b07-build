import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EnvironmentCredentialResolver,
  InMemoryProviderProfileStore,
  ProviderCatalog,
  ProviderInferenceService,
  ProviderProfileRegistry,
  type ModelDriver,
} from '../src/index.js';

const catalog = new ProviderCatalog([{
  schemaVersion: 1, id: 'example-provider', displayName: 'Example Provider', transport: 'openai-chat-completions', driverId: 'remote.example',
  baseUrl: 'https://api.example.invalid', defaultModel: 'example-model', credentialReference: 'env.openai', maximumDataBoundary: 'remote-allowed',
  capabilities: { contextWindow: 16_000, supportsTools: false, supportsVision: false, isLocal: false, costTier: 'medium' }, documentationUrl: 'https://example.invalid/docs',
}]);

function setup(secret?: string): { profiles: ProviderProfileRegistry; driver: ModelDriver; service: ProviderInferenceService; received: { key?: string; prompt?: string; model?: string } } {
  const profiles = new ProviderProfileRegistry(new InMemoryProviderProfileStore());
  const received: { key?: string; prompt?: string; model?: string } = {};
  const driver: ModelDriver = {
    id: () => 'remote.example',
    async *chat(request, apiKey) { received.key = apiKey; received.prompt = request.messages[0]?.content; received.model = request.model; yield 'safe '; yield 'output'; },
  };
  const resolver = new EnvironmentCredentialResolver((name) => name === 'OPENAI_API_KEY' ? secret : undefined);
  return {
    profiles, driver, received,
    service: new ProviderInferenceService(catalog, profiles, resolver, () => driver, (() => 1_000) as () => number),
  };
}

test('ProviderInferenceService 拒绝未登记或未激活 Profile，绝不开始 Driver 调用', async () => {
  const { service, profiles } = setup('sk-local-only');
  await assert.rejects(() => service.infer({ providerId: 'example-provider', prompt: 'hello' }), /显式登记并启用/);
  profiles.register({ id: 'provider.example-provider', displayName: 'Example Provider', driverIds: ['remote.example'], maximumDataBoundary: 'remote-allowed', credentialReference: 'env.openai', reviewedBy: 'desktop-owner', at: 1 });
  await assert.rejects(() => service.infer({ providerId: 'example-provider', prompt: 'hello' }), /显式登记并启用/);
});

test('ProviderInferenceService 只以 active Profile、Gateway host credential 和受限文本 prompt 执行，并返回脱敏会话结果', async () => {
  const { service, profiles, received } = setup('sk-local-only');
  profiles.register({ id: 'provider.example-provider', displayName: 'Example Provider', driverIds: ['remote.example'], maximumDataBoundary: 'remote-allowed', credentialReference: 'env.openai', reviewedBy: 'desktop-owner', at: 1 });
  profiles.activate('provider.example-provider', 'desktop-owner', 2);
  const result = await service.infer({ providerId: 'example-provider', prompt: '  summarize this  ' });
  assert.deepEqual(result, {
    schemaVersion: 1, providerId: 'example-provider', profileId: 'provider.example-provider', profileRevision: 2, model: 'example-model', dataBoundary: 'remote-allowed',
    output: 'safe output', outputDigest: '561c03f56ace489bb56fec63df72ebb01e73641954fdceae941253b0c99b6c65', outputCharacters: 11, latencyMs: 0,
    canReadSecret: false, canAutoExecuteTools: false, canAutoConnect: false,
  });
  assert.deepEqual(received, { key: 'sk-local-only', prompt: 'summarize this', model: 'example-model' });
  assert.equal(JSON.stringify(result).includes('sk-local-only'), false);
  assert.equal(JSON.stringify(result).includes('api.example.invalid'), false);
});

test('ProviderInferenceService 在 Gateway credential 缺失时不调用 Driver，且拒绝越界 model/prompt', async () => {
  const { service, profiles, received } = setup();
  profiles.register({ id: 'provider.example-provider', displayName: 'Example Provider', driverIds: ['remote.example'], maximumDataBoundary: 'remote-allowed', credentialReference: 'env.openai', reviewedBy: 'desktop-owner', at: 1 });
  profiles.activate('provider.example-provider', 'desktop-owner', 2);
  await assert.rejects(() => service.infer({ providerId: 'example-provider', prompt: 'hello' }), /未配置/);
  assert.deepEqual(received, {});
  const withCredential = setup('sk-local-only');
  withCredential.profiles.register({ id: 'provider.example-provider', displayName: 'Example Provider', driverIds: ['remote.example'], maximumDataBoundary: 'remote-allowed', credentialReference: 'env.openai', reviewedBy: 'desktop-owner', at: 1 });
  withCredential.profiles.activate('provider.example-provider', 'desktop-owner', 2);
  await assert.rejects(() => withCredential.service.infer({ providerId: 'example-provider', prompt: 'hello', model: 'model with spaces' }), /model 标识无效/);
  assert.deepEqual(withCredential.received, {});
});
