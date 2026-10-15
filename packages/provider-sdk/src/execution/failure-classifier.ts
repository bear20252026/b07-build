// 一个文件=一种作用：把任意 provider 失败归一成稳定分类（纯函数，零 IO）。
// 上游参考：ZCode `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`。
// 相对上游差异：去掉 `ai` SDK 与 `ProviderBusinessError` 依赖，只消费鸭子类型事实；
// provider 业务码映射收敛为「错误对象自带的 providerCode / 响应体 code」，不再内置厂商码表。

import {
  getErrorCode,
  getResponseBody,
  getResponseHeaders,
  getStatusCode,
  isAbortFailure,
  isContextExceededFailure,
  isNetworkFailure,
  isProviderMarkedRetryable,
  isProxyFailure,
  isTimeoutFailure,
  isTlsFailure,
  parseRetryAfterMs,
  unwrapRetryError,
} from './failure-inspection.js';

export type ProviderFailureCode =
  | 'provider-not-configured'
  | 'model-not-found'
  | 'invalid-model-request'
  | 'invalid-model-response'
  | 'model-rate-limited'
  | 'model-request-timeout'
  | 'model-context-exceeded'
  | 'model-request-cancelled'
  | 'model-request-failed';

export type ProviderFailureReason =
  | 'auth-failed'
  | 'cancelled'
  | 'context-exceeded'
  | 'invalid-request'
  | 'network-error'
  | 'provider-overloaded'
  | 'proxy-error'
  | 'rate-limited'
  | 'server-error'
  | 'stream-idle-timeout'
  | 'timeout'
  | 'tls-error'
  | 'unknown';

export interface ClassifiedProviderFailure {
  readonly code: ProviderFailureCode;
  readonly reason: ProviderFailureReason;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
  readonly providerCode?: string;
}

export interface ClassifyProviderFailureOptions {
  readonly abortSignal?: AbortSignal;
  /** 上游流式空闲超时已被归一成稳定错误码时置真，分类不再依赖英文文案。 */
  readonly streamIdleTimeout?: boolean;
}

const STREAM_IDLE_TIMEOUT_CODE = 'MODEL_STREAM_IDLE_TIMEOUT';
const STREAM_IDLE_TIMEOUT_NAME = 'ModelStreamIdleTimeoutError';

/** 上游（桌面端 Rust 直连）产出的稳定错误码前缀；诊断与分类共用同一份词表。 */
const NATIVE_ERROR_CODE_PATTERN = /\b(provider|api-key|base-url|model|messages|message-images)-[a-z0-9-]+\b/i;

/** 从任意错误里抽出可公开的稳定错误码；抽不到返回 undefined（绝不回退成原始 message）。 */
export function extractProviderErrorCode(value: unknown): string | undefined {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return NATIVE_ERROR_CODE_PATTERN.exec(text)?.[0].toLowerCase();
}

