// 压缩触发层测试：阈值推导、有序判定分支、令牌来源双轨、熔断、择档、可审计性。
//
// 这份测试刻意覆盖四类"不测就会静默错"的地方：
// 1. **阈值推导的资源共用**——窗口是 input+output 共享的。若照抄完整窗口当分母，
//    阈值会永远够不到，表现为"上下文早就爆了却从不压缩"——**没有任何报错**。
// 2. **判定分支的顺序**——熔断必须排在阈值之前，否则熔断形同虚设
//    （每次都"超阈值所以再试一次"）；`not_enough_messages` 排在熔断之前，
//    否则"没得压"会被算进"压失败了"的计数。
// 3. **`0` 是有意义的值**——`maxConsecutiveFailures: 0` 表示"第一次失败就熔断"。
//    用 `|| 缺省` 会把它吞成 3，静默放宽熔断。
// 4. **令牌来源必须可分辨**——估算值与 provider 实测值可能差很多，
//    事后审计要能回答"当时按谁的话做的决定"。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COMPACTION_TIERS,
  type CompactionPolicyConfig,
} from '../src/compaction-policy-contract.js';
import {
  DEFAULT_COMPACTION_BUFFER_TOKENS,
  DEFAULT_COMPACTION_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS,
  DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES,
  decideCompaction,
  formatCompactionDecision,
  resolveBufferTokens,
  resolveCompactionThreshold,
  resolveContextWindow,
  resolveEffectiveContextWindow,
  resolveMaxConsecutiveFailures,
  resolveOutputReserveTokens,
  shouldRecordCompactionDecision,
  suggestCompactionTier,
  tiersToTry,
} from '../src/compaction-policy.js';

/** 一套"可以精确算"的配置：窗口 100k、输出预留 10k、缓冲 5k → 有效 90k → 阈值 85k。 */
const EXPLICIT: CompactionPolicyConfig = {
  contextWindow: 100_000,
  maxOutputTokens: 10_000,
  bufferTokens: 5_000,
};

// ───────────────────────── 档位闭集 ─────────────────────────

test('档位按代价从低到高排序，微压缩在最前', () => {
  // 顺序是数据性质："能用便宜的就不用贵的"由它保证，而不是每个调用点各自记得。
  assert.deepEqual([...COMPACTION_TIERS], ['microcompact', 'summarize']);
  assert.equal(suggestCompactionTier(), 'microcompact');
  assert.deepEqual([...tiersToTry()], [...COMPACTION_TIERS]);
  assert.equal(tiersToTry()[0], 'microcompact');
});

// ───────────────────────── 阈值推导 ─────────────────────────

test('阈值推导：有效窗口 = 窗口 − 输出预留，阈值 = 有效窗口 − 缓冲', () => {
  assert.equal(resolveContextWindow(EXPLICIT), 100_000);
  assert.equal(resolveOutputReserveTokens(EXPLICIT), 10_000);
  assert.equal(resolveEffectiveContextWindow(EXPLICIT), 90_000);
  assert.equal(resolveBufferTokens(EXPLICIT), 5_000);
  assert.equal(resolveCompactionThreshold(EXPLICIT), 85_000);
});

test('关键：输出预留按显式值 > maxOutputTokens > 缺省 的优先级解析', () => {
  // 模型只声明 4k 输出 → 只留 4k，没必要多留。
  assert.equal(resolveOutputReserveTokens({ maxOutputTokens: 4_000 }), 4_000);
  // 模型声明 10k（大于缺省 8192）→ **按声明留 10k**，不压成 8192。
  // 压成 8192 会让输入侧多占 1808 token，阈值虚高，该压的时候没压。
  assert.equal(resolveOutputReserveTokens({ maxOutputTokens: 10_000 }), 10_000);
  assert.equal(resolveOutputReserveTokens({ maxOutputTokens: 64_000 }), 64_000);
  // 显式 outputReserveTokens 最高：此时 maxOutputTokens 不参与。
  assert.equal(resolveOutputReserveTokens({ outputReserveTokens: 2_000, maxOutputTokens: 64_000 }), 2_000);
  // 显式值本身也受"不超过窗口"夹取。
  assert.equal(resolveOutputReserveTokens({ outputReserveTokens: 999_999, contextWindow: 100_000 }), 100_000);
});

