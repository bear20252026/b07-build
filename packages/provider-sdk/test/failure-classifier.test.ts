// 一个文件=一种作用：provider 失败分类的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyProviderFailure,
  extractProviderErrorCode,
  isRetryableFailure,
  type ClassifiedProviderFailure,
} from '../src/index.js';

function failure(error: unknown, options?: Parameters<typeof classifyProviderFailure>[1]): ClassifiedProviderFailure {
  return classifyProviderFailure(error, options);
}

test('失败分类：429 限流可重试，且透传 retry-after-ms', () => {
  const result = failure({ name: 'APICallError', statusCode: 429, responseHeaders: { 'retry-after-ms': '1500' } });
  assert.equal(result.code, 'model-rate-limited');
  assert.equal(result.reason, 'rate-limited');
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterMs, 1500);
  assert.equal(result.statusCode, 429);
});

test('失败分类：x-should-retry=false 时 retry-after 只能当诊断，不能驱动等待', () => {
  const result = failure({
    statusCode: 429,
    responseHeaders: { 'retry-after': '30', 'x-should-retry': 'false' },
  });
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterMs, undefined);
});

test('失败分类：鉴权失败与模型不存在都不可重试', () => {
  assert.deepEqual(
    { code: failure({ statusCode: 401 }).code, reason: failure({ statusCode: 401 }).reason, retryable: failure({ statusCode: 401 }).retryable },
    { code: 'provider-not-configured', reason: 'auth-failed', retryable: false },
  );
  assert.equal(failure({ statusCode: 403 }).reason, 'auth-failed');
  assert.equal(failure({ statusCode: 404 }).code, 'model-not-found');
});

test('失败分类：5xx 归为服务端错误并可重试，529 单独标为供应商过载', () => {
  assert.equal(failure({ statusCode: 500 }).reason, 'server-error');
  assert.equal(failure({ statusCode: 502 }).retryable, true);
  assert.equal(failure({ statusCode: 529 }).reason, 'provider-overloaded');
});

test('失败分类：400/422 只有在命中上下文超窗信号时才归为超窗', () => {
  assert.equal(failure({ statusCode: 400, message: 'bad parameter' }).code, 'invalid-model-request');
  const exceeded = failure({ statusCode: 400, message: 'maximum context length is 8192 tokens, requested 9000' });
  assert.equal(exceeded.code, 'model-context-exceeded');
  assert.equal(exceeded.reason, 'context-exceeded');
  assert.equal(exceeded.retryable, false);
});

test('失败分类：网络、代理、TLS 三类传输错误各自归类', () => {
  assert.deepEqual(
    { reason: failure({ code: 'ECONNRESET' }).reason, retryable: failure({ code: 'ECONNRESET' }).retryable },
    { reason: 'network-error', retryable: true },
  );
  assert.equal(failure({ code: 'PROXY_TUNNEL_FAILED' }).reason, 'proxy-error');
  assert.deepEqual(
    { reason: failure({ code: 'CERT_HAS_EXPIRED' }).reason, retryable: failure({ code: 'CERT_HAS_EXPIRED' }).retryable },
    { reason: 'tls-error', retryable: false },
  );
});

test('失败分类：取消永远不可重试，即使供应商把错误标成可重试', () => {
  const aborted = failure({ name: 'AbortError', isRetryable: true });
  assert.equal(aborted.reason, 'cancelled');
  assert.equal(isRetryableFailure(aborted), false);

  const controller = new AbortController();
  controller.abort();
  assert.equal(failure(new Error('whatever'), { abortSignal: controller.signal }).reason, 'cancelled');
});

test('失败分类：流式空闲超时既可由稳定错误码也可由错误名触发', () => {
  assert.equal(failure({ code: 'MODEL_STREAM_IDLE_TIMEOUT' }).reason, 'stream-idle-timeout');
  assert.equal(failure({ name: 'ModelStreamIdleTimeoutError', message: 'idle' }).retryable, true);
  assert.equal(failure(new Error('x'), { streamIdleTimeout: true }).code, 'model-request-timeout');
});

test('失败分类：沿 cause 链拆包装，并读出 provider 业务码与响应体文案', () => {
  const wrapped = {
    name: 'RetryError',
    lastError: {
      statusCode: 403,
      cause: { providerCode: 1234, providerMessage: '余额不足', responseBody: '{"error":{"code":"1301"}}' },
    },
  };
  const result = failure(wrapped);
  assert.equal(result.statusCode, 403);
  assert.equal(result.providerCode, '1234');
  assert.equal(result.message, '余额不足');
});

test('失败分类：无任何信号时归为未知且不可重试；供应商声明可重试时转为服务端错误', () => {
  assert.deepEqual(
    { reason: failure(new Error('???')).reason, retryable: failure(new Error('???')).retryable },
    { reason: 'unknown', retryable: false },
  );
  assert.deepEqual(
    { reason: failure({ isRetryable: true }).reason, retryable: failure({ isRetryable: true }).retryable },
    { reason: 'server-error', retryable: true },
  );
});

test('原生错误码抽取：只认桌面直连的稳定前缀，抽不到就返回 undefined', () => {
  assert.equal(extractProviderErrorCode(new Error('provider-http-404-image: 上游原文')), 'provider-http-404-image');
  assert.equal(extractProviderErrorCode('api-key-missing'), 'api-key-missing');
  assert.equal(extractProviderErrorCode(new Error('随机文本 不该被当成错误码')), undefined);
  assert.equal(extractProviderErrorCode(undefined), undefined);
});
