// 一个文件=一种作用：压缩触发层契约（档位闭集、阈值配置、决策结构）。纯类型，零 IO。
//
// 设计约束、上游来源与许可见 `compaction-policy.ts` 模块头。

/**
 * 压缩档位闭集。
 *
 * **顺序有意义**：数组顺序即「代价从低到高」。择档时从前往后取第一个够用的，
 * 这样"能用便宜的就不用贵的"成为一条结构性保证，而不是每个调用点各自记得先试轻的。
 *
 * 与上游五档（`manual` / `auto` / `partial` / `reactive` / `session_memory`）的对照：
 * 上游那五档混了两个维度——`manual`/`auto`/`reactive` 是**触发方式**，
 * `partial` 是**范围**，`session_memory` 是**摘要来源**。混在一起会让
 * "自动触发的一次部分压缩"这种组合无处表达。b07 把三个维度拆开：
 * 档位（本类型，表达代价）、触发方式（`CompactionTrigger`）、摘要来源（不在本层，由执行器决定）。
 */
export const COMPACTION_TIERS = [
  /** 清理旧的、可再生的工具结果。最便宜，不调模型。 */
  'microcompact',
  /** 把较早的会话片段摘要成一条。要调模型——这是它更贵的原因。 */
  'summarize',
] as const;

export type CompactionTier = (typeof COMPACTION_TIERS)[number];

/** 触发方式。与档位正交：同一个档位既可能被自动触发，也可能被用户显式要求。 */
export type CompactionTrigger =
  /** 阈值触发（本层的判定结果）。 */
  | 'auto'
  /** 用户显式要求（如 `/compact`）。 */
  | 'manual'
  /** provider 报回上下文溢出，被动补救。 */
  | 'provider_overflow';

/** 压缩发生在流水线的哪个阶段。决定"压完之后主线还要不要重跑"。 */
export type CompactionPhase =
  /** 独立轮次里做的压缩，不影响主线。 */
  | 'standalone'
  /** 发请求之前——压完接着发，最理想的位置。 */
  | 'pre_request'
  /** 轮次进行中。压完需要确保当前轮的工具结果不被误清。 */
  | 'mid_turn'
  /** 请求已经失败之后的补救。 */
  | 'reactive';

/** 为什么压。与 `trigger` 分开：trigger 说"谁发起"，reason 说"因为什么"。 */
export type CompactionReason =
  /** 上下文用量逼近窗口。 */
  | 'context_limit'
  /** 用户主动要求。 */
  | 'user_requested'
  /** 切换到了窗口更小的模型。 */
  | 'model_downshift'
  /** provider 明确报回超限。 */
  | 'provider_overflow';

/**
 * token 数的来源。
 *
 * **必须外显**：估算值与 provider 实测值可能差很多。事后审计要能分辨"这次决定是按谁的话做的"。
 * 混成一个字段会让"为什么当时压了/没压"永远说不清。
 */
export type CompactionTokenSource =
  /** 本地估算（调用方按自己的口径算好传进来）。 */
  | 'estimate'
  /** provider 回报的实测用量。 */
  | 'provider_usage';

/**
 * provider 实测用量对估算值的覆盖。
 *
 * 上游的对应结构带 7 个 provider 细分字段（`cacheReadTokens` / `cacheWriteTokens` /
 * `contextUsageTokenCount` / `incrementalTokenCount` / `outputTokens` …）。b07 **只保留两个**：
 * 用来判定的总量，以及可选的缓存读量。理由是其余细分字段b07 没有消费点——
 * 收进来只是"以后可能有用"，而它们会让决策结构的每个构造点都要复制一遍。
 * 需要时由 provider 层自己记录，不进压缩决策。
 */
export interface CompactionTokenOverride {
  readonly source: 'provider_usage';
  /** 用于判定的总量（权威值）。 */
  readonly tokenCount: number;
  /** 缓存命中的读入量。只作诊断，不参与阈值判定。 */
  readonly cacheReadTokens?: number;
}

