import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EnvironmentCredentialResolver,
  InMemoryProviderProfileStore,
  ProviderCatalog,
  ProviderConnectionService,
  ProviderProfileRegistry,
} from '../src/index.js';

const catalog = new ProviderCatalog([
  {
    schemaVersion: 1, id: 'example-provider', displayName: 'Example Provider', transport: 'openai-chat-completions', driverId: 'remote.example',
    baseUrl: 'https://api.example.invalid', defaultModel: 'example-model', credentialReference: 'env.openai', maximumDataBoundary: 'remote-allowed',
    capabilities: { contextWindow: 16_000, supportsTools: false, supportsVision: false, isLocal: false, costTier: 'medium' }, documentationUrl: 'https://example.invalid/docs',
  },
]);

function service(secret?: string, fetcher: typeof fetch = globalThis.fetch): ProviderConnectionService {
  return new ProviderConnectionService(catalog, new ProviderProfileRegistry(new InMemoryProviderProfileStore()), new EnvironmentCredentialResolver((name) => name === 'OPENAI_API_KEY' ? secret : undefined), fetcher, (() => 123) as () => number);
}

test('Provider Connection Service 只暴露脱敏 catalog 状态，登记不会写入 API key 且不会自动激活或探测', () => {
  const value = service('sk-local-only');
  const listed = value.list();
  assert.deepEqual(listed, [{
    schemaVersion: 1, providerId: 'example-provider', displayName: 'Example Provider', driverId: 'remote.example', defaultModel: 'example-model',
    credentialReference: 'env.openai', credentialAvailability: 'available', profileStatus: 'not-registered', canReadSecret: false, canAutoConnect: false,
  }]);
  const registered = value.register({ providerId: 'example-provider', reviewedBy: 'desktop-owner', at: 100 });
  assert.equal(registered.profileStatus, 'registered');
  assert.equal(registered.profileRevision, 1);
  assert.equal(JSON.stringify(registered).includes('sk-local-only'), false);
  assert.equal(JSON.stringify(registered).includes('api.example.invalid'), false);
});

test('Provider Connection Service 需要显式登记与可用 Gateway credential 才能激活，probe 返回脱敏结果', async () => {
  let receivedAuthorization = '';
  const fetcher = (async (_input, init) => {
    receivedAuthorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
    return new Response('{"data":[]}', { status: 200 });
  }) as typeof fetch;
  const value = service('sk-local-only', fetcher);
  assert.throws(() => value.activate({ providerId: 'example-provider', reviewedBy: 'desktop-owner', at: 101 }), /尚未登记/);
  value.register({ providerId: 'example-provider', reviewedBy: 'desktop-owner', at: 100 });
  const active = value.activate({ providerId: 'example-provider', reviewedBy: 'desktop-owner', at: 101 });
  assert.equal(active.profileStatus, 'active');
  const probe = await value.probe('example-provider');
  assert.deepEqual(probe, { schemaVersion: 1, providerId: 'example-provider', outcome: 'reachable', checkedAt: 123, latencyMs: 0, canReadSecret: false, canAutoConnect: false });
  assert.equal(receivedAuthorization, 'Bearer sk-local-only');
  assert.equal(JSON.stringify(probe).includes('sk-local-only'), false);
});

test('Provider Connection Service 在凭据缺失时拒绝激活且 probe 绝不联网', async () => {
  let requests = 0;
  const fetcher = (async () => { requests += 1; return new Response('', { status: 200 }); }) as typeof fetch;
  const value = service(undefined, fetcher);
  value.register({ providerId: 'example-provider', reviewedBy: 'desktop-owner', at: 100 });
  assert.throws(() => value.activate({ providerId: 'example-provider', reviewedBy: 'desktop-owner', at: 101 }), /缺少 Gateway host/);
  assert.deepEqual(await value.probe('example-provider'), { schemaVersion: 1, providerId: 'example-provider', outcome: 'not-active', checkedAt: 123, canReadSecret: false, canAutoConnect: false });
  assert.equal(requests, 0);
});
