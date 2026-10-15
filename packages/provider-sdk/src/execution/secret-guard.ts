// 一个文件=一种作用：provider 密钥保护（脱敏 + 传输错误不外泄），纯函数 + 可注入 fetch 包装。
// 上游参考：ZCode `apps/zcode-cli/packages/adapters/src/model/runner-network-headers.ts`（头脱敏）、
// `model-request-headers.ts`（认证头识别）、`request-security.ts`（`protectTransport` 边界）。
// 相对上游差异：上游的 `protectTransport` 在本仓库是空实现，这里补上真实语义——
// 把「本次请求用到的密钥」登记成脱敏词表，并保证传输失败时抛出的错误里不含任何密钥。

const REDACTION_PLACEHOLDER = '[redacted]';

/** 头名命中即视为密钥载体；大小写不敏感。 */
const SENSITIVE_HEADER_PATTERN = /authorization|api[-_]?key|token|secret|cookie|password|credential/i;

/** 太短的串（如单字符）全局替换会把正常文本打成马赛克，因此设下限。 */
const MIN_SECRET_LENGTH = 4;

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(name);
}

/**
 * 归一化任意 Headers 形态（`Headers`、数组对、普通对象）为小写键记录。
 * 与上游 `sanitizeModelNetworkHeaders` 同形，便于日志里前后对照。
 */
export function sanitizeProviderHeaders(value: unknown): Record<string, string> {
  const headers = normalizeHeaders(value);
  const sanitized: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    sanitized[normalizedName] = isSensitiveHeaderName(normalizedName) ? REDACTION_PLACEHOLDER : headerValue;
  }
  return sanitized;
}

/**
 * Base URL 脱敏标签：去掉用户信息、查询参数与片段。
 * 上游 b07 的 `safeBaseUrl` 语义原样保留（含非法地址的兜底文案）。
 */
export function safeEndpointLabel(value: string, fallback = '无效 Base URL'): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return fallback;
  }
}

/** 把文本里出现的所有密钥替换成占位符；同时覆盖 URL 编码形态。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    redacted = redacted.split(secret).join(REDACTION_PLACEHOLDER);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.split(encoded).join(REDACTION_PLACEHOLDER);
  }
  return redacted;
}

export interface SecretRegistration {
  /** 调用方已知的密钥（如本次请求的 apiKey）。 */
  readonly secrets?: readonly string[];
  /** 请求头；命中敏感名的值会被自动登记。 */
  readonly headers?: Readonly<Record<string, string>>;
}

/** 汇总脱敏词表：显式密钥 + 敏感头里的值，去重并丢弃过短项。 */
export function collectSecretValues(input: SecretRegistration): readonly string[] {
  const collected = new Set<string>();
  for (const secret of input.secrets ?? []) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) collected.add(secret);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (isSensitiveHeaderName(name) && value.length >= MIN_SECRET_LENGTH) collected.add(value);
  }
  return Object.freeze([...collected]);
}

/** 传输失败的统一错误形态：`code` / `statusCode` 保留，`message` 与 `cause` 已脱敏。 */
export class ProviderTransportError extends Error {
  readonly code?: string;
  readonly statusCode?: number;
  /** 只保留脱敏后的原因摘要，绝不挂原始错误对象，避免调用方顺手把它打出来。 */
  override readonly cause?: Readonly<{ name?: string; code?: string; message: string }>;

  constructor(input: {
    readonly message: string;
    readonly code?: string;
    readonly statusCode?: number;
    readonly cause?: Readonly<{ name?: string; code?: string; message: string }>;
  }) {
    super(input.message);
    this.name = 'ProviderTransportError';
    if (input.code !== undefined) this.code = input.code;
    if (input.statusCode !== undefined) this.statusCode = input.statusCode;
    if (input.cause !== undefined) this.cause = input.cause;
  }
}

export interface SecretSafeFetchOptions {
  /** 被包装的真实传输（通常是 `globalThis.fetch`）。 */
  readonly fetch: typeof globalThis.fetch;
  /** 调用方已知的密钥。 */
  readonly secrets?: readonly string[];
  /** 静态默认头；命中敏感名的值自动登记为密钥。 */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * 密钥保护 fetch：转发请求，但保证**失败时抛出的错误里不含任何密钥**。
 * 这是「执行适配层」的传输边界——分类与重试都只消费这里抛出的错误。
 */
export function createSecretSafeFetch(options: SecretSafeFetchOptions): typeof globalThis.fetch {
  const registered = collectSecretValues(options);
  return async (input, init) => {
    const secrets = mergeSecretValues(registered, collectSecretValues({ headers: readRequestHeaders(input, init) }));
    try {
      return await options.fetch(input, init);
    } catch (error) {
      throw toTransportError(error, secrets);
    }
  };
}

function mergeSecretValues(base: readonly string[], extra: readonly string[]): readonly string[] {
  if (extra.length === 0) return base;
  return Object.freeze([...new Set([...base, ...extra])]);
}

function toTransportError(error: unknown, secrets: readonly string[]): ProviderTransportError {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const rawMessage = error instanceof Error ? error.message : String(error ?? '');
  const code = typeof record.code === 'string' ? record.code : undefined;
  const statusCode =
    typeof record.statusCode === 'number' && Number.isFinite(record.statusCode)
      ? record.statusCode
      : typeof record.status === 'number' && Number.isFinite(record.status)
        ? record.status
        : undefined;
  const name = typeof record.name === 'string' ? record.name : undefined;
  return new ProviderTransportError({
    message: redactSecrets(rawMessage, secrets),
    ...(code === undefined ? {} : { code }),
    ...(statusCode === undefined ? {} : { statusCode }),
    cause: {
      ...(name === undefined ? {} : { name }),
      ...(code === undefined ? {} : { code }),
      message: redactSecrets(rawMessage, secrets),
    },
  });
}

function readRequestHeaders(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): Record<string, string> {
  const headers: Record<string, string> = {};
  const requestHeaders =
    input instanceof Request
      ? input.headers
      : (input as { readonly headers?: unknown } | null | undefined)?.headers;
  Object.assign(headers, normalizeHeaders(requestHeaders));
  Object.assign(headers, normalizeHeaders(init?.headers));
  return headers;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value) return {};

  // 数组对必须排在 forEach 之前判定：数组自带 forEach，先判 forEach 会把 [名, 值] 对
  // 当成 (元素, 下标) 回调，静默产出一份空表（上游同形实现里的既有陷阱）。
  if (Array.isArray(value)) {
    const headers: Record<string, string> = {};
    for (const item of value) {
      if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== 'string') continue;
      headers[item[0]] = headerValueToString(item[1]);
    }
    return headers;
  }

  const forEach = (value as { forEach?: unknown }).forEach;
  if (typeof forEach === 'function') {
    const headers: Record<string, string> = {};
    (forEach as (cb: (headerValue: unknown, name: unknown) => void) => void).call(
      value,
      (headerValue: unknown, name: unknown) => {
        if (typeof name === 'string') headers[name] = headerValueToString(headerValue);
      },
    );
    return headers;
  }

  if (typeof value !== 'object') return {};

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    headers[name] = headerValueToString(headerValue);
  }
  return headers;
}

function headerValueToString(value: unknown): string {
  if (Array.isArray(value)) return value.map(headerValueToString).join(', ');
  return value === undefined || value === null ? '' : String(value);
}
