// 一个文件=一种作用：压缩触发层——「该不该压、压哪一档」的确定性决策。纯函数，零 IO、不调模型。
//
// ## 为什么需要这一层
//
// `microcompact.ts` 当初就写明了这个缺口：「AutoCompact 是触发层，得先有可触发的档位」。
// 档位后来补上了（`decideMicrocompact`），但**触发层一直缺席**——全仓 grep 确认
// `decideMicrocompact` 只有测试在调，生产代码里**没有任何调用点**。
// 这正是一个「已实现但从不生效」的能力：功能齐全、测试全绿、对用户零效果。
// 这类缺口比「功能缺失」更难察觉，因为它没有任何报错。
//
// 触发层要回答的恰好是三个既有能力都答不了的问题：
// 1. **什么时候该压**——`ContextBudgeter` 只在装配**之后**按预算裁剪（反应式，剪完就完了），
//    没有「提前判断快要溢出了」的前视判定；
// 2. **压哪一档**——`decideMicrocompact` 只管微压缩一档，没有「微压缩不够时才上摘要」的择档；
// 3. **压不动怎么办**——摘要可能反复失败。没有熔断会让每一轮都重试同一次注定失败的压缩，
//    把一次失败放大成**每轮都付一遍**的固定开销。
//
// ## 设计来源与许可
//
// 设计研读自 ZCode v3.15.1（Apache-2.0）的
// `apps/zcode-cli/packages/core/src/compact/policy.ts`（161 行）与
// `packages/contracts/src/compact/index.ts`（354 行，压缩触发/阶段/原因/状态闭集与边界载荷）。
// 上游为 Apache-2.0，与本仓库（MIT）兼容，但本模块**未复制其任何代码**——不复制文件、
// 不逐行翻译、不沿用其命名（`shouldAutoCompact` / `AutoCompactDecision` /
// `getEffectiveContextWindowSize` / `positiveInt` 等一律重新命名或改写）、注释与实现结构，
// 只研读其设计约束并按 b07 形态独立重写。详见 `THIRD-PARTY-NOTICES.md`。
//
// ## 从上游学到的四条设计约束
//
// 1. **阈值的分母不是完整窗口**：provider 的 context window 是 **input + output 共享**的。
//    自动压缩只能让出**输入侧**，所以阈值必须先扣掉本次请求允许的 output token，
//    否则会算出一个永远够不到的阈值——表现为「上下文早就爆了却从不触发压缩」。
//    这是**先看清资源怎么共用、再定公式**，不是拍脑袋乘个比例。
// 2. **阈值 = 有效窗口 − 缓冲**：留一条缓冲而不是卡在悬崖边。理由是压缩本身要花一次请求，
//    卡在边缘触发时压缩请求自己就可能超限；缓冲让压缩有地方施展。
// 3. **要有熔断**：连续失败达到上限后**停止重试**。否则一次确定性失败
//    （比如摘要 prompt 自己就过长）会被放大成每轮都付一遍的固定开销。
// 4. **决策必须是可审计的结构体，不是布尔**：上游决策带 `threshold` /
//    `effectiveContextWindow` / `tokenSource` / `reason` 等字段。理由是压缩是**会永久改写
//    上下文**的操作——事后要能回答「当时为什么压了」「用的哪个 token 数」「算出来多少」。
//    只返回 `boolean` 会让这件事永远说不清。
//
// ## b07 形态与上游的差异
//
// **(a) 不引入上游的双预算策略分支**：上游有 `legacy` / `preflight-v1` 两套输出预留
// （32_000 与 21_000 两个常量），且其代码注释自陈「旧 legacy 分支为完整模型输出预留窗口，
// **既过早压缩又要求远端选择**」。b07 没有历史包袱，**只保留一套**，并把预留做成显式配置项。
// 引入一个自陈有问题的兼容分支，只会让后来者不知道该看哪条。
//
// **(b) token 估算不在本层**：上游的 `estimateMessageTokens()` 遍历消息与 `toolCalls`
// 按「字符数 ÷ 系数」估算。b07 的 `agent-runtime` 不持有消息形态（那是 provider / workbench
// 层的事），所以本层**要求调用方传入 token 数**，只负责「拿到数之后怎么判」。
// 这样本层零依赖、可纯数据单测，也不会出现「两处各写一套估算、结果对不上」。
//
// **(c) 令牌来源双轨且必须外显**：上游允许 `tokenOverride` 覆盖估算值。b07 沿用，
// 但把来源**强制写进决策**（`tokenSource`）：估算值与 provider 实测值可能差很多，
// 事后审计必须能分辨「这次是按谁的话做的决定」。
//
// **(d) 择档成为结构性保证**：上游只回答「该不该压」，压哪一档留给调用点各自决定。
// b07 让本层顺带给出 `suggestedTier`，且档位数组本身按**代价从低到高**排序——
// 「能用便宜的就不用贵的」因此成为一条数据性质，而不是每个调用点各自记得先试轻的。
//
// **(e) 本层不执行压缩**：不产出摘要、不调模型、不改消息。实际压缩由上层注入
// （`CompactExecutor` 接缝见 `compaction-policy-contract.ts` 的说明与 `THIRD-PARTY-NOTICES.md`）。

