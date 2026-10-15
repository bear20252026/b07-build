// 一个文件=一种作用：Explore 只读子代理的工具面白名单与 description 排序。
//
// 移植自 ZCode `apps/zcode-cli/packages/core/src/subagent/explore-tools.ts`。
// 关键不变式（上游注释原意）：白名单刻意不含任何文件写工具（Write/Edit/ApplyPatch），
// 因此 Bash 是唯一副作用入口，只读语义靠 Explore 系统提示词与能力策略约束，
// 不能指望工具面本身兜底。

/** direct 分支：Glob/Grep 直接暴露。 */
export const EXPLORE_ALLOWED_TOOLS = [
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
] as const;

export type ExploreAllowedTool = (typeof EXPLORE_ALLOWED_TOOLS)[number];

/** embedded search 分支：去掉 Glob/Grep，搜索由 Bash 的 find/grep 接管。 */
export const EXPLORE_EMBEDDED_SEARCH_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
] as const;

/** description 里工具的固定展示优先级；未列入的工具按白名单原序追加在后。 */
const DESCRIPTION_TOOL_PRIORITY = [
  'Glob',
  'Grep',
  'Read',
  'Bash',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
] as const satisfies readonly ExploreAllowedTool[];

const DESCRIPTION_TOOL_PRIORITY_SET = new Set<string>(DESCRIPTION_TOOL_PRIORITY);

export interface ExploreToolOptions {
  /** true 时用 Bash 内嵌 find/grep 取代 Glob/Grep（对齐上游 embedded search 分支）。 */
  embeddedSearchEnabled?: boolean;
}

/** 按分支返回 Explore 工具白名单（只读，无写工具）。 */
export function buildExploreAllowedTools(options: ExploreToolOptions = {}): readonly ExploreAllowedTool[] {
  return options.embeddedSearchEnabled
    ? EXPLORE_EMBEDDED_SEARCH_ALLOWED_TOOLS
    : EXPLORE_ALLOWED_TOOLS;
}

/** 生成 Explore agent description 里的工具清单文本：先按固定优先级，再追加未列入项。 */
export function formatExploreAllowedToolsForAgentDescription(options: ExploreToolOptions = {}): string {
  const allowedTools = buildExploreAllowedTools(options);
  const allowedToolSet = new Set<string>(allowedTools);
  const prioritizedTools = DESCRIPTION_TOOL_PRIORITY.filter((tool) => allowedToolSet.has(tool));
  const unprioritizedTools = allowedTools.filter((tool) => !DESCRIPTION_TOOL_PRIORITY_SET.has(tool));
  return [...prioritizedTools, ...unprioritizedTools].join(', ');
}
