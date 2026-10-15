// 一个文件=一种作用：从任意错误对象里探测失败事实（纯函数，零 IO）。
// 上游参考：ZCode `apps/zcode-cli/packages/adapters/src/model/failure-inspection.ts`、`failure-tls.ts`。
// 相对上游差异：不依赖 `ai` 包的 `APICallError` / `RetryError`，改用鸭子类型读取字段，
// 因此本层零依赖，可被浏览器侧与 Node 侧同时消费。

const TLS_CODE_FRAGMENTS = ['CERT', 'TLS'] as const;

/** 拆掉 `{ lastError }` 包装（上游 `RetryError` 的形态），拿到最内层错误。 */
export function unwrapRetryError(error: unknown): unknown {
  const record = asRecord(error);
  return record.lastError !== undefined && record.lastError !== null ? record.lastError : error;
}

export function getStatusCode(error: unknown): number | undefined {
  return getNumberByKeys(error, ['statusCode', 'status', 'responseStatus']);
}

export function getErrorCode(error: unknown): string | undefined {
  return getStringByKeys(error, ['code']);
}

export function getResponseHeaders(error: unknown): Record<string, string> | undefined {
  const headers = findValue(error, (record) => {
    const direct = asStringRecord(record.responseHeaders) ?? asStringRecord(record.headers);
    if (direct) return direct;
    return asStringRecord(asRecord(record.response).headers);
  });
  return headers;
}

export function getResponseBody(error: unknown): unknown {
  const raw = findValue(error, (record) => {
    if (record.responseBody === undefined) return undefined;
    return record.responseBody;
  });
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function isAbortFailure(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return true;
  const name = getStringByKeys(error, ['name']);
  return name === 'AbortError' || getErrorCode(error) === 'ABORT_ERR';
}

export function isTimeoutFailure(error: unknown, code?: string, statusCode?: number): boolean {
  if (statusCode === 408) return true;
  const normalized = code?.toUpperCase();
  if (
    normalized === 'ETIMEDOUT' ||
    normalized === 'ETIMEOUT' ||
    normalized === 'UND_ERR_CONNECT_TIMEOUT' ||
    normalized === 'UND_ERR_HEADERS_TIMEOUT' ||
    normalized === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return true;
  }
  const name = getStringByKeys(error, ['name'])?.toLowerCase();
  return name === 'timeouterror' || name === 'timeout_error';
}

export function isContextExceededFailure(error: unknown): boolean {
  return walkError(error, (record) => {
    const body = getResponseBody(error);
    return (
      isContextExceededCode(stringValue(record.code)) ||
      // 标准响应体会先被归一成业务错误，此时真实 provider 码位于 providerCode。
      isContextExceededCode(stringValue(record.providerCode)) ||
      isContextExceededCode(bodyCode(body)) ||
      isContextExceededMessage(stringValue(record.message)) ||
      isContextExceededMessage(bodyMessage(body))
    );
  });
}

export function isNetworkFailure(code?: string): boolean {
  const normalized = code?.toUpperCase();
  return (
    normalized === 'ECONNRESET' ||
    normalized === 'ECONNREFUSED' ||
    normalized === 'EAI_AGAIN' ||
    normalized === 'ENOTFOUND' ||
    normalized === 'ENETUNREACH' ||
    normalized === 'EHOSTUNREACH' ||
    normalized === 'UND_ERR_SOCKET' ||
    normalized === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

export function isProxyFailure(code?: string): boolean {
  return code?.toUpperCase().includes('PROXY') ?? false;
}

export function isTlsFailure(code?: string): boolean {
  const normalized = code?.toUpperCase();
  if (!normalized) return false;
  return (
    normalized === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    TLS_CODE_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
}

/** provider 自己在响应里声明「可重试」时，尊重它；未声明则不算。 */
export function isProviderMarkedRetryable(error: unknown): boolean {
  const value = findValue(error, (record) =>
    typeof record.isRetryable === 'boolean' ? record.isRetryable : undefined,
  );
  return value === true;
}

/**
 * 解析 `Retry-After` / `Retry-After-Ms`。
 * 部分 provider 同时返回 `retry-after` 与 `x-should-retry: false`；
 * 后者是明确拒绝重试，此时 retry-after 只能当诊断信息，不能驱动等待。
 */
export function parseRetryAfterMs(headers?: Record<string, string>): number | undefined {
  if (!headers) return undefined;
  if (isShouldRetryHeaderFalse(headers)) return undefined;

  const milliseconds = parseNumericHeaderMs(findHeaderValue(headers, 'retry-after-ms'));
  if (milliseconds !== undefined) return milliseconds;

  const value = findHeaderValue(headers, 'retry-after')?.trim();
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());

  return undefined;
}

function isContextExceededCode(value: string | undefined): boolean {
  const code = value?.toLowerCase();
  return (
    code === 'context_length_exceeded' ||
    code === 'context_window_exceeded' ||
    code === 'model_context_exceeded' ||
    code === 'model_context_window_exceeded'
  );
}

function isContextExceededMessage(value: string | undefined): boolean {
  const message = value?.toLowerCase();
  if (!message) return false;
  return (
    message === 'model_context_window_exceeded' ||
    (message.includes('context') && message.includes('exceed')) ||
    (message.includes('maximum context length') &&
      message.includes('tokens') &&
      (message.includes('requested') || message.includes('resulted'))) ||
    message.includes('prompt is too long') ||
    (message.includes('input token count') &&
      message.includes('exceed') &&
      message.includes('maximum number of tokens allowed')) ||
    message.includes('range of input length should be') ||
    (message.includes('total message token length') &&
      message.includes('exceed') &&
      message.includes('model limit'))
  );
}

function bodyCode(body: unknown): string | undefined {
  const record = asRecord(body);
  return stringValue(asRecord(record.error).code) ?? stringValue(record.code);
}

function bodyMessage(body: unknown): string | undefined {
  const record = asRecord(body);
  return stringValue(asRecord(record.error).message) ?? stringValue(record.message);
}

function findHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function isShouldRetryHeaderFalse(headers: Record<string, string>): boolean {
  const value = findHeaderValue(headers, 'x-should-retry')?.trim().toLowerCase();
  return value === 'false' || value === '0';
}

function parseNumericHeaderMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const milliseconds = Number(value.trim());
  return Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : undefined;
}

/** 沿 `cause` 链逐层查找，命中即返回；带 seen 集合防止自引用死循环。 */
function findValue<T>(error: unknown, read: (record: Record<string, unknown>) => T | undefined): T | undefined {
  let current = error;
  const seen = new WeakSet<object>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    const found = read(record);
    if (found !== undefined) return found;
    current = record.cause;
  }
  return undefined;
}

/** 沿 `cause` 链逐层判定，任一命中即真。 */
function walkError(error: unknown, test: (record: Record<string, unknown>) => boolean): boolean {
  let current = error;
  const seen = new WeakSet<object>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (test(record)) return true;
    current = record.cause;
  }
  return false;
}

