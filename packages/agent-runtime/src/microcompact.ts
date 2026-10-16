// 一个文件=一种作用：微压缩——按时间触发清空旧工具结果，只保留最近若干条。
//
// 对应 b07 的 Claude Code 7 项工程设计基线之「基线 2：query.ts Agentic Loop 与
// 上下文治理」。上游把上下文治理做成四级（Snip / Microcompact / Compact /
// AutoCompact），b07 只补其中最划算的一档：**Microcompact**。
//
// ## 为什么只补这一档
//
// 「清旧工具结果」是长会话里**最能省 token 的单点操作**：一次文件读取或命令输出
// 动辄数千 token，而它们在后续轮次里的价值迅速衰减——模型已经在上文见过摘要，
// 完整原文只是占位。相比之下：
// - Snip 太轻（只裁片段），收益有限；
// - Compact 要调模型做全量摘要（上游 1,705 行），成本与风险都高得多；
// - AutoCompact 是触发层，得先有可触发的档位。
//
// 所以先做 Microcompact，用最小代码拿到主要收益。
//
// ## 设计来源与许可
//
// 设计研读自 Claude Code 还原源码 `src/services/compact/microCompact.ts`（530 行）
// 与 `timeBasedMCConfig.ts`。该上游**未以任何开源许可证发布**，与本仓库（MIT）
// **不存在许可兼容性**，故**未复制其任何代码**——不复制文件、不逐行翻译、不沿用
// 其命名（`tengu_*` 特性开关、`TimeBasedMCConfig` 等）、注释与实现结构，只研读设计
// 约束并按 b07 形态独立重写。明见 `THIRD-PARTY-NOTICES.md`。
//
// ## 从上游学到的四条设计约束
//
// 1. **只清"可清"工具的结果**：上游用白名单 `COMPACTABLE_TOOLS` 限定为文件读写、
//    shell、grep/glob、web 检索这几类——它们的结果是**可再生的事实性内容**。
//    而用户消息、模型推理、任务规划**绝不能清**：那些是意图本身，清掉等于失忆。
//    本模块把这条约束外显为调用方必须显式给出 `clearable: true`，而不是靠猜。
// 2. **按时间触发而非按比例触发**：上游的洞察是——服务端 prompt 缓存**过期后整个
//    前缀都要重写**，此时清旧结果能直接缩小要重写的量。所以触发条件是
//    「距最后一条助手消息超过阈值」（默认 60 分钟，与缓存 TTL 对齐），而不是
//    「上下文占用超过 N%」。这是**先看成本结构再定触发条件**，不是拍脑袋取比例。
// 3. **至少保留最近 1 条**：上游注释点破两个退化——`slice(-0)` 会返回整个数组
//    （反而全留），而全清会让模型**失去全部工作上下文**。两者都不可接受，
//    故下限硬性夹到 1。本模块沿用这个下限并显式断言。
// 4. **幂等**：已经是占位符的结果不得再被计入「省下多少 token」，否则重复调用会
//    虚报收益。本模块用 `isCleared` 标记跳过。
//
// ## b07 形态与上游的差异
//
// 本模块是**纯函数、零副作用**：只产出「哪些该清」的决策清单，不修改输入、不读时钟
// （时刻由调用方作为 `now` 传入）、不发事件、不调模型。理由：
// - 原因一：与 `ContextBudgeter` 保持一致的姿态——决策与执行分离，决策可单测；
// - 原因二：读时钟是隐式依赖，会让测试必须 mock 时间，也就会让"触发条件"
//   这条最需要被验证的逻辑变得难验。把 `now` 作为参数传入后，时间触发逻辑
//   可以用纯数据覆盖到分钟级边界。
// 上游在此处调模型缓存 API 并改动消息内容；b07 把"应用"留给调用方。

// 只读性判定统一走协议层的唯一入口，避免各处自行读静态布尔而漏掉逐入参判定。
import { isToolReadOnlyWith, type ToolDescriptor } from '@awo/protocol';

/**
 * 被清空的结果占位文案。
 *
 * 用**显式标记**而非空字符串：模型看到空内容会误以为工具返回了空，而看到这段
 * 文案能理解为"内容被有意省略"——这避免了模型基于"结果为空"编造结论。
 * 文案为 b07 自行拟定（上游用 `[Old tool result content cleared]`）。
 */
export const CLEARED_TOOL_RESULT_PLACEHOLDER = '[旧工具结果内容已清理]';

/**
 * 触发微压缩的默认时间阈值（分钟）。
 *
 * 60 这个值**不是随手取的**：它与服务端 prompt 缓存的 1 小时 TTL 对齐——缓存
 * 保证已过期时，整个前缀本来就要重写，此时清理是**净收益**，不会迫使一次本可
 * 避免的缓存未命中。取更小的值会在缓存尚热时清内容，反而把可复用的前缀打断。
 */
