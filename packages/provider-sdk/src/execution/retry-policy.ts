// 一个文件=一种作用：provider 重试预算与退避策略（纯函数，零 IO）。
// 上游参考：ZCode `apps/zcode-cli/packages/adapters/src/model/retry-budget.ts`、`retry-policy.ts`。

/**
 * 重试预算档位。
 * 「无上限」只放宽瞬态失败的放弃条件；「单次尝试」把本次请求的 maxAttempts 收敛为 1，
 * 鉴权刷新/签名修复这类额外尝试不占预算，语义不受影响。
 */
export type ProviderRetryBudget = 'default' | 'unbounded' | 'single-attempt';

export interface ProviderRetryPolicy {
  /** 含首次请求在内的总尝试数。 */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly backoffFactor: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
}

/** 状态事件里 `maxAttempts` 表示「无上限」的哨兵（Infinity 不可序列化，0 不占用合法计数）。 */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;
/** `single-attempt` 预算下本次请求允许的总尝试数（含首次）。 */
export const SINGLE_ATTEMPT_MAX_ATTEMPTS = 1;

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = Object.freeze({
  maxAttempts: 11,
  baseDelayMs: 2_000,
  backoffFactor: 2,
  maxDelayMs: 60_000,
  jitter: true,
});

export function isUnboundedRetryBudget(budget: ProviderRetryBudget | undefined): boolean {
  return budget === 'unbounded';
}

export function isSingleAttemptRetryBudget(budget: ProviderRetryBudget | undefined): boolean {
  return budget === 'single-attempt';
}

/** 归一化外部传入的策略：非法值回退到默认值，避免 0/NaN/负数把重试循环打成死循环。 */
export function resolveProviderRetryPolicy(
  overrides: Partial<ProviderRetryPolicy> | undefined,
): ProviderRetryPolicy {
  return {
    maxAttempts: normalizePositiveInteger(overrides?.maxAttempts, DEFAULT_PROVIDER_RETRY_POLICY.maxAttempts),
    baseDelayMs: normalizeNonNegativeInteger(overrides?.baseDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs),
    backoffFactor: normalizePositiveNumber(overrides?.backoffFactor, DEFAULT_PROVIDER_RETRY_POLICY.backoffFactor),
    maxDelayMs: normalizeNonNegativeInteger(overrides?.maxDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.maxDelayMs),
    jitter: overrides?.jitter ?? DEFAULT_PROVIDER_RETRY_POLICY.jitter,
  };
}

/** 按预算档位解析本次请求实际生效的策略；runner 入口统一走这里。 */
export function resolveRetryPolicyForBudget(
  policy: ProviderRetryPolicy,
  budget: ProviderRetryBudget | undefined,
): ProviderRetryPolicy {
  return isSingleAttemptRetryBudget(budget)
    ? { ...policy, maxAttempts: SINGLE_ATTEMPT_MAX_ATTEMPTS }
    : policy;
}

/** 失败之后还允许再试一次吗（unbounded 恒真）。 */
export function retryBudgetAllows(
  budget: ProviderRetryBudget | undefined,
  retryBudgetAttempt: number,
  maxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || retryBudgetAttempt < maxAttempts;
}

/** attempt 循环的继续条件（unbounded 恒真）。 */
export function retryAttemptLoopContinues(
  budget: ProviderRetryBudget | undefined,
  attempt: number,
  loopMaxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || attempt <= loopMaxAttempts;
}

/** 写进状态事件 / 日志的 maxAttempts：unbounded 下是哨兵 0。 */
export function retryBudgetMaxAttempts(
  budget: ProviderRetryBudget | undefined,
  maxAttempts: number,
): number {
  return isUnboundedRetryBudget(budget) ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}

export interface RetryDelayOptions {
  /** 供应商给出的 `Retry-After`；给出时优先于退避曲线，但仍受 maxDelayMs 封顶。 */
  readonly retryAfterMs?: number;
  /** 抖动源注入，测试传固定值即可得到确定性结果。 */
  readonly random?: () => number;
}

/**
 * 第 `attempt` 次重试前应等待的毫秒数（attempt 从 1 开始）。
 * 顺序：Retry-After 优先 → 指数退避 → maxDelayMs 封顶 → 可选抖动。
 */
export function retryDelayMs(
  policy: ProviderRetryPolicy,
  attempt: number,
  options: RetryDelayOptions = {},
): number {
  if (options.retryAfterMs !== undefined) {
    return Math.max(0, Math.min(options.retryAfterMs, policy.maxDelayMs));
  }
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const raw = policy.baseDelayMs * policy.backoffFactor ** exponent;
  const capped = Math.max(0, Math.min(raw, policy.maxDelayMs));
  if (!policy.jitter) return Math.round(capped);
  // 等量抖动：取 [delay/2, delay] 区间，既打散重试尖峰又不至于把退避压到无意义。
  const half = capped / 2;
  const random = options.random ?? Math.random;
  return Math.round(half + random() * half);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