function getNumberByKeys(error: unknown, keys: readonly string[]): number | undefined {
  return findValue(error, (record) => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    const response = asRecord(record.response);
    for (const key of keys) {
      const value = response[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
  });
}

function getStringByKeys(error: unknown, keys: readonly string[]): string | undefined {
  return findValue(error, (record) => {
    for (const key of keys) {
      const value = stringValue(record[key]);
      if (value !== undefined) return value;
    }
    return undefined;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;

  // 数组对必须排在 forEach 之前判定：数组自带 forEach，先判 forEach 会把 [名, 值] 对
  // 当成 (元素, 下标) 回调，静默丢掉整份响应头（连 retry-after 一起丢）。
  if (Array.isArray(value)) {
    const headers: Record<string, string> = {};
    for (const item of value) {
      if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== 'string') continue;
      headers[item[0]] = stringValue(item[1]) ?? '';
    }
    return Object.keys(headers).length === 0 ? undefined : headers;
  }

  const forEach = (value as { forEach?: unknown }).forEach;
  if (typeof forEach === 'function') {
    const headers: Record<string, string> = {};
    (forEach as (cb: (headerValue: unknown, name: unknown) => void) => void).call(
      value,
      (headerValue: unknown, name: unknown) => {
        if (typeof name === 'string') headers[name] = stringValue(headerValue) ?? '';
      },
    );
    return Object.keys(headers).length === 0 ? undefined : headers;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