test('关键：窗口小于输出预留时有效窗口夹到 0，阈值不为负', () => {
  const tiny: CompactionPolicyConfig = { contextWindow: 1_000, maxOutputTokens: 8_000, bufferTokens: 500 };
  // 输出预留夹到不超过窗口本身。
  assert.equal(resolveOutputReserveTokens(tiny), 1_000);
  assert.equal(resolveEffectiveContextWindow(tiny), 0);
  assert.equal(resolveBufferTokens(tiny), 0);
  // 阈值 0 而不是负数：极端配置下"有任何内容就压"是正确退化
  // （宁可压过头，也不要永远不压然后爆掉）。负数会让 `token < threshold` 恒为 false。
  assert.equal(resolveCompactionThreshold(tiny), 0);
});

test('缺省配置走保守值，且内部自洽', () => {
  assert.equal(resolveContextWindow(), DEFAULT_COMPACTION_CONTEXT_WINDOW);
  assert.equal(resolveOutputReserveTokens(), DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS);
  assert.equal(
    resolveEffectiveContextWindow(),
    DEFAULT_COMPACTION_CONTEXT_WINDOW - DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS,
  );
  assert.equal(resolveBufferTokens(), DEFAULT_COMPACTION_BUFFER_TOKENS);
  assert.equal(
    resolveCompactionThreshold(),
    DEFAULT_COMPACTION_CONTEXT_WINDOW - DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS - DEFAULT_COMPACTION_BUFFER_TOKENS,
  );
});

test('显式 0 被当作有效值而非"未指定"', () => {
  // outputReserveTokens: 0 → 有效窗口 = 完整窗口（全给输入侧）。
  const noReserve: CompactionPolicyConfig = { contextWindow: 50_000, outputReserveTokens: 0 };
  assert.equal(resolveOutputReserveTokens(noReserve), 0);
  assert.equal(resolveEffectiveContextWindow(noReserve), 50_000);
  // bufferTokens: 0 → 阈值 = 有效窗口（不预留缓冲）。
  const noBuffer: CompactionPolicyConfig = { contextWindow: 50_000, maxOutputTokens: 0, bufferTokens: 0 };
  assert.equal(resolveBufferTokens(noBuffer), 0);
  assert.equal(resolveCompactionThreshold(noBuffer), 50_000);
});

test('非法配置值一律回退到缺省（不抛错、不产生 NaN）', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -100]) {
    const config: CompactionPolicyConfig = { contextWindow: bad, maxOutputTokens: bad, bufferTokens: bad };
    assert.equal(resolveContextWindow(config), DEFAULT_COMPACTION_CONTEXT_WINDOW);
    assert.equal(resolveOutputReserveTokens(config), DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS);
    assert.equal(resolveBufferTokens(config), DEFAULT_COMPACTION_BUFFER_TOKENS);
    assert.ok(Number.isFinite(resolveCompactionThreshold(config)));
  }
  // 小数被向下取整（token 是整数概念）。
  assert.equal(resolveContextWindow({ contextWindow: 100_000.9 }), 100_000);
});

// ───────────────────────── 熔断阈值：0 是有效值 ─────────────────────────

test('关键：maxConsecutiveFailures 的 0 表示"第一次失败就熔断"，不被吞成缺省', () => {
  assert.equal(resolveMaxConsecutiveFailures({ maxConsecutiveFailures: 0 }), 0);
  assert.equal(resolveMaxConsecutiveFailures({}), DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES);
  assert.equal(DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES, 3);

  // 端到端：0 次失败计数就已经达到熔断阈值。
  const decision = decideCompaction({
    tokenCount: 999_999, // 远超阈值
    config: { ...EXPLICIT, maxConsecutiveFailures: 0 },
  });
  assert.equal(decision.circuitOpen, true);
  assert.equal(decision.shouldCompact, false);
  assert.equal(decision.reason, 'circuit_breaker');
});

