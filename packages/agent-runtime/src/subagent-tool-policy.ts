// 一个文件=一种作用：子代理工具面剔除（plan 工具等强制禁用项）。
//
// 移植自 ZCode `apps/zcode-cli/packages/core/src/subagent/tool-policy.ts`。
// 上游注释的理由必须保留：子 agent 没有独立的 plan approval 恢复面，暴露 plan
// 工具会让 ExitPlanMode 等待用户确认并卡住父 turn，因此所有子 agent 的工具面统一剔除，
// 与 profile 自己声明的 disallowedTools 叠加。

/** 进入计划模式工具名。 */
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';
/** 退出计划模式工具名。 */
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

/** 任何子代理都不得暴露的强制禁用工具（不受 profile 覆盖）。 */
export const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
] as const;

/** 工具名别名归一（对齐上游 tool-visibility：web_search → WebSearch）。 */
export function normalizeSubagentToolNameAlias(toolName: string): string {
  return toolName === 'web_search' ? 'WebSearch' : toolName;
}

/** 规则形如 `Tool` 或 `Tool(pattern)`；取括号前的工具名并做别名归一。 */
function toolRuleName(rule: string): string {
  const trimmed = rule.trim();
  const parenIndex = trimmed.indexOf('(');
  const rawName = parenIndex > 0 ? trimmed.slice(0, parenIndex) : trimmed;
  return normalizeSubagentToolNameAlias(rawName);
}

/** 强制禁用项 + profile 声明的 disallowedTools（顺序：强制项在前）。 */
export function buildSubagentChildDisallowRules(
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  return [...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS, ...(disallowedTools ?? [])];
}

/** 单个工具名是否落在子代理禁用面内。 */
export function isSubagentChildToolDisallowed(
  toolName: string,
  disallowedTools: readonly string[] | undefined,
): boolean {
  const normalized = normalizeSubagentToolNameAlias(toolName);
  return buildSubagentChildDisallowRules(disallowedTools).some((rule) => toolRuleName(rule) === normalized);
}

/**
 * 过滤子代理可用工具名：剔除强制禁用项与 profile 的 disallowedTools。
 * 返回新数组，不修改入参；`['*']` 通配不受影响（它不是被禁工具名）。
 */
export function filterSubagentChildToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  const disallowed = new Set<string>();
  for (const rule of buildSubagentChildDisallowRules(disallowedTools)) {
    const name = toolRuleName(rule);
    if (name) disallowed.add(name);
  }
  return toolNames.filter((toolName) => !disallowed.has(normalizeSubagentToolNameAlias(toolName)));
}