import {
  COMPACTION_TIERS,
  type CompactionDecision,
  type CompactionPolicyConfig,
  type CompactionPolicyRequest,
  type CompactionSkipReason,
  type CompactionTier,
  type CompactionTokenSource,
} from './compaction-policy-contract.js';

/** 未知模型时的保守窗口，与 workbench 的 `contextWindowTokensFor` 取同一量级。 */
export const DEFAULT_COMPACTION_CONTEXT_WINDOW = 128_000;

/**
 * 未指定输出预留时使用的默认值。
 *
 * 取 8_192 与 workbench 的 `DEFAULT_OUTPUT_RESERVE_TOKENS` 一致。
 * **它只是"两个字段都没给"时的兜底**，不是上限——模型声明的 `maxOutputTokens`
 * 比它大时按声明值留（声明是要用的，压掉它会让阈值虚高、该压的时候没压）。
 */
export const DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS = 8_192;

/**
 * 阈值下方的默认缓冲。
 *
 * 13_000 这个量级取自上游的 `AUTOCOMPACT_BUFFER_TOKENS`——它大致等于一次压缩请求
 * 自身需要的空间量级。取更小会让压缩请求自己踩线；取更大则压缩过早、平白多花一次请求。
 */
export const DEFAULT_COMPACTION_BUFFER_TOKENS = 13_000;

/** 默认熔断阈值：连续失败达 3 次即停止重试（与上游同量级）。 */
export const DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;

/** 非负整数化的缺省回退。`undefined` / 非有限 / 负数一律视为"未指定"。 */
function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** 实际使用的上下文窗口。 */
export function resolveContextWindow(config: CompactionPolicyConfig = {}): number {
  return positiveInt(config.contextWindow) ?? DEFAULT_COMPACTION_CONTEXT_WINDOW;
}

/**
 * 实际用于预留的 output token 数。
 *
 * **优先级（顺序就是语义，改顺序会静默改行为）**：
 * 1. **显式 `outputReserveTokens` 最高** —— 调用方说留多少就留多少，此时另一个字段不参与。
 *    理由是显式配置是最强的意图表达，被一个"顺便传进来"的模型声明挤掉会很难解释。
 * 2. **`maxOutputTokens`** —— 模型声明多少就留多少。**不取它与默认值的较小者**：
 *    模型声明 10k 说明它真需要 10k 的输出空间，压成 8192 会让输入侧多占 1808 token，
 *    阈值虚高，于是**该压的时候没压**。这是保守方向的错，但错了。
 *    至于"声明值极大"的担忧（如 64k）：那由下面的夹取规则兜底——
 *    预留永远不超过窗口本身，且窗口扣除预留后不会变成负数。
 * 3. 两者都没给 → 默认上限。
 * 4. **最后夹到不超过窗口**：窗口很小时不能预留出比窗口还多的量，否则有效窗口为负。
 */
