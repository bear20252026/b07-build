// 一个文件=一种作用：Hook 契约——事件闭集、注册项形态与决策结果类型。
//
// 对应 b07 的 Claude Code 7 项工程设计基线之「基线 1：工具执行、权限与 Hook 链」。
// 该基线自 2026-08-19 确立以来，「Hook 链」一直未落地：现有 capability-policy.ts +
// permission-chain.ts 是**硬编码规则集**，不是**可注册的扩展点**——差别在于第三方
// 能否在不改代码的前提下介入工具决策。本模块补上这个扩展点。
//
// ## 设计来源与许可
//
// 设计研读自 Claude Code 还原源码 `src/utils/hooks.ts`（5022 行）与
// `src/schemas/hooks.ts` 的事件闭集与响应契约。该上游**未以任何开源许可证发布**，
// 与本仓库（MIT）**不存在许可兼容性**，故**未复制其任何代码**——不复制文件、不逐行
// 翻译、不沿用其命名、注释与实现结构，只研读设计约束并按 b07 形态独立重写。
// 明见 `THIRD-PARTY-NOTICES.md`。
//
// ## 与基线的对齐
//
// 基线 1 要求的六段式是「参数校验 → 规则匹配 → 用户确认 → Hook 决策 → 实际调用 →
// 结果回写」。其中前两段已由 `capability-policy.ts` 提供，第三段由 `permission-chain.ts`
// 与 `ApprovalPort` 提供；本模块提供第四段（Hook 决策），第五段与第六段由
// `controlled-tool-runner.ts` 提供。接入点见 `controlled-tool-runner.ts` 的
// `run()`——PreToolUse 在审批之后、调用之前，PostToolUse 在调用之后、结果回写之前。
//
// ## 三个从上游学到的关键设计
//
// 1. **Hook 的判决不只是 allow/deny**：还能**改写工具入参**（`updatedInput`）和
//    **注入额外上下文**（`additionalContext`）。这是"可插拔策略"的完整语义——
//    只有 allow/deny 的 Hook 系统无法表达"把 `rm -rf /` 改写成 `rm -rf ./tmp`"。
// 2. **过滤发生在派生之前**：上游用权限规则语法（如 `Bash(git *)`）作为 `if` 条件，
//    在启动任何外部进程**之前**就筛掉不匹配的 Hook。本模块沿用这个"先匹配后执行"
//    的顺序，且匹配是纯函数、零副作用。
// 3. **退出码 2 = 阻塞错误**：外部 Hook 用退出码区分"通过但给了意见"与"必须停下"。
//    本模块把这一语义收敛为 [`HookOutcome::Block`]，并在结果里保留 reason。

/**
 * Hook 事件的闭集。
 *
 * 刻意收窄为 b07 真实会触发的 4 个：上游有 23 个事件面，但其中大量服务于 CLI/TUI
 * 与远端会话，b07 当前没有对应机制，声明了也只会是永不触发的死代码。**宁可少而真，
 * 不要多而假**——这与本仓库对 capability-placeholder 的一贯姿态一致。
 *
 * 扩展方式：新增事件必须同时在本类型、[`HOOK_EVENTS`]、以及触发点的调用代码里出现，
 * 否则 `satisfies` 检查会在编译期失败。
 */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart';

/** 事件闭集的运行期表示（顺序即文档顺序，供 UI 与诊断稳定遍历）。 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
] as const satisfies readonly HookEvent[];

/** 运行期判定：字符串是否为已知事件。用于解析外部配置时不信任输入。 */
export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Hook 的判决。
 *
 * 注意 `Modify` 的存在：一个 Hook 可以既不拒绝也不原样放行，而是**改写入参**。
 * 这是与"只有 allow/deny"的朴素设计的分野，也是本模块存在的主要价值。
 */