export function classifyProviderFailure(
  error: unknown,
  options: ClassifyProviderFailureOptions = {},
): ClassifiedProviderFailure {
  const unwrapped = unwrapRetryError(error);
  const statusCode = getStatusCode(unwrapped);
  const code = getErrorCode(unwrapped);
  const retryAfterMs = parseRetryAfterMs(getResponseHeaders(unwrapped));
  const providerCode = readProviderCode(unwrapped);
  const providerMessage = readProviderMessage(unwrapped);

  const base = { ...(retryAfterMs === undefined ? {} : { retryAfterMs }), ...(statusCode === undefined ? {} : { statusCode }), ...(providerCode === undefined ? {} : { providerCode }) };

  if (code === STREAM_IDLE_TIMEOUT_CODE || options.streamIdleTimeout || isStreamIdleTimeoutName(unwrapped)) {
    return {
      ...base,
      code: 'model-request-timeout',
      reason: 'stream-idle-timeout',
      message: '模型流式响应空闲超时。',
      retryable: true,
    };
  }

  if (isAbortFailure(unwrapped, options.abortSignal)) {
    return { ...base, code: 'model-request-cancelled', reason: 'cancelled', message: '模型请求已取消。', retryable: false };
  }

  if (isTimeoutFailure(unwrapped, code, statusCode)) {
    return { ...base, code: 'model-request-timeout', reason: 'timeout', message: '模型请求超时。', retryable: true };
  }

  if (statusCode === 429) {
    return { ...base, code: 'model-rate-limited', reason: 'rate-limited', message: providerMessage ?? '供应商限流了模型请求。', retryable: true };
  }

  if (statusCode === 529) {
    return { ...base, code: 'model-request-failed', reason: 'provider-overloaded', message: providerMessage ?? '供应商过载。', retryable: true };
  }

  if (statusCode === 401 || statusCode === 403) {
    return { ...base, code: 'provider-not-configured', reason: 'auth-failed', message: providerMessage ?? '供应商鉴权失败。', retryable: false };
  }

  if (statusCode === 404) {
    return { ...base, code: 'model-not-found', reason: 'invalid-request', message: providerMessage ?? '供应商未找到该模型。', retryable: false };
  }

  if (statusCode === 400 || statusCode === 422) {
    const contextExceeded = isContextExceededFailure(unwrapped);
    return {
      ...base,
      code: contextExceeded ? 'model-context-exceeded' : 'invalid-model-request',
      reason: contextExceeded ? 'context-exceeded' : 'invalid-request',
      message: providerMessage ?? (contextExceeded ? '请求超出模型上下文窗口。' : '供应商拒绝了模型请求。'),
      retryable: false,
    };
  }

  if (isContextExceededFailure(unwrapped)) {
    return { ...base, code: 'model-context-exceeded', reason: 'context-exceeded', message: providerMessage ?? '请求超出模型上下文窗口。', retryable: false };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return { ...base, code: 'model-request-failed', reason: 'server-error', message: providerMessage ?? '供应商返回服务端错误。', retryable: true };
  }

  if (isTlsFailure(code)) {
    return { ...base, code: 'model-request-failed', reason: 'tls-error', message: '供应商请求的 TLS 校验失败。', retryable: false };
  }

  if (isProxyFailure(code)) {
    return { ...base, code: 'model-request-failed', reason: 'proxy-error', message: '供应商请求的代理连接失败。', retryable: true };
  }

  if (isNetworkFailure(code)) {
    return { ...base, code: 'model-request-failed', reason: 'network-error', message: '供应商请求的网络连接失败。', retryable: true };
  }

  const markedRetryable = isProviderMarkedRetryable(unwrapped);
  return {
    ...base,
    code: 'model-request-failed',
    reason: markedRetryable ? 'server-error' : 'unknown',
    message: markedRetryable ? '供应商把该请求标记为可重试。' : '模型请求失败。',
    retryable: markedRetryable,
  };
}

/** 取消永远不重试，即便供应商把错误标成可重试。 */
export function isRetryableFailure(failure: ClassifiedProviderFailure): boolean {
  return failure.retryable && failure.reason !== 'cancelled';
}

function isStreamIdleTimeoutName(error: unknown): boolean {
  let current: unknown = error;
  const seen = new WeakSet<object>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.name === STREAM_IDLE_TIMEOUT_NAME) return true;
    current = record.cause;
  }
  return false;
}

function readProviderCode(error: unknown): string | undefined {
  const direct = findProviderField(error, 'providerCode');
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  if (typeof direct === 'number' && Number.isFinite(direct)) return String(Math.trunc(direct));
  const body = asRecord(getResponseBody(error));
  const nested = asRecord(body.error);
  const fromBody = nested.code ?? body.code;
  if (typeof fromBody === 'string' && fromBody.trim().length > 0) return fromBody.trim();
  if (typeof fromBody === 'number' && Number.isFinite(fromBody)) return String(Math.trunc(fromBody));
  return undefined;
}

function readProviderMessage(error: unknown): string | undefined {
  const direct = findProviderField(error, 'providerMessage');
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  const body = asRecord(getResponseBody(error));
  const nested = asRecord(body.error);
  const message = nested.message ?? body.message;
  return typeof message === 'string' && message.trim().length > 0 ? message.trim() : undefined;
}

function findProviderField(error: unknown, key: string): unknown {
  let current: unknown = error;
  const seen = new WeakSet<object>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record[key] !== undefined) return record[key];
    current = record.cause;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
