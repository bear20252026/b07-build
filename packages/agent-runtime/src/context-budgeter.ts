// 一个文件=一种作用：按 token 预算选择上下文，并产出可审计的压缩决策。
import { TASK_EVENT_PROTOCOL_VERSION, type ContextCompactedEvent } from '@awo/protocol';

export interface ContextItem {
  id: string;
  estimatedTokens: number;
  /** 数值越高，表示越接近当前任务的必要信息。 */
  priority: number;
}

export interface ContextBudgetRequest {
  taskId: string;
  runId: string;
  at: number;
  maxTokens: number;
  items: readonly ContextItem[];
}

export interface ContextBudgetResult {
  retained: readonly ContextItem[];
  compacted: readonly ContextItem[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  event?: ContextCompactedEvent;
}

function assertValid(request: ContextBudgetRequest): void {
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 0) {
    throw new Error('maxTokens 必须是非负整数');
  }
  const seen = new Set<string>();
  for (const item of request.items) {
    if (!item.id) throw new Error('上下文项必须拥有 id');
    if (seen.has(item.id)) throw new Error(`上下文项 id 重复：${item.id}`);
    if (!Number.isInteger(item.estimatedTokens) || item.estimatedTokens < 0) {
      throw new Error(`上下文项 ${item.id} 的 estimatedTokens 必须是非负整数`);
    }
    if (!Number.isFinite(item.priority)) {
      throw new Error(`上下文项 ${item.id} 的 priority 必须是有限数值`);
    }
    seen.add(item.id);
  }
}

/**
 * 决策稳定且可解释：优先级高的项优先保留；同优先级时保持原始顺序。
 * 不修改内容本身，也不调用模型摘要；实际摘要器后续只消费 compacted 清单。
 */
export class ContextBudgeter {
  select(request: ContextBudgetRequest): ContextBudgetResult {
    assertValid(request);
    const estimatedTokensBefore = request.items.reduce((total, item) => total + item.estimatedTokens, 0);
    if (estimatedTokensBefore <= request.maxTokens) {
      return {
        retained: [...request.items],
        compacted: [],
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
      };
    }

    const ranked = request.items
      .map((item, index) => ({ item, index }))
      .sort((left, right) => right.item.priority - left.item.priority || left.index - right.index);
    const retainedIds = new Set<string>();
    let estimatedTokensAfter = 0;

    for (const { item } of ranked) {
      if (estimatedTokensAfter + item.estimatedTokens > request.maxTokens) continue;
      retainedIds.add(item.id);
      estimatedTokensAfter += item.estimatedTokens;
    }

    const retained = request.items.filter((item) => retainedIds.has(item.id));
    const compacted = request.items.filter((item) => !retainedIds.has(item.id));
    const event: ContextCompactedEvent = {
      protocolVersion: TASK_EVENT_PROTOCOL_VERSION,
      eventId: `${request.runId}:context-compacted:${request.at}`,
      type: 'context.compacted',
      taskId: request.taskId,
      runId: request.runId,
      at: request.at,
      retainedItemIds: retained.map((item) => item.id),
      compactedItemIds: compacted.map((item) => item.id),
      estimatedTokensBefore,
      estimatedTokensAfter,
      reason: 'budget_exceeded',
    };
    return { retained, compacted, estimatedTokensBefore, estimatedTokensAfter, event };
  }
}
