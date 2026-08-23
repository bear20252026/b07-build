import assert from 'node:assert/strict';
import test from 'node:test';
import { streamErrorText } from '../src/runtime/use-direct-conversations.js';

test('将原生直连网络错误映射为可操作且不含 URL 或密钥的用户提示', () => {
  assert.match(streamErrorText(new Error('provider-dns-failed')), /DNS/);
  assert.match(streamErrorText(new Error('provider-tls-failed')), /TLS/);
  assert.match(streamErrorText(new Error('provider-connect-failed')), /HTTPS/);
  assert.match(streamErrorText(new Error('provider-request-timeout')), /超时/);
  assert.doesNotMatch(streamErrorText(new Error('provider-dns-failed')), /token-plan-cn|tp-/i);
});

test('MiMo Pro 的图片 404 明确建议切换官方视觉模型而不归咎本地拦截', () => {
  const text = streamErrorText(new Error('provider-http-404-image-mimo-v25-pro'));
  assert.match(text, /mimo-v2\.5/);
  assert.match(text, /没有被本地丢弃/);
});
