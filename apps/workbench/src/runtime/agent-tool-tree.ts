// 一个文件=一种作用：Agent 工具调用的层级树构建与渲染稳定 reconcile。
// 移植自 ZCode（Apache-2.0 License）packages/ui/src/lib/toolCallTree.ts，
// 类型替换为 b07 本地的 AgentToolCall 投影（字段随 ZCode 工具调用事件映射而来）。
// 相对上游的一处刻意差异：上游对「父子互相成环」的 parentToolUseId 不设防，
// 成环节点会被同时挂进对方 childToolCalls、双双从 root 消失——审计视图不能
// 丢记录，这里加环检测，成环节点回退 root 平铺。

export interface AgentToolCall {
  readonly toolId: string;
  /** 父工具调用 id（子 Agent / 嵌套工具调用）；缺省表示 root。 */
  readonly parentToolUseId?: string;
  readonly toolName: string;
  readonly title: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'denied';
  readonly startedAt?: number;
  readonly error?: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

export interface AgentToolCallTreeNode {
  readonly toolCall: AgentToolCall;
  readonly childToolCalls: readonly AgentToolCallTreeNode[];
}

interface TreeDraftNode {
  toolCall: AgentToolCall;
  childToolCalls: TreeDraftNode[];
}

interface DeepEqualBudget {
  remaining: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function areUnknownValuesEqual(left: unknown, right: unknown, budget: DeepEqualBudget): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => areUnknownValuesEqual(item, right[index], budget));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      areUnknownValuesEqual(left[key], right[key], budget),
  );
}

/** 渲染相等：流式 chunk 会频繁重建记录，语义未变的调用保留旧引用，memo 不被击穿。 */
export function areAgentToolCallsRenderEqual(left: AgentToolCall, right: AgentToolCall): boolean {
  if (left === right) {
    return true;
  }
  return (
    left.toolId === right.toolId &&
    (left.parentToolUseId ?? null) === (right.parentToolUseId ?? null) &&
    left.toolName === right.toolName &&
    left.title === right.title &&
    left.status === right.status &&
    left.error === right.error &&
    left.startedAt === right.startedAt &&
    areUnknownValuesEqual(left.input, right.input, { remaining: 500 }) &&
    areUnknownValuesEqual(left.output, right.output, { remaining: 500 })
  );
}

function collectPreviousNodes(
  nodes: readonly AgentToolCallTreeNode[],
  nodeById: Map<string, AgentToolCallTreeNode>,
): void {
  for (const node of nodes) {
    nodeById.set(node.toolCall.toolId, node);
    collectPreviousNodes(node.childToolCalls, nodeById);
  }
}

function areNodeArraysEqual(
  left: readonly AgentToolCallTreeNode[],
  right: readonly AgentToolCallTreeNode[],
): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

function finalizeToolCallTreeNode(
  draftNode: TreeDraftNode,
  previousNodeById: Map<string, AgentToolCallTreeNode>,
): AgentToolCallTreeNode {
  const childToolCalls = draftNode.childToolCalls.map((child) =>
    finalizeToolCallTreeNode(child, previousNodeById),
  );
  const previousNode = previousNodeById.get(draftNode.toolCall.toolId);

  if (
    previousNode &&
    previousNode.toolCall === draftNode.toolCall &&
    areNodeArraysEqual(previousNode.childToolCalls, childToolCalls)
  ) {
    return previousNode;
  }

  return {
    toolCall: draftNode.toolCall,
    childToolCalls,
  };
}

/** 沿 parentToolUseId 向上走，回到自己即成环（上游会因此丢节点）。 */
function formsParentCycle(toolCall: AgentToolCall, callsById: Map<string, AgentToolCall>): boolean {
  const seen = new Set<string>([toolCall.toolId]);
  let cursor = toolCall.parentToolUseId ?? null;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = callsById.get(cursor)?.parentToolUseId ?? null;
  }
  return false;
}

export function buildAgentToolCallTree(
  toolCalls: readonly AgentToolCall[] = [],
): readonly AgentToolCallTreeNode[] {
  return reconcileAgentToolCallTree(toolCalls);
}

export function reconcileAgentToolCallTree(
  toolCalls: readonly AgentToolCall[] = [],
  previousTree: readonly AgentToolCallTreeNode[] = [],
): readonly AgentToolCallTreeNode[] {
  const previousNodeById = new Map<string, AgentToolCallTreeNode>();
  collectPreviousNodes(previousTree, previousNodeById);

  const callsById = new Map<string, AgentToolCall>();
  for (const toolCall of toolCalls) {
    callsById.set(toolCall.toolId, toolCall);
  }

  const toolCallNodeById = new Map<string, TreeDraftNode>();

  for (const toolCall of toolCalls) {
    const previousNode = previousNodeById.get(toolCall.toolId);
    toolCallNodeById.set(toolCall.toolId, {
      // 性能修复原因（沿用上游）：streaming chunk 会让记录数组频繁重建，语义未变的
      // toolCall 如果每轮都换引用，子树新数组会把下游 memo 全部击穿。
      toolCall:
        previousNode && areAgentToolCallsRenderEqual(previousNode.toolCall, toolCall)
          ? previousNode.toolCall
          : toolCall,
      childToolCalls: [],
    });
  }

  const rootToolCalls: TreeDraftNode[] = [];
  for (const toolCall of toolCalls) {
    const node = toolCallNodeById.get(toolCall.toolId);
    if (!node) {
      continue;
    }

    const parentToolUseId = toolCall.parentToolUseId ?? null;
    const parentNode =
      parentToolUseId && parentToolUseId !== toolCall.toolId && !formsParentCycle(toolCall, callsById)
        ? toolCallNodeById.get(parentToolUseId)
        : undefined;

    if (parentNode) {
      parentNode.childToolCalls.push(node);
    } else {
      // 子工具找不到父节点（或父链成环）时回退到 root 平铺，避免记录直接消失。
      rootToolCalls.push(node);
    }
  }

  const nextTree = rootToolCalls.map((node) => finalizeToolCallTreeNode(node, previousNodeById));
  return areNodeArraysEqual(previousTree, nextTree)
    ? (previousTree as readonly AgentToolCallTreeNode[])
    : nextTree;
}
