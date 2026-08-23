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