export function resolveOutputReserveTokens(config: CompactionPolicyConfig = {}): number {
  const declaredReserve = positiveInt(config.outputReserveTokens);
  const declaredMaxOutput = positiveInt(config.maxOutputTokens);
  const reserve = declaredReserve ?? declaredMaxOutput ?? DEFAULT_COMPACTION_OUTPUT_RESERVE_TOKENS;
  return Math.min(reserve, resolveContextWindow(config));
}

/**
 * 有效上下文窗口——**阈值的分母**。
 *
 * 扣掉输出预留：窗口是 input + output 共享的，自动压缩只能让出输入侧。
 * 结果夹到非负（`Math.max(0, ...)`），窗口小于预留时得 0 而不是负数。
 */
export function resolveEffectiveContextWindow(config: CompactionPolicyConfig = {}): number {
  return Math.max(0, resolveContextWindow(config) - resolveOutputReserveTokens(config));
}

/** 实际使用的缓冲 token 数。同样夹到不超过有效窗口，避免阈值被算成负数。 */
export function resolveBufferTokens(config: CompactionPolicyConfig = {}): number {
  const declared = positiveInt(config.bufferTokens) ?? DEFAULT_COMPACTION_BUFFER_TOKENS;
  return Math.min(declared, resolveEffectiveContextWindow(config));
}

/**
 * 触发阈值（绝对 token 数）。
 *
 * `有效窗口 − 缓冲`。夹到非负：缓冲大于有效窗口时阈值是 0，
 * 意味着"只要有任何内容就压"——这是极端配置下的正确退化（宁可压过头，也不要永远不压然后爆掉）。
 */
export function resolveCompactionThreshold(config: CompactionPolicyConfig = {}): number {
  return Math.max(0, resolveEffectiveContextWindow(config) - resolveBufferTokens(config));
}

/**
 * 熔断阈值。
 *
 * 0 是**合法且有意义**的值：表示"一次都不许失败，第一次失败就熔断"。
 * 所以这里不能用 `|| 缺省`（那会把 0 误吞成 3）。这是本模块唯一需要小心 0 的地方。
 */
export function resolveMaxConsecutiveFailures(config: CompactionPolicyConfig = {}): number {
  const declared = positiveInt(config.maxConsecutiveFailures);
  return declared ?? DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES;
}

/**
 * 择档：从代价最低的档位开始，取第一个"够用"的。
 *
 * 本层只给**建议**，且当前实现总是建议最便宜的一档（微压缩）。
 * 为什么不是"按超出量挑档"：挑档需要知道"微压缩能省下多少"，而那要遍历工具结果
 * （`decideMicrocompact` 的职责）。本层拿不到那个数，装作能挑就是猜。
 * **诚实的做法是：先让最便宜的一档去试，试完不够再由调用方拿新的 token 数再判一次。**
 * 这样择档是**迭代式**的，而不是本层一次算准——见下方 `tiersToTry`。
 */
export function suggestCompactionTier(): CompactionTier {
  return COMPACTION_TIERS[0];
}

/**
 * 应当依次尝试的档位（从便宜到贵）。
 *
 * 返回整个有序数组而不是单个档位，是为了让调用方能表达"试完不够再升档"这个循环，
 * 且顺序由 [`COMPACTION_TIERS`] 的数据顺序保证——调用点不需要自己记得排序。
 */
export function tiersToTry(): readonly CompactionTier[] {
  return COMPACTION_TIERS;
}

/**
 * 计算压缩决策。**纯函数**：不读时钟、不发事件、不调模型、不改输入。
 *
 * 判定顺序（任一命中即返回，**顺序本身就是设计**）：
 * 1. `enabled === false` → `disabled`。总开关最先——关掉时不该再做任何计算，
 *    更不该因为"达到熔断阈值"而报出一个调用方看不懂的原因。
 * 2. `hasEnoughMessages === false` → `not_enough_messages`。**排在熔断之前**：
 *    内容不够是"没得压"，与"上次压失败了"是两件事，混在一起会让熔断计数看起来在乱跳。
 * 3. 熔断 → `circuit_breaker`。**排在阈值之前**：熔断状态下即使超阈值也不该再压——
 *    否则熔断形同虚设（每次都"超阈值所以再试一次"）。
 * 4. token < 阈值 → `below_threshold`。
 * 5. 兜底 → `above_threshold`。
 */
