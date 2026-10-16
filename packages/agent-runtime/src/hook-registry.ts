// 一个文件=一种作用：Hook 注册表与条件匹配（纯函数，零副作用）。
//
// 注册表只做两件事：登记 Hook、按事件 + 条件筛出待执行的子集。它**不执行**任何
// handler——那是 `hook-executor.ts` 的职责。这个切分让"筛"与"跑"可以分别测试，
// 且让匹配逻辑能保证是纯函数（可断言无副作用）。
//
// 设计研读自 Claude Code 还原源码 `src/utils/hooks.ts` 的 `getMatchingHooks`
// 与 `schemas/hooks.ts` 的 `if` 条件字段。上游用完整权限规则语法；b07 收敛为
// 前缀通配（理由见 `hook-contract.ts` 的 `when` 字段说明）。

import type { HookEvent, HookRegistration } from './hook-contract.js';

/** 第 1 段：`Tool(` 前缀。 */
const TOOL_PREFIX = 'Tool(';

/**
 * 条件表达式匹配失败的原因。返回 `null` 表示匹配成功。
 *
 * 把失败原因做成返回值（而非抛异常）是为了让注册期的**语法错误**与运行期的
 * **条件不匹配**能被区分诊断——前者是配置 bug，后者是正常流程。
 */
export type WhenConditionError = 'syntax' | undefined;

/**
 * 判断一个 `when` 条件是否匹配给定工具名。
 *
 * 支持两种形式（其余一律视为语法错误，由 [`validateWhenCondition`] 在注册期拦截）：
 * - `Tool(name)` —— 精确匹配
 * - `Tool(name*)` —— 前缀通配（`*` 只能在末尾）
 *
 * `when` 为 `undefined` 时恒匹配（无条件 Hook）。
 * 工具类事件未提供 `toolName` 时，带条件的 Hook 一律**不匹配**（fail-closed：
 * 不知道工具名就不该跑有工具条件的 Hook）。
 */
export function matchesWhen(
  when: string | undefined,
  toolName: string | undefined,
): boolean {
  if (when === undefined) {
    return true;
  }
  // 有条件但没有工具名 → 不匹配。宁可少跑一个 Hook，也不在信息不全时误跑。
  if (toolName === undefined) {
    return false;
  }

  const parsed = parseWhen(when);
  if (parsed === null) {
    // 语法错误的条件：注册期就该被拦。运行期若仍遇到，按不匹配处理，
    // 不让畸形配置意外扩大 Hook 的作用面。
    return false;
  }

  if (parsed.kind === 'exact') {
    return toolName === parsed.value;
  }
  return toolName.startsWith(parsed.prefix);
}

type ParsedWhen =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'prefix'; readonly prefix: string };

/**
 * 解析 `when` 条件。语法错误返回 `null`。
 *
 * 严格的语法校验是必要的：`Tool(` 之后的 `*` 只允许出现在**末尾且仅一个**。
 * 若放行 `Tool(m*p)` 这种中缀通配，实现者很容易写出"实际按前缀匹配、但用户以为
 * 是中缀匹配"的静默错误——安全相关的条件不该有歧义。
 */
export function parseWhen(when: string): ParsedWhen | null {
  if (!when.startsWith(TOOL_PREFIX) || !when.endsWith(')')) {
    return null;
  }
  const inner = when.slice(TOOL_PREFIX.length, -1);
  if (inner.length === 0) {
    return null;
  }

  const starIndex = inner.indexOf('*');
  if (starIndex === -1) {
    // 精确匹配。工具名不得含 `*` 或空白（工具名是结构化的 `mcp__a__b` 形态）。
    if (inner.includes(' ') || inner.includes('*')) {
      return null;
    }
    return { kind: 'exact', value: inner };
  }

  // 通配：`*` 必须在末尾，且只有一个。
  if (starIndex !== inner.length - 1) {
    return null;
  }
  if (inner.slice(0, -1).includes('*')) {
    return null;
  }
  const prefix = inner.slice(0, -1);
  if (prefix.length === 0) {
    // `Tool(*)` 等价于无条件——但写成条件形式会让读者以为它有筛选作用，
    // 拒掉它比静默接受更诚实。
    return null;
  }
  if (prefix.includes(' ')) {
    return null;
  }
  return { kind: 'prefix', prefix };
}

/** 注册期校验：条件语法是否合法。 */
export function validateWhenCondition(when: string | undefined): WhenConditionError {
  if (when === undefined) {
    return undefined;
  }
  return parseWhen(when) === null ? 'syntax' : undefined;
}

/** 注册失败的原因。 */
export type HookRegistrationError =
  /** 同一 event 下 id 重复。 */
  | { readonly code: 'hook_id_duplicate'; readonly event: HookEvent; readonly id: string }
  /** `when` 条件语法非法。 */
  | { readonly code: 'hook_when_invalid'; readonly event: HookEvent; readonly id: string; readonly when: string };

/**
 * Hook 注册表。
 *
 * 不可变登记：`register` 返回错误而非抛异常，让调用方能按自己的诊断通道处理。
 * 一经登记的 Hook 不提供运行期改写——与 `ToolDescriptor` 一致，"改契约必须走新版本
 * 注册"，避免运行期偷偷放宽策略。
 */
export class HookRegistry {
  private readonly byEvent = new Map<HookEvent, HookRegistration[]>();

  /**
   * 登记一条 Hook。
   *
   * 双重校验：id 在同一事件下唯一、`when` 语法合法。两者都在**注册期**拦截，
   * 而不是等到触发时才失败——配置错误应当尽早暴露。
   */
  register(registration: HookRegistration): HookRegistrationError | null {
    const { when } = registration;
    // 先窄化再校验：`validateWhenCondition` 只在 `when` 存在时才可能返回 'syntax'，
    // 因此下面的错误分支里 `when` 已被证明是 string，无需 `?? ''` 兜底。
    if (when !== undefined && validateWhenCondition(when) === 'syntax') {
      return {
        code: 'hook_when_invalid',
        event: registration.event,
        id: registration.id,
        when,
      };
    }

    const existing = this.byEvent.get(registration.event) ?? [];
    if (existing.some((item) => item.id === registration.id)) {
      return {
        code: 'hook_id_duplicate',
        event: registration.event,
        id: registration.id,
      };
    }

    this.byEvent.set(registration.event, [...existing, registration]);
    return null;
  }

  /**
   * 某事件下已登记的 Hook。
   *
   * 每次返回**新数组**：类型上的 `readonly` 只挡编译期，挡不住 JS 调用方或断言绕过，
   * 而这里泄漏的是注册表内部存储——外部一次 `push` 就能悄悄塞进未经校验的 Hook。
   * 复制成本与 Hook 数量同阶，相对每次工具调用的开销可忽略。
   */
  registrationsFor(event: HookEvent): readonly HookRegistration[] {
    return [...(this.byEvent.get(event) ?? [])];
  }

  /** 已登记的 Hook 总数。 */
  get size(): number {
    let total = 0;
    for (const list of this.byEvent.values()) {
      total += list.length;
    }
    return total;
  }

  /**
   * 按事件与工具名筛出**待执行**的 Hook，保持注册顺序。
   *
   * 这是"过滤发生在派生之前"的落点：返回的是需要跑的清单，不匹配的在这之前已剔除。
   * 纯函数、零副作用——不调用任何 handler，不读任何外部状态。
   */
  matching(event: HookEvent, toolName: string | undefined): readonly HookRegistration[] {
    return this.registrationsFor(event).filter((item) =>
      matchesWhen(item.when, toolName),
    );
  }
}