// ───────────────────────── 有序判定分支 ─────────────────────────

test('触发：恰好等于阈值算触发（>= 而非 >）', () => {
  const threshold = resolveCompactionThreshold(EXPLICIT);
  const at = decideCompaction({ tokenCount: threshold, config: EXPLICIT });
  assert.equal(at.shouldCompact, true);
  assert.equal(at.reason, 'above_threshold');
  assert.equal(at.suggestedTier, 'microcompact');

  const below = decideCompaction({ tokenCount: threshold - 1, config: EXPLICIT });
  assert.equal(below.shouldCompact, false);
  assert.equal(below.reason, 'below_threshold');
});

test('关掉总开关时恒不触发，且原因明确（不报熔断）', () => {
  const decision = decideCompaction({
    tokenCount: 999_999,
    consecutiveFailures: 99,
    config: { ...EXPLICIT, enabled: false },
  });
  assert.equal(decision.shouldCompact, false);
  // 总开关排在熔断之前：关掉时不该报出一个用户看不懂的原因。
  assert.equal(decision.reason, 'disabled');
  // 但熔断状态仍然如实回显（它是事实，与开关无关）。
  assert.equal(decision.circuitOpen, true);
});

test('关键：内容不够与熔断是两个不同原因，且内容不够排在熔断之前', () => {
  // 同时满足"内容不够"与"已达熔断阈值"时，报 not_enough_messages——
  // 那是"没得压"，不是"压失败了"，混在一起会让熔断计数看起来在乱跳。
  const decision = decideCompaction({
    tokenCount: 999_999,
    hasEnoughMessages: false,
    consecutiveFailures: 10,
    config: EXPLICIT,
  });
  assert.equal(decision.reason, 'not_enough_messages');
  assert.equal(decision.shouldCompact, false);

  // 内容够时才轮到熔断接管。
  const circuit = decideCompaction({
    tokenCount: 999_999,
    hasEnoughMessages: true,
    consecutiveFailures: 3,
    config: EXPLICIT,
  });
  assert.equal(circuit.reason, 'circuit_breaker');
});

test('关键：熔断排在阈值之前——熔断中即使超阈值也不再压', () => {
  const beyondThreshold = resolveCompactionThreshold(EXPLICIT) + 1_000_000;
  const decision = decideCompaction({
    tokenCount: beyondThreshold,
    consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES,
    config: EXPLICIT,
  });
  // 若熔断排在阈值之后，这里会得到 above_threshold，
  // 于是"每次超阈值都再试一次"——熔断形同虚设。
  assert.equal(decision.reason, 'circuit_breaker');
  assert.equal(decision.shouldCompact, false);
  assert.equal(decision.circuitOpen, true);
});

test('关键：熔断中无论 token 多少都报 circuit_breaker（这条才真正钉住分支顺序）', () => {
  // 上一条用例其实**不能**区分两种顺序：超阈值时，正确顺序与颠倒顺序都会落到熔断分支。
  // 真正的区别在**低阈值**那一侧：
  // - 正确顺序（熔断在前）：报 circuit_breaker——"别再试了"；
  // - 颠倒顺序（阈值在前）：报 below_threshold——"没到阈值，不用压"，
  //   于是调用方会以为"只是还没到时候"，而实际上它已经在熔断里。
  // 两者对调用方的**下一步动作相反**（一个该上报/提示用户，一个什么都不用做），
  // 所以必须有这条用例把顺序钉死。
  const threshold = resolveCompactionThreshold(EXPLICIT);
  for (const tokenCount of [0, 1, threshold - 1, threshold, threshold + 1, threshold * 2]) {
    const decision = decideCompaction({
      tokenCount,
      consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES,
      config: EXPLICIT,
    });
    assert.equal(
      decision.reason,
      'circuit_breaker',
      `熔断中 token=${tokenCount} 应报 circuit_breaker，实际 ${decision.reason}`,
    );
    assert.equal(decision.shouldCompact, false);
  }
});