export function decideCompaction(request: CompactionPolicyRequest): CompactionDecision {
  const config = request.config ?? {};
  const contextWindow = resolveContextWindow(config);
  const effectiveContextWindow = resolveEffectiveContextWindow(config);
  const outputReserveTokens = resolveOutputReserveTokens(config);
  const bufferTokens = resolveBufferTokens(config);
  const threshold = resolveCompactionThreshold(config);
  const maxConsecutiveFailures = resolveMaxConsecutiveFailures(config);
  const consecutiveFailures = Math.max(0, positiveInt(request.consecutiveFailures) ?? 0);

  // provider 实测优先于本地估算；来源一并记下。
  const override = request.tokenOverride;
  const tokenSource: CompactionTokenSource = override?.source ?? 'estimate';
  const tokenCount = Math.max(0, positiveInt(override?.tokenCount ?? request.tokenCount) ?? 0);

  const common = {
    tokenCount,
    tokenSource,
    threshold,
    contextWindow,
    effectiveContextWindow,
    outputReserveTokens,
    bufferTokens,
    consecutiveFailures,
    maxConsecutiveFailures,
  } as const;

  const circuitOpen = consecutiveFailures >= maxConsecutiveFailures;

  if (config.enabled === false) {
    return { ...common, circuitOpen, shouldCompact: false, reason: 'disabled' };
  }
  // 内容不够排在熔断之前：这是"没得压"，不是"压失败了"。
  if (request.hasEnoughMessages === false) {
    return { ...common, circuitOpen, shouldCompact: false, reason: 'not_enough_messages' };
  }
  // 熔断排在阈值之前：熔断状态下即使超阈值也不该再压，否则熔断形同虚设。
  if (circuitOpen) {
    return { ...common, circuitOpen, shouldCompact: false, reason: 'circuit_breaker' satisfies CompactionSkipReason };
  }
  if (tokenCount < threshold) {
    return { ...common, circuitOpen, shouldCompact: false, reason: 'below_threshold' };
  }
  return { ...common, circuitOpen, shouldCompact: true, reason: 'above_threshold', suggestedTier: suggestCompactionTier() };
}

/**
 * 决策是否应当被记入审计流。
 *
 * **只有触发了才记**。理由：这个判定会在每个轮次前执行，若"未触发"也记，
 * 事件流会被 `below_threshold` 淹没（长会话里它在绝大多数轮次都成立），
 * 真正重要的触发事件反而被埋掉。诊断需要时，调用方可以单独记录 `threshold` 与 `tokenCount`。
 */
export function shouldRecordCompactionDecision(decision: CompactionDecision): boolean {
  return decision.shouldCompact;
}

/**
 * 一条人类可读的决策摘要。
 *
 * 用于日志与诊断。**不含任何 token 正文**——本层只认识数字，不持有内容，
 * 天然不会泄漏上下文（这也是"不持有消息形态"这条边界的额外收益）。
 */
export function formatCompactionDecision(decision: CompactionDecision): string {
  const parts = [
    decision.shouldCompact ? '压缩：触发' : `压缩：未触发（${decision.reason}）`,
    `token=${decision.tokenCount}(${decision.tokenSource})`,
    `阈值=${decision.threshold}`,
    `有效窗口=${decision.effectiveContextWindow}(窗口 ${decision.contextWindow} − 输出预留 ${decision.outputReserveTokens})`,
    `缓冲=${decision.bufferTokens}`,
  ];
  if (decision.circuitOpen) {
    parts.push(`熔断中(${decision.consecutiveFailures}/${decision.maxConsecutiveFailures})`);
  }
  if (decision.suggestedTier !== undefined) {
    parts.push(`建议档位=${decision.suggestedTier}`);
  }
  return parts.join(' | ');
}
