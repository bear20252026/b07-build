// 一个文件=一种作用：Task / Agent 子代理工具的声明与输出预算。
//
// 复用 `@awo/protocol` 的 ToolDescriptor / ToolRegistry 契约（不再另造一套工具元数据）：
// 输出预算走 `resultBudgetChars`，超限结果由调用方裁剪，绝不整段放回父上下文。
// 工具名对齐上游 runner 的 `Agent` 事件命名（见 ZCode subagent/runner.ts）。

import { ToolRegistry, type ToolDescriptor } from '@awo/protocol';

/** 委派只读子任务（explore/scout）的工具名。 */
export const TASK_TOOL_NAME = 'Task';
/** 委派通用子代理的工具名。 */
export const AGENT_TOOL_NAME = 'Agent';

/** Task 结果预算（字符）：只读探索摘要必须短，超出即裁剪。 */
export const SUBAGENT_TASK_RESULT_BUDGET_CHARS = 16_000;
/** Agent 结果预算（字符）：通用子代理产出更长，但仍受硬上限约束。 */
export const SUBAGENT_AGENT_RESULT_BUDGET_CHARS = 32_000;

/** Task：只读委派。本身不改工作区，副作用由子任务的能力策略再收紧。 */
export function createSubagentTaskToolDescriptor(): ToolDescriptor {
  return {
    name: TASK_TOOL_NAME,
    capability: 'model.chat',
    defaultRisk: 'low',
    readOnly: true,
    destructive: false,
    sideEffectScope: 'none',
    resultBudgetChars: SUBAGENT_TASK_RESULT_BUDGET_CHARS,
    timeoutMs: 300_000,
    concurrentSafe: true,
    description: '把只读探索任务委派给子代理，只回传摘要与引用。',
  };
}

/** Agent：通用委派。子代理可能写入工作区，故非只读且作用域为本工作区。 */
export function createSubagentAgentToolDescriptor(): ToolDescriptor {
  return {
    name: AGENT_TOOL_NAME,
    capability: 'model.chat',
    defaultRisk: 'medium',
    readOnly: false,
    destructive: false,
    sideEffectScope: 'workspace',
    resultBudgetChars: SUBAGENT_AGENT_RESULT_BUDGET_CHARS,
    timeoutMs: 600_000,
    concurrentSafe: true,
    description: '把多步任务委派给通用子代理，由其独立上下文完成后回传摘要。',
  };
}

/** 注册 Task 与 Agent 两个子代理工具；重名注册由 ToolRegistry 直接拒绝。 */
export function createSubagentToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createSubagentTaskToolDescriptor());
  registry.register(createSubagentAgentToolDescriptor());
  return registry;
}

export interface SubagentResultBudgetOutcome {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/**
 * 按描述符的 `resultBudgetChars` 裁剪子代理结果；超限时在头部保留内容并追加截断标记。
 * 预算是硬上限：返回文本长度不会超过预算。
 */
export function applySubagentResultBudget(
  text: string,
  descriptor: ToolDescriptor,
): SubagentResultBudgetOutcome {
  const budget = descriptor.resultBudgetChars;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new Error(`工具 ${descriptor.name} 的 resultBudgetChars 必须是正安全整数`);
  }
  if (text.length <= budget) return { text, truncated: false, originalChars: text.length };
  const marker = '\n…（子代理结果超出预算，已截断）';
  if (budget <= marker.length) {
    return { text: marker.slice(0, budget), truncated: true, originalChars: text.length };
  }
  const head = text.slice(0, budget - marker.length);
  return { text: `${head}${marker}`, truncated: true, originalChars: text.length };
}