export type HookOutcome =
  /** 放行，可附带注入给模型的额外上下文。 */
  | { readonly kind: 'Allow'; readonly additionalContext?: string }
  /** 放行但改写入参。改写后的入参将进入实际调用。 */
  | {
      readonly kind: 'Modify';
      readonly updatedInput: Readonly<Record<string, unknown>>;
      readonly additionalContext?: string;
    }
  /** 阻塞。reason 会作为稳定的诊断信息回给调用方。 */
  | { readonly kind: 'Block'; readonly reason: string }
  /** 本次不表态（未匹配 / 显式弃权），交给后续 Hook。 */
  | { readonly kind: 'Abstain' };

/** 一条 Hook 的注册项。 */
export interface HookRegistration {
  /** 归属事件。 */
  readonly event: HookEvent;
  /** 稳定标识，用于诊断与去重；同一 event 下不得重复。 */
  readonly id: string;
  /**
   * 可选的条件表达式——**在调用 handler 之前**评估，不匹配则整条 Hook 跳过。
   *
   * 刻意只支持两种最简形式，不做通用表达式引擎：
   * - `Tool(name)` —— 仅当工具名等于 `name` 时匹配（PreToolUse / PostToolUse）
   * - `Tool(name*)` —— 前缀通配，`Tool(mcp__*)` 匹配所有 MCP 工具
   *
   * 理由：上游用完整权限规则语法，但 b07 的工具名是 `mcp__<server>__<tool>` 这种
   * 结构化字符串，前缀通配已能表达绝大多数真实需求；引入通用引擎会增加一个需要
   * 独立审计的解析面，而它本身不是安全边界。
   */
  readonly when?: string;
  /** 执行体。必须是同步可判定的纯函数——见 `hook-executor.ts` 的超时纪律。 */
  readonly handler: HookHandler;
}

/** Hook 执行体收到的输入。按事件提供对应字段，未提供的字段为 `undefined`。 */
export interface HookInvocation {
  readonly event: HookEvent;
  /** 任务/运行标识，便于 Hook 做限域判断。 */
  readonly taskId?: string;
  readonly runId?: string;
  /** 工具相关事件提供。 */
  readonly toolName?: string;
  readonly toolInput?: Readonly<Record<string, unknown>>;
  /** 工具相关事件提供：风险等级与能力，来自 ToolRef。 */
  readonly risk?: string;
  readonly capability?: string;
  /** PostToolUse 提供：工具是否成功。 */
  readonly toolSucceeded?: boolean;
  /** UserPromptSubmit 提供：用户本轮输入正文。 */
  readonly prompt?: string;
  /** SessionStart 提供：会话启动原因。 */
  readonly source?: 'startup' | 'resume' | 'clear';
}

/** Hook 执行体。返回值必须是 [`HookOutcome`]。 */
export type HookHandler = (invocation: HookInvocation) => HookOutcome;

/**
 * 一次 Hook 链执行的聚合结果。
 *
 * `blocked` 与 `additionalContext` 刻意分开：被阻塞时上下文不该再注入模型，
 * 否则会出现"拦下了调用，却把拦截者的说明塞进了上下文"这种语义混乱。
 */
export interface HookChainResult {
  /** 是否有任一 Hook 阻塞。 */
  readonly blocked: boolean;
  /** 阻塞原因（取**第一条**阻塞者的 reason，因为后续 Hook 不会再运行）。 */
  readonly blockReason?: string;
  /** 最终入参：可能是被 `Modify` 改写过的版本，未被改写时等于原入参。 */
  readonly resolvedInput?: Readonly<Record<string, unknown>>;
  /** 所有 Allow/Modify 提供的上下文，按注册顺序拼接。 */
  readonly additionalContext?: string;
  /** 实际表态（Allow/Modify/Block）的 Hook id，按执行顺序。用于诊断。 */
  readonly appliedHookIds: readonly string[];
  /** 因条件不匹配或 Abstain 被跳过的 Hook id。用于诊断。 */
  readonly skippedHookIds: readonly string[];
}
