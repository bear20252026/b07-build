import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpMimoTtsClient } from '../src/runtime/mimo-tts-client.js';

const valid = {
  schemaVersion: 1, providerId: 'mimo', model: 'mimo-v2.5-tts', voice: 'mimo_default', audioMime: 'audio/wav', audioBase64: 'UklGRg==', audioBytes: 4,
  inputDigest: 'a'.repeat(64), inputCharacters: 2, latencyMs: 1, dataBoundary: 'remote-allowed', canReadSecret: false, canAutoPlay: false, canAutoSpeak: false, canAutoExecute: false,
};

test('MiMo TTS 客户端只调用固定 loopback、携带显式试听 intent 且仅提交 text/voice', async () => {
  let received: { url?: string; init?: RequestInit } = {};
  const client = new HttpMimoTtsClient(undefined, async (url, init) => {
    received = { url: String(url), init };
    return new Response(JSON.stringify(valid), { status: 200 });
  });
  const result = await client.preview({ text: '明确试听', voice: '茉莉' });
  assert.equal(received.url, 'http://127.0.0.1:4318/api/companion/tts/preview');
  assert.equal(new Headers(received.init?.headers).get('x-awo-operator-intent'), 'companion-tts-preview-v1');
  assert.deepEqual(JSON.parse(String(received.init?.body)), { text: '明确试听', voice: '茉莉' });
  assert.equal(result.canAutoPlay, false);
  assert.equal(result.canAutoSpeak, false);
  assert.equal(result.canAutoExecute, false);
});

test('MiMo TTS 客户端拒绝秘密字段或自动播放承诺', async () => {
  const client = new HttpMimoTtsClient(undefined, async () => new Response(JSON.stringify({ ...valid, apiKey: 'must-not-return' }), { status: 200 }));
  await assert.rejects(() => client.preview({ text: '明确试听' }), /未允许字段/);
  const autoClient = new HttpMimoTtsClient(undefined, async () => new Response(JSON.stringify({ ...valid, canAutoPlay: true }), { status: 200 }));
  await assert.rejects(() => autoClient.preview({ text: '明确试听' }), /受控语音边界/);
});