/** 阈值推导与熔断的配置。全部可选，缺省走本模块的保守值。 */
export interface CompactionPolicyConfig {
  /** 总开关。`false` 时决策恒为"不压"。 */
  readonly enabled?: boolean;
  /** 模型的完整上下文窗口（input + output 共享）。 */
  readonly contextWindow?: number;
  /** 本次请求允许的最大输出 token。用于从窗口里让出输入侧。 */
  readonly maxOutputTokens?: number;
  /**
   * 给输出预留的 token 上限。
   *
   * 为什么是"上限"而不是"直接用 maxOutputTokens"：某些模型声明了极大的输出上限，
   * 若照单全留，输入侧会被挤到几乎无法工作（阈值趋近 0，从而**每轮都触发压缩**——
   * 压缩本身也要花一次请求，这会变成死循环式的开销）。
   */
  readonly outputReserveTokens?: number;
  /** 阈值下方的缓冲。留出压缩动作本身的空间。 */
  readonly bufferTokens?: number;
  /**
   * 连续失败达到该次数后熔断（停止重试）。
   *
   * 为什么要有：一次确定性失败（如摘要请求自己就过长）若不熔断，会被放大成每轮都付一遍的固定开销。
   */
  readonly maxConsecutiveFailures?: number;
}

/**
 * 决策结果。
 *
 * **刻意带全套中间量**（阈值、有效窗口、输出预留、实际用到的 token 数与来源）：
 * 压缩是会永久改写上下文的操作，事后必须能完整复算"当时是怎么算出来的"。
 * 只返回布尔会让这件事不可审计。
 */
export interface CompactionDecision {
  /** 是否应当压缩。 */
  readonly shouldCompact: boolean;
  /** 未压缩的原因；`shouldCompact` 为 true 时是 `above_threshold`。 */
  readonly reason: CompactionSkipReason | 'above_threshold';
  /** 判定所依据的 token 数。 */
  readonly tokenCount: number;
  /** 该 token 数的来源。 */
  readonly tokenSource: CompactionTokenSource;
  /** 触发阈值（绝对 token 数）。 */
  readonly threshold: number;
  /** 完整上下文窗口。 */
  readonly contextWindow: number;
  /** 扣掉输出预留后的输入侧窗口——阈值的分母。 */
  readonly effectiveContextWindow: number;
  /** 实际用于预留的 token 数（已按上限夹取）。 */
  readonly outputReserveTokens: number;
  /** 实际用于缓冲的 token 数。 */
  readonly bufferTokens: number;
  /** 当前是否处于熔断状态（与 `shouldCompact` 独立——熔断可以同时"不该压"且"已熔断"）。 */
  readonly circuitOpen: boolean;
  /** 已累计的连续失败次数（回显输入，便于审计）。 */
  readonly consecutiveFailures: number;
  /** 熔断阈值。 */
  readonly maxConsecutiveFailures: number;
  /**
   * 若应压缩，建议的档位。
   *
   * 从 [`COMPACTION_TIERS`] 里选第一个"够用"的档位。本层只给建议，不执行——
   * 执行需要模型或工具面，那是上层的事。
   */
  readonly suggestedTier?: CompactionTier;
}

/**
 * 未压缩的原因。
 *
 * 每个取值都要能被调用方**分别处置**，否则它就不该是一个独立取值：
 * - `disabled` → 什么都不做。
 * - `circuit_breaker` → 不要再试，应当告知用户/上报。
 * - `not_enough_messages` → 什么都不做（压了会丢掉仅有的上下文）。
 * - `below_threshold` → 什么都不做，继续观察。
 */
export type CompactionSkipReason =
  | 'disabled'
  | 'circuit_breaker'
  | 'not_enough_messages'
  | 'below_threshold';

/**
 * 判定输入。
 *
 * **不含消息本身**——只有 token 数与"够不够压"的布尔。理由是本层属于 `agent-runtime`，
 * 不持有消息形态（那是 provider / workbench 层的事）。把估算口径也留给那一层，
 * 可以避免"两处各写一套估算、结果对不上"这类最难查的偏差。
 */
export interface CompactionPolicyRequest {
  /** 当前上下文占用的 token 数（估算或 provider 实测）。 */
  readonly tokenCount: number;
  /**
   * 会话里是否有足够内容可供压缩。
   *
   * 由持有消息形态的那一层判定后传入（上游的做法要遍历消息并按助手轮次分组，
   * 那需要消息本身；b07 把这部分外置为这个布尔）。
   * 缺省 `true`——宁可让调用方显式说"不够"，也不要让本层猜。
   */
  readonly hasEnoughMessages?: boolean;
  /** 已连续失败多少次（用于熔断）。缺省 0。 */
  readonly consecutiveFailures?: number;
  /** provider 实测覆盖。在场时其 `tokenCount` 优先于入参的 `tokenCount`。 */
  readonly tokenOverride?: CompactionTokenOverride;
  readonly config?: CompactionPolicyConfig;
}
