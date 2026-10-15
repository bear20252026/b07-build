// 一个文件=一种作用：重试预算与退避策略的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PROVIDER_RETRY_POLICY,
  SINGLE_ATTEMPT_MAX_ATTEMPTS,
  UNBOUNDED_RETRY_MAX_ATTEMPTS,
  resolveProviderRetryPolicy,
  resolveRetryPolicyForBudget,
  retryAttemptLoopContinues,
  retryBudgetAllows,
  retryBudgetMaxAttempts,
  retryDelayMs,
} from '../src/index.js';

test('策略归一化：非法覆盖值回退默认或收敛到安全下界，不会产生 0 次尝试', () => {
  assert.deepEqual(resolveProviderRetryPolicy(undefined), DEFAULT_PROVIDER_RETRY_POLICY);
  const sanitized = resolveProviderRetryPolicy({ maxAttempts: 0, baseDelayMs: -5, backoffFactor: Number.NaN, maxDelayMs: 0, jitter: false });
  // 0 次尝试没有意义：收敛到「至少一次」。
  assert.equal(sanitized.maxAttempts, SINGLE_ATTEMPT_MAX_ATTEMPTS);
  // 负数延迟收敛到 0（立即重试），而不是回退成默认值。
  assert.equal(sanitized.baseDelayMs, 0);
  // 非有限值无法收敛，回退默认。
  assert.equal(sanitized.backoffFactor, DEFAULT_PROVIDER_RETRY_POLICY.backoffFactor);
  assert.equal(sanitized.maxDelayMs, 0);
  assert.equal(sanitized.jitter, false);
});

test('单次尝试预算：把 maxAttempts 收敛为 1，其余策略字段不动', () => {
  const policy = resolveProviderRetryPolicy({ maxAttempts: 9, baseDelayMs: 100 });
  const single = resolveRetryPolicyForBudget(policy, 'single-attempt');
  assert.equal(single.maxAttempts, SINGLE_ATTEMPT_MAX_ATTEMPTS);
  assert.equal(single.baseDelayMs, 100);
  assert.equal(resolveRetryPolicyForBudget(policy, 'default'), policy);
});

test('重试预算：unbounded 恒放行，default 按 maxAttempts 闸门', () => {
  assert.equal(retryBudgetAllows('default', 3, 4), true);
  assert.equal(retryBudgetAllows('default', 4, 4), false);
  assert.equal(retryBudgetAllows('unbounded', 10_000, 4), true);
  assert.equal(retryAttemptLoopContinues('default', 5, 4), false);
  assert.equal(retryAttemptLoopContinues('unbounded', 5, 4), true);
});

test('重试预算：写进状态事件的 maxAttempts 在 unbounded 下是哨兵 0', () => {
  assert.equal(retryBudgetMaxAttempts('unbounded', 11), UNBOUNDED_RETRY_MAX_ATTEMPTS);
  assert.equal(retryBudgetMaxAttempts('default', 11), 11);
  assert.equal(retryBudgetMaxAttempts(undefined, 11), 11);
});

test('退避：指数增长并在 maxDelayMs 封顶', () => {
  const policy = resolveProviderRetryPolicy({ baseDelayMs: 2_000, backoffFactor: 2, maxDelayMs: 60_000, jitter: false });
  assert.deepEqual([1, 2, 3, 6, 10].map((attempt) => retryDelayMs(policy, attempt)), [2_000, 4_000, 8_000, 60_000, 60_000]);
});

test('退避：Retry-After 优先于退避曲线，但仍受 maxDelayMs 封顶', () => {
  const policy = resolveProviderRetryPolicy({ baseDelayMs: 2_000, backoffFactor: 2, maxDelayMs: 10_000, jitter: false });
  assert.equal(retryDelayMs(policy, 1, { retryAfterMs: 1_500 }), 1_500);
  assert.equal(retryDelayMs(policy, 5, { retryAfterMs: 900_000 }), 10_000);
  assert.equal(retryDelayMs(policy, 1, { retryAfterMs: -1 }), 0);
});

test('退避：开启抖动时结果落在 [delay/2, delay] 区间内，注入随机源后完全确定', () => {
  const policy = resolveProviderRetryPolicy({ baseDelayMs: 2_000, backoffFactor: 2, maxDelayMs: 60_000, jitter: true });
  assert.equal(retryDelayMs(policy, 1, { random: () => 0 }), 1_000);
  assert.equal(retryDelayMs(policy, 1, { random: () => 1 }), 2_000);
  assert.equal(retryDelayMs(policy, 1, { random: () => 0.5 }), 1_500);
});
