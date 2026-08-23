import assert from 'node:assert/strict';
import test from 'node:test';
import { providerDiagnosticEntries, providerDiagnosticReport, recordProviderDiagnostic, resetProviderDiagnosticsForTest } from '../src/runtime/provider-diagnostics.js';

test('Provider 诊断仅记录可公开配置摘要、首 token 耗时与错误代码，不记录提示词或密钥', () => {
  resetProviderDiagnosticsForTest();
  recordProviderDiagnostic({ providerId: 'example', model: 'vision-1', stage: 'chat', outcome: 'failed', startedAt: Date.now() - 8, firstByteAt: Date.now() - 4, error: new Error('provider-http-404-image: secret should not appear'), includedImages: true });
  const [entry] = providerDiagnosticEntries();
  assert.equal(entry.providerId, 'example');
  assert.equal(entry.stage, 'chat');
  assert.equal(entry.errorCode, 'provider-http-404-image');
  assert.equal(typeof entry.firstByteMs, 'number');
  assert.equal(entry.includedImages, true);
  const report = providerDiagnosticReport({ desktopVersion: '0.1.3', sourceRevision: 'abc', workspaceSelected: false, providerEntries: [entry] });
  assert.match(report, /provider-http-404-image/);
  assert.doesNotMatch(report, /secret should not appear/);
});

test('Provider 诊断报告会移除 Base URL 中的用户信息、查询参数与片段', () => {
  resetProviderDiagnosticsForTest();
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } } });
  values.set('awo.direct-provider-accounts.v1', JSON.stringify([{ schemaVersion: 1, providerId: 'example', displayName: 'Example', protocol: 'openai-compatible', baseUrl: 'https://user:password@example.test/v1?token=leak#fragment', model: 'example-model', apiKey: 'sk-secret' }]));
  recordProviderDiagnostic({ providerId: 'example', stage: 'probe', outcome: 'succeeded', startedAt: Date.now() - 4 });
  const [entry] = providerDiagnosticEntries();
  assert.equal(entry.baseUrl, 'https://example.test/v1');
  assert.doesNotMatch(providerDiagnosticReport({ providerEntries: [entry] }), /password|token=|sk-secret/);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});
