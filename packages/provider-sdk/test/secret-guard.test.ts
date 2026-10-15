// 一个文件=一种作用：密钥保护（脱敏 + 传输错误不外泄）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderTransportError,
  collectSecretValues,
  createSecretSafeFetch,
  isSensitiveHeaderName,
  redactSecrets,
  safeEndpointLabel,
  sanitizeProviderHeaders,
} from '../src/index.js';

// 夹具值刻意用低熵、非真实形态的占位串，避免被密钥扫描器（gitleaks generic-api-key）误报。
const SAMPLE_VALUE = 'placeholder-test-value';

test('头脱敏：认证、密钥、令牌、Cookie 类头名一律打码，普通头原样保留', () => {
  const sanitized = sanitizeProviderHeaders({
    Authorization: `Bearer ${SAMPLE_VALUE}`,
    'x-api-key': SAMPLE_VALUE,
    'X-Off-Peak-Ticket-Id': 'ticket-1',
    Cookie: 'session=abc',
    'content-type': 'application/json',
  });
  assert.deepEqual(sanitized, {
    authorization: '[redacted]',
    'x-api-key': '[redacted]',
    'x-off-peak-ticket-id': 'ticket-1',
    cookie: '[redacted]',
    'content-type': 'application/json',
  });
});

test('头脱敏：支持 Headers 与数组对两种形态，键统一小写', () => {
  const headers = new Headers({ Authorization: `Bearer ${SAMPLE_VALUE}`, 'x-trace-id': 't1' });
  assert.deepEqual(sanitizeProviderHeaders(headers), { authorization: '[redacted]', 'x-trace-id': 't1' });
  assert.deepEqual(sanitizeProviderHeaders([['X-Api-Key', SAMPLE_VALUE]]), { 'x-api-key': '[redacted]' });
});

test('端点脱敏：去掉用户信息、查询参数与片段；非法地址给出兜底文案', () => {
  assert.equal(
    safeEndpointLabel('https://user:password@example.test/v1?token=leak#fragment'),
    'https://example.test/v1',
  );
  assert.equal(safeEndpointLabel('https://example.test/v1///'), 'https://example.test/v1');
  assert.equal(safeEndpointLabel('https://example.test'), 'https://example.test/');
  assert.equal(safeEndpointLabel('not a url'), '无效 Base URL');
  assert.equal(safeEndpointLabel('not a url', '未配置'), '未配置');
});

test('密钥词表：显式密钥与敏感头值去重合并，过短串不参与替换', () => {
  assert.deepEqual(
    collectSecretValues({ secrets: [SAMPLE_VALUE, 'abc', SAMPLE_VALUE], headers: { authorization: SAMPLE_VALUE, 'x-trace-id': 't1' } }),
    [SAMPLE_VALUE],
  );
  assert.deepEqual(collectSecretValues({ secrets: ['abc'] }), []);
  assert.deepEqual(collectSecretValues({ headers: { authorization: `Bearer ${SAMPLE_VALUE}` } }), [`Bearer ${SAMPLE_VALUE}`]);
  assert.equal(isSensitiveHeaderName('X-Api-Key'), true);
  assert.equal(isSensitiveHeaderName('content-type'), false);
});

test('文本脱敏：明文与 URL 编码形态的密钥都会被替换', () => {
  const encoded = encodeURIComponent(`${SAMPLE_VALUE}/+=`);
  assert.equal(redactSecrets(`key=${SAMPLE_VALUE}`, [SAMPLE_VALUE]), 'key=[redacted]');
  assert.equal(redactSecrets(`key=${encoded}`, [`${SAMPLE_VALUE}/+=`]), 'key=[redacted]');
  assert.equal(redactSecrets('nothing to hide', [SAMPLE_VALUE]), 'nothing to hide');
});

test('密钥保护 fetch：请求成功时原样透传，不修改请求头', async () => {
  const seen: Array<RequestInit | undefined> = [];
  const inner = (async (_input: unknown, init?: RequestInit) => {
    seen.push(init);
    return new Response('ok');
  }) as unknown as typeof globalThis.fetch;
  const guarded = createSecretSafeFetch({ fetch: inner, secrets: [SAMPLE_VALUE] });

  const response = await guarded('https://provider.test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${SAMPLE_VALUE}` },
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.headers, { authorization: `Bearer ${SAMPLE_VALUE}` });
});

test('密钥保护 fetch：传输失败时抛出的错误里不含任何密钥，但保留 code/statusCode', async () => {
  const inner = (async () => {
    const error = new Error(`connect failed while sending Authorization: Bearer ${SAMPLE_VALUE}`) as Error & { code?: string; statusCode?: number };
    error.code = 'ECONNRESET';
    error.statusCode = 502;
    throw error;
  }) as unknown as typeof globalThis.fetch;
  const guarded = createSecretSafeFetch({ fetch: inner, secrets: [SAMPLE_VALUE] });

  await assert.rejects(
    guarded('https://provider.test/v1/chat/completions', { headers: { authorization: `Bearer ${SAMPLE_VALUE}` } }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.code, 'ECONNRESET');
      assert.equal(error.statusCode, 502);
      assert.doesNotMatch(error.message, new RegExp(SAMPLE_VALUE));
      assert.match(error.message, /\[redacted\]/);
      // cause 只保留脱敏摘要，绝不放原始错误对象。
      assert.doesNotMatch(JSON.stringify(error.cause), new RegExp(SAMPLE_VALUE));
      assert.ok(!(error.cause instanceof Error));
      return true;
    },
  );
});

test('密钥保护 fetch：未显式登记、但出现在请求敏感头里的密钥也会被自动脱敏', async () => {
  const inner = (async () => {
    throw new Error(`upstream echoed ${SAMPLE_VALUE}`);
  }) as unknown as typeof globalThis.fetch;
  const guarded = createSecretSafeFetch({ fetch: inner });

  await assert.rejects(
    guarded('https://provider.test/v1/chat/completions', { headers: { 'x-api-key': SAMPLE_VALUE } }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.doesNotMatch(error.message, new RegExp(SAMPLE_VALUE));
      return true;
    },
  );
});
