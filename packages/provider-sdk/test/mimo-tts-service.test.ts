import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EnvironmentCredentialResolver,
  InMemoryProviderProfileStore,
  MimoTtsService,
  ProviderCatalog,
  ProviderProfileRegistry,
} from '../src/index.js';

const catalog = new ProviderCatalog([{
  schemaVersion: 1, id: 'mimo', displayName: 'Xiaomi MiMo', transport: 'openai-chat-completions', driverId: 'remote.mimo',
  baseUrl: 'https://api.xiaomimimo.com', defaultModel: 'mimo-v2.5-pro', credentialReference: 'env.mimo', maximumDataBoundary: 'remote-allowed',
  capabilities: { contextWindow: 128_000, supportsTools: true, supportsVision: false, isLocal: false, costTier: 'medium' }, documentationUrl: 'https://mimo.mi.com/docs/',
}]);

function setup(secret?: string) {
  const profiles = new ProviderProfileRegistry(new InMemoryProviderProfileStore());
  const received: { url?: string; key?: string; body?: unknown } = {};
  const fetcher: typeof fetch = async (url, init) => {
    received.url = String(url); received.key = new Headers(init?.headers).get('api-key') ?? undefined;
    received.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { audio: { data: 'UklGRg==' } } }] }), { status: 200 });
  };
  const resolver = new EnvironmentCredentialResolver((name) => name === 'MIMO_API_KEY' ? secret : undefined);
  return { profiles, received, service: new MimoTtsService(catalog, profiles, resolver, fetcher, (() => 2_000) as () => number) };
}

test('MiMo TTS 拒绝未激活 Profile，且绝不调用远程服务', async () => {
  const { service, received } = setup('mimo-session-secret');
  await assert.rejects(() => service.preview({ text: '你好' }), /显式配置并启用/);
  assert.deepEqual(received, {});
});

test('MiMo TTS 只以 active Profile 和 Gateway 内存凭据执行一次性预览，并返回不可自动播放的短暂音频投影', async () => {
  const { service, profiles, received } = setup('mimo-session-secret');
  profiles.register({ id: 'provider.mimo', displayName: 'Xiaomi MiMo', driverIds: ['remote.mimo'], maximumDataBoundary: 'remote-allowed', credentialReference: 'env.mimo', reviewedBy: 'desktop-owner', at: 1 });
  profiles.activate('provider.mimo', 'desktop-owner', 2);
  const result = await service.preview({ text: '  明确试听这一句。  ', voice: '茉莉' });
  assert.equal(result.providerId, 'mimo');
  assert.equal(result.model, 'mimo-v2.5-tts');
  assert.equal(result.voice, '茉莉');
  assert.equal(result.audioMime, 'audio/wav');
  assert.equal(result.audioBase64, 'UklGRg==');
  assert.equal(result.canReadSecret, false);
  assert.equal(result.canAutoPlay, false);
  assert.equal(result.canAutoSpeak, false);
  assert.equal(result.canAutoExecute, false);
  assert.equal(received.url, 'https://api.xiaomimimo.com/v1/chat/completions');
  assert.equal(received.key, 'mimo-session-secret');
  assert.deepEqual(received.body, { model: 'mimo-v2.5-tts', messages: [{ role: 'user', content: '请用自然、清晰、适合桌面助手的中性语气朗读。' }, { role: 'assistant', content: '明确试听这一句。' }], audio: { format: 'wav', voice: '茉莉' }, stream: false });
  assert.equal(JSON.stringify(result).includes('mimo-session-secret'), false);
  assert.equal(JSON.stringify(result).includes('api.xiaomimimo.com'), false);
});

test('MiMo TTS 拒绝未审核音色和超过上限文本，不请求远程服务', async () => {
  const { service, profiles, received } = setup('mimo-session-secret');
  profiles.register({ id: 'provider.mimo', displayName: 'Xiaomi MiMo', driverIds: ['remote.mimo'], maximumDataBoundary: 'remote-allowed', credentialReference: 'env.mimo', reviewedBy: 'desktop-owner', at: 1 });
  profiles.activate('provider.mimo', 'desktop-owner', 2);
  await assert.rejects(() => service.preview({ text: 'hello', voice: 'unreviewed' }), /预置音色/);
  await assert.rejects(() => service.preview({ text: 'a'.repeat(1_201) }), /1-1200/);
  assert.deepEqual(received, {});
});