test('关键：熔断不能豁免"关掉总开关"与"内容不够"的如实回显', () => {
  // 这两条排在熔断**之前**，所以它们的原因不被熔断覆盖——
  // 关掉时不该报出一个用户看不懂的 circuit_breaker。
  const disabled = decideCompaction({
    tokenCount: 0,
    consecutiveFailures: 99,
    config: { ...EXPLICIT, enabled: false },
  });
  assert.equal(disabled.reason, 'disabled');
  const notEnough = decideCompaction({
    tokenCount: 0,
    hasEnoughMessages: false,
    consecutiveFailures: 99,
    config: EXPLICIT,
  });
  assert.equal(notEnough.reason, 'not_enough_messages');
});

test('熔断边界：失败数正好等于上限即熔断，少一次不熔断', () => {
  const tokenCount = resolveCompactionThreshold(EXPLICIT);
  const at = decideCompaction({ tokenCount, consecutiveFailures: 3, config: { ...EXPLICIT, maxConsecutiveFailures: 3 } });
  assert.equal(at.circuitOpen, true);
  const under = decideCompaction({ tokenCount, consecutiveFailures: 2, config: { ...EXPLICIT, maxConsecutiveFailures: 3 } });
  assert.equal(under.circuitOpen, false);
  assert.equal(under.shouldCompact, true);
});

test('hasEnoughMessages 缺省视为够（宁可让调用方显式说"不够"，也不要本层猜）', () => {
  const decision = decideCompaction({ tokenCount: 999_999, config: EXPLICIT });
  assert.equal(decision.shouldCompact, true);
});

test('失败计数为负或非法时归一为 0', () => {
  for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const decision = decideCompaction({ tokenCount: 0, consecutiveFailures: bad, config: EXPLICIT });
    assert.equal(decision.consecutiveFailures, 0);
  }
});

// ───────────────────────── 令牌来源双轨 ─────────────────────────

test('缺省来源是 estimate', () => {
  const decision = decideCompaction({ tokenCount: 1_000, config: EXPLICIT });
  assert.equal(decision.tokenSource, 'estimate');
  assert.equal(decision.tokenCount, 1_000);
});

test('关键：provider 实测覆盖估算值，且来源被记为 provider_usage', () => {
  const decision = decideCompaction({
    tokenCount: 1_000, // 本地估算：远低于阈值
    tokenOverride: { source: 'provider_usage', tokenCount: 95_000, cacheReadTokens: 3_000 },
    config: EXPLICIT,
  });
  // 覆盖生效——否则会漏压（provider 说已经 95k 了，本地估算是 1k）。
  assert.equal(decision.tokenCount, 95_000);
  assert.equal(decision.tokenSource, 'provider_usage');
  assert.equal(decision.shouldCompact, true);
});

test('provider 实测也会影响熔断/阈值的相对判定', () => {
  // 本地估算低于阈值、provider 实测高于阈值 → 应当触发。
  const belowEstimate = resolveCompactionThreshold(EXPLICIT) - 1_000;
  const aboveProvider = resolveCompactionThreshold(EXPLICIT) + 1_000;
  assert.equal(decideCompaction({ tokenCount: belowEstimate, config: EXPLICIT }).shouldCompact, false);
  assert.equal(
    decideCompaction({
      tokenCount: belowEstimate,
      tokenOverride: { source: 'provider_usage', tokenCount: aboveProvider },
      config: EXPLICIT,
    }).shouldCompact,
    true,
  );
});

test('覆盖里的非法 tokenCount 归一为 0，不产生 NaN', () => {
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const decision = decideCompaction({
      tokenCount: 999_999,
      tokenOverride: { source: 'provider_usage', tokenCount: bad },
      config: EXPLICIT,
    });
    // 归一为 0 → 低于阈值 → 不触发（而不是 NaN 参与比较得出诡异结果）。
    assert.equal(decision.tokenCount, 0);
    assert.equal(decision.shouldCompact, false);
    assert.equal(decision.reason, 'below_threshold');
  }
});

// ───────────────────────── 可审计性 ─────────────────────────