export const DEFAULT_GAP_THRESHOLD_MINUTES = 60;

/**
 * 默认保留的最近结果条数。
 *
 * 5 这个值的直觉：最近几轮的工具结果最可能仍被引用（模型刚看过，正在基于它推理）。
 * 保留太少会让模型在追问细节时找不到依据；保留太多则省不下 token。
 */
export const DEFAULT_KEEP_RECENT = 5;

/** 微压缩的配置。 */
export interface MicrocompactConfig {
  /** 总开关。关掉时决策恒为「不清」。 */
  readonly enabled: boolean;
  /**
   * 距最后一条助手消息超过该分钟数时触发。
   *
   * 依赖调用方在 `now` 与消息的 `at` 上都用**毫秒**时间戳，且语义一致。
   */
  readonly gapThresholdMinutes: number;
  /**
   * 保留最近多少条可清结果；更早的清空。
   *
   * 内部会夹到下限 1（见模块头约束 3）。设为 0 或负数不会真的清空全部。
   */
  readonly keepRecent: number;
}

/** 默认配置：关闭。要启用必须显式打开——静默改变上下文会让人难以定位问题。 */
export const DEFAULT_MICROCOMPACT_CONFIG: MicrocompactConfig = {
  enabled: false,
  gapThresholdMinutes: DEFAULT_GAP_THRESHOLD_MINUTES,
  keepRecent: DEFAULT_KEEP_RECENT,
};

/**
 * 一条可参与微压缩决策的工具结果。
 *
 * 只描述"结果"本身，不关心它挂在哪条消息上——落位由调用方按 `id` 对应。
 */
export interface ToolResultEntry {
  /** 稳定唯一标识，用于把决策映射回真实内容。 */
  readonly id: string;
  /** 工具名，用于诊断（如 `FileRead`、`Bash`）。 */
  readonly toolName: string;
  /** 结果内容的 token 估算量。 */
  readonly estimatedTokens: number;
  /**
   * 该结果是否**允许**被清理。
   *
   * 刻意由调用方显式给出，而不是本模块按工具名白名单自行判定：工具是否可清是
   * **工具注册时的事实**（文件读取可再生、用户输入不可再生），本模块不该在
   * 运行期重新发明这条判断。缺省 `false`（fail-closed：不声明就保留）。
   */
  readonly clearable?: boolean;
  /** 是否已经是占位符（幂等标记，见模块头约束 4）。 */
  readonly alreadyCleared?: boolean;
}

/** 决策输入。 */
export interface MicrocompactRequest {
  /** 当前时刻（毫秒）。由调用方注入，使触发逻辑可纯数据验证。 */
  readonly now: number;
  /** 最后一条助手消息的时刻（毫秒）。没有助手消息时传 `undefined`。 */
  readonly lastAssistantAt?: number;
  /** 会话中的工具结果，**按时间顺序**（早 → 晚）。 */
  readonly results: readonly ToolResultEntry[];
  /** 配置，缺省为 [`DEFAULT_MICROCOMPACT_CONFIG`]。 */
  readonly config?: MicrocompactConfig;
}

/**
 * 从工具描述符派生「这次的调用结果是否可清」。
 *
 * 判据是**两个条件的合取**，缺一不可：
 * - **本次调用只读** —— 无副作用，重跑不会改变世界；
 * - `sideEffectScope === 'none'` —— 作用域是纯读。
 *
 * 为什么两个都要：只读性描述"不写"，作用域描述"作用到哪"。一个只读但作用到
 * **外部世界**的工具（如外部检索）其结果是外部快照，重跑未必得到同样内容，
 * 清掉就永久丢失了当时的事实；只有"既只读、又作用域为 none"才真正是**可再生**的。
 *
 * 只读性走 [`isToolReadOnlyWith`] 而不是直接读 `readOnly` 布尔——这样逐入参的
 * 判定（`Bash("ls")` 只读、`Bash("rm -rf")` 写入）能正确传导到这里：同一个工具
 * 的只读调用结果可清、写入调用结果不可清。若直接读静态布尔，就无法表达这种差异。
 *
 * 判据来自描述符而不是硬编码工具名白名单——上游用 `COMPACTABLE_TOOLS` 字符串
 * 集合，b07 的工具集是可注册的，硬编码白名单会在新工具接入时静默失效（新工具
 * 的结果永远不被清理，而非被错误清理——是保守的失效，但它会让人困惑为什么
 * 某个工具的结果一直不清）。改成读描述符后，新工具通过自身声明自动获得正确行为。
 *
 * 描述符缺失或字段缺省时一律返回 `false`（fail-closed：不声明就保留）。
 */