test('决策带全套中间量，可完整复算', () => {
  const decision = decideCompaction({ tokenCount: 86_000, config: EXPLICIT });
  assert.equal(decision.tokenCount, 86_000);
  assert.equal(decision.tokenSource, 'estimate');
  assert.equal(decision.threshold, 85_000);
  assert.equal(decision.contextWindow, 100_000);
  assert.equal(decision.effectiveContextWindow, 90_000);
  assert.equal(decision.outputReserveTokens, 10_000);
  assert.equal(decision.bufferTokens, 5_000);
  assert.equal(decision.maxConsecutiveFailures, DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES);
  assert.equal(decision.consecutiveFailures, 0);
  assert.equal(decision.circuitOpen, false);
  // 自洽性：阈值 = 有效窗口 − 缓冲。
  assert.equal(decision.threshold, decision.effectiveContextWindow - decision.bufferTokens);
  // 自洽性：有效窗口 = 窗口 − 输出预留。
  assert.equal(decision.effectiveContextWindow, decision.contextWindow - decision.outputReserveTokens);
});

test('未触发时不建议档位（没东西要压，建议档位会让调用方误以为要动手）', () => {
  const decision = decideCompaction({ tokenCount: 0, config: EXPLICIT });
  assert.equal(decision.shouldCompact, false);
  assert.equal(decision.suggestedTier, undefined);
});

test('只有触发的决策应被记入审计流（未触发会在长会话里淹没事件流）', () => {
  const triggered = decideCompaction({ tokenCount: 999_999, config: EXPLICIT });
  const skipped = decideCompaction({ tokenCount: 0, config: EXPLICIT });
  assert.equal(shouldRecordCompactionDecision(triggered), true);
  assert.equal(shouldRecordCompactionDecision(skipped), false);
});

test('决策摘要可读，且不含任何正文（本层只认识数字）', () => {
  const triggered = formatCompactionDecision(decideCompaction({ tokenCount: 90_000, config: EXPLICIT }));
  assert.match(triggered, /压缩：触发/);
  assert.match(triggered, /token=90000\(estimate\)/);
  assert.match(triggered, /阈值=85000/);

  const skipped = formatCompactionDecision(decideCompaction({ tokenCount: 0, config: EXPLICIT }));
  assert.match(skipped, /未触发（below_threshold）/);

  const circuit = formatCompactionDecision(
    decideCompaction({ tokenCount: 0, consecutiveFailures: 3, config: EXPLICIT }),
  );
  assert.match(circuit, /熔断中\(3\/3\)/);
});

// ───────────────────────── 纯函数不变量 ─────────────────────────

test('不变量：纯函数，不读时钟、不改输入、同输入同输出', () => {
  const request = {
    tokenCount: 90_000,
    consecutiveFailures: 1,
    config: { ...EXPLICIT },
  };
  const snapshot = JSON.stringify(request);
  const first = decideCompaction(request);
  const second = decideCompaction(request);
  assert.deepEqual(first, second);
  // 输入未被改动。
  assert.equal(JSON.stringify(request), snapshot);
});

test('不变量：同一配置下所有导出函数互相自洽', () => {
  for (const config of [
    EXPLICIT,
    {},
    { contextWindow: 200_000 },
    { contextWindow: 8_000, maxOutputTokens: 4_000, bufferTokens: 100 },
    { contextWindow: 1, maxOutputTokens: 1, bufferTokens: 1 },
  ] satisfies CompactionPolicyConfig[]) {
    const effective = resolveEffectiveContextWindow(config);
    const buffer = resolveBufferTokens(config);
    const threshold = resolveCompactionThreshold(config);
    assert.ok(effective >= 0, '有效窗口非负');
    assert.ok(buffer >= 0, '缓冲非负');
    assert.ok(threshold >= 0, '阈值非负');
    assert.equal(threshold, Math.max(0, effective - buffer));
    assert.ok(buffer <= effective, '缓冲不超过有效窗口');
    assert.ok(resolveOutputReserveTokens(config) <= resolveContextWindow(config), '输出预留不超过窗口');
  }
});