export function isResultClearable(
  descriptor:
    | Pick<ToolDescriptor, 'readOnly' | 'isReadOnly' | 'sideEffectScope'>
    | undefined,
  input: Readonly<Record<string, unknown>> = {},
): boolean {
  if (descriptor === undefined) return false;
  if (descriptor.sideEffectScope !== 'none') return false;
  return isToolReadOnlyWith(descriptor, input);
}

/** 为什么没有触发（用于诊断与观测，不产生副作用）。 */
export type MicrocompactSkipReason =
  /** 总开关关闭。 */
  | 'disabled'
  /** 还没有助手消息，无从计算间隔。 */
  | 'no_assistant_message'
  /** 时间间隔未达阈值——缓存可能仍热，此时清反而是负收益。 */
  | 'below_gap_threshold'
  /** 没有可清结果（都不可清，或都已被清）。 */
  | 'nothing_clearable';

/** 决策结果。 */
export interface MicrocompactDecision {
  /** 是否触发。 */
  readonly triggered: boolean;
  /** 未触发原因；`triggered` 为 true 时不存在。 */
  readonly skipReason?: MicrocompactSkipReason;
  /** 实测时间间隔（分钟）；无法计算时为 `undefined`。 */
  readonly gapMinutes?: number;
  /** 应被清空的结果 id，按输入顺序。 */
  readonly clearIds: readonly string[];
  /** 应被保留的结果 id，按输入顺序（含不可清与最近保留的）。 */
  readonly keepIds: readonly string[];
  /** 预期省下的 token（只计本次真正会清且未被清过的条目）。 */
  readonly estimatedTokensSaved: number;
}

/**
 * 计算微压缩决策。**纯函数**：不修改输入、不读时钟、不发事件。
 *
 * 判定顺序（任一不满足即返回未触发，且带明确原因）：
 * 1. 开关是否打开；
 * 2. 是否有助手消息（无则无法算间隔）；
 * 3. 间隔是否达到阈值；
 * 4. 是否存在可清条目。
 *
 * 通过后：在**可清**条目中保留最近 `keepRecent` 条（下限 1），其余清空。
 * 不可清条目恒保留，且**不占用**保留名额——否则一个不可清条目会白白挤掉一个
 * 最近结果的保留位，这与"保留最近可清结果"的意图不符。
 */
export function decideMicrocompact(request: MicrocompactRequest): MicrocompactDecision {
  const config = request.config ?? DEFAULT_MICROCOMPACT_CONFIG;

  if (!config.enabled) {
    return {
      triggered: false,
      skipReason: 'disabled',
      clearIds: [],
      keepIds: request.results.map((entry) => entry.id),
      estimatedTokensSaved: 0,
    };
  }

  if (request.lastAssistantAt === undefined) {
    return {
      triggered: false,
      skipReason: 'no_assistant_message',
      clearIds: [],
      keepIds: request.results.map((entry) => entry.id),
      estimatedTokensSaved: 0,
    };
  }

  const gapMinutes = (request.now - request.lastAssistantAt) / 60_000;
  // NaN 与负间隔（时钟回拨）都视为未达阈值：宁可不清，也不在时间不可信时动手。
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return {
      triggered: false,
      skipReason: 'below_gap_threshold',
      gapMinutes,
      clearIds: [],
      keepIds: request.results.map((entry) => entry.id),
      estimatedTokensSaved: 0,
    };
  }

  // 只有显式声明可清、且尚未被清的条目参与。
  const clearableIndexes = request.results
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.clearable === true)
    .filter(({ entry }) => entry.alreadyCleared !== true);
  const pendingIndexes = request.results
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.clearable === true);

  // 下限夹到 1：清空全部会让模型失去工作上下文；`keepRecent <= 0` 是配置错误，
  // 但不能让它退化成"全清"这种灾难性行为。
  const keepRecent = Math.max(1, config.keepRecent);
  const keptIds = new Set(
    pendingIndexes.slice(-keepRecent).map(({ entry }) => entry.id),
  );

  const clearIds: string[] = [];
  let estimatedTokensSaved = 0;
  for (const { entry } of clearableIndexes) {
    if (keptIds.has(entry.id)) continue;
    clearIds.push(entry.id);
    estimatedTokensSaved += entry.estimatedTokens;
  }

  if (clearIds.length === 0) {
    return {
      triggered: false,
      skipReason: 'nothing_clearable',
      gapMinutes,
      clearIds: [],
      keepIds: request.results.map((entry) => entry.id),
      estimatedTokensSaved: 0,
    };
  }

  const clearedSet = new Set(clearIds);
  return {
    triggered: true,
    gapMinutes,
    clearIds,
    keepIds: request.results
      .filter((entry) => !clearedSet.has(entry.id))
      .map((entry) => entry.id),
    estimatedTokensSaved,
  };
}
