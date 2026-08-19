// 一个文件=一种作用：DAG 调度与工具事件发射；不处理窗口、DB、Provider 或权限决策。
import { TASK_EVENT_PROTOCOL_VERSION, type TaskEvent, type ToolRef } from '@awo/protocol';

export type Emit = (event: TaskEvent) => void;

export interface DAGRunContext {
  taskId: string;
  runId: string;
  now?: () => number;
}

export interface DAGNode {
  id: string;
  kind: 'model' | 'tool';
  tool: ToolRef;
  budget?: number;
  idempotencyKey?: string;
  deps: string[];
}

/** 工具执行器端口：消费方只依赖此接口，真实实现可整体替换（积木规则）。 */
export interface ToolRunner {
  run(node: DAGNode): Promise<{ ok: boolean; outputRef: string }>;
}

export interface DAGExecutionOptions {
  /** 同时运行的独立节点数；固定上限避免 TypeScript 层意外制造无限并发。 */
  maxConcurrency?: number;
}

export interface DAGExecutionStats {
  totalNodes: number;
  startedNodes: number;
  completedNodes: number;
  failedNodes: number;
  maxObservedConcurrency: number;
}

export type ObserveDAGExecution = (stats: Readonly<DAGExecutionStats>) => void;

interface CompiledDAG {
  nodesById: Map<string, DAGNode>;
  dependents: Map<string, string[]>;
  remainingDependencies: Map<string, number>;
  initialReady: string[];
}

interface NodeCompletion {
  nodeId: string;
  ok: boolean;
}

const DEFAULT_MAX_CONCURRENCY = 4;

function resolveMaxConcurrency(options: DAGExecutionOptions): number {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('maxConcurrency 必须是正整数');
  }
  return maxConcurrency;
}

/**
 * 一次性编译与校验 DAG。后续调度只更新直接后继的入度，避免对 pending 集合进行重复全量扫描。
 */
function compileDAG(nodes: readonly DAGNode[]): CompiledDAG {
  const nodesById = new Map<string, DAGNode>();
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();

  for (const node of nodes) {
    if (!node.id) throw new Error('DAG node id 不能为空');
    if (nodesById.has(node.id)) throw new Error(`duplicate DAG node id: ${node.id}`);
    nodesById.set(node.id, node);
    dependents.set(node.id, []);
  }

  for (const node of nodes) {
    const uniqueDependencies = new Set(node.deps);
    if (uniqueDependencies.size !== node.deps.length) {
      throw new Error(`duplicate dependency declared by ${node.id}`);
    }
    for (const dependency of node.deps) {
      if (!nodesById.has(dependency)) {
        throw new Error(`unknown dependency ${dependency} referenced by ${node.id}`);
      }
      dependents.get(dependency)?.push(node.id);
    }
    remainingDependencies.set(node.id, node.deps.length);
  }

  // Kahn 校验保持 O(V+E)；若没有零入度节点且图非空，则一定包含环。
  const checkInDegree = new Map(remainingDependencies);
  const validationReady = nodes.filter((node) => checkInDegree.get(node.id) === 0).map((node) => node.id);
  let validated = 0;
  for (let cursor = 0; cursor < validationReady.length; cursor += 1) {
    const nodeId = validationReady[cursor];
    validated += 1;
    for (const dependent of dependents.get(nodeId) ?? []) {
      const next = (checkInDegree.get(dependent) ?? 0) - 1;
      checkInDegree.set(dependent, next);
      if (next === 0) validationReady.push(dependent);
    }
  }
  if (validated !== nodes.length) throw new Error('cycle detected in DAG');

  return {
    nodesById,
    dependents,
    remainingDependencies,
    initialReady: nodes.filter((node) => node.deps.length === 0).map((node) => node.id),
  };
}

/**
 * 完成驱动的、有限并发 DAG 调度器。
 *
 * 安全边界：它只调度已经交给 ToolRunner 的节点，不绕过 ControlledToolRunner 的权限、审批和预算逻辑。
 * 每个节点始终在同一 async 流中发出 `tool.called` 后再发出 `tool.result`，确保单节点事件顺序稳定。
 */
export class DAGExecutor {
  private readonly maxConcurrency: number;

  constructor(
    private readonly context: DAGRunContext,
    private readonly emit: Emit,
    private readonly runner: ToolRunner,
    options: DAGExecutionOptions = {},
    private readonly observe?: ObserveDAGExecution,
  ) {
    this.maxConcurrency = resolveMaxConcurrency(options);
  }

  async run(nodes: readonly DAGNode[]): Promise<DAGExecutionStats> {
    const compiled = compileDAG(nodes);
    const stats: DAGExecutionStats = {
      totalNodes: nodes.length,
      startedNodes: 0,
      completedNodes: 0,
      failedNodes: 0,
      maxObservedConcurrency: 0,
    };
    const ready = [...compiled.initialReady];
    const active = new Map<string, Promise<NodeCompletion>>();

    const launch = (nodeId: string): void => {
      const node = compiled.nodesById.get(nodeId);
      if (!node) throw new Error(`compiled DAG missing node ${nodeId}`);
      stats.startedNodes += 1;
      const execution = this.executeNode(node).then((result) => ({ nodeId, ...result }));
      active.set(nodeId, execution);
      stats.maxObservedConcurrency = Math.max(stats.maxObservedConcurrency, active.size);
    };

    while (ready.length > 0 || active.size > 0) {
      while (ready.length > 0 && active.size < this.maxConcurrency) {
        const nodeId = ready.shift();
        if (nodeId) launch(nodeId);
      }
      if (active.size === 0) break;

      const completed = await Promise.race(active.values());
      active.delete(completed.nodeId);
      stats.completedNodes += 1;
      if (!completed.ok) stats.failedNodes += 1;

      for (const dependent of compiled.dependents.get(completed.nodeId) ?? []) {
        const remaining = (compiled.remainingDependencies.get(dependent) ?? 0) - 1;
        compiled.remainingDependencies.set(dependent, remaining);
        if (remaining === 0) ready.push(dependent);
      }
    }

    this.observe?.(Object.freeze({ ...stats }));
    return stats;
  }

  private async executeNode(node: DAGNode): Promise<{ ok: boolean }> {
    const at = this.context.now?.() ?? Date.now();
    this.emit({
      protocolVersion: TASK_EVENT_PROTOCOL_VERSION,
      eventId: `${this.context.runId}:${node.id}:called`,
      type: 'tool.called',
      taskId: this.context.taskId,
      runId: this.context.runId,
      callId: node.id,
      tool: node.tool,
      inputHash: node.idempotencyKey ?? node.id,
      at,
    });

    try {
      const result = await this.runner.run(node);
      this.emit({
        protocolVersion: TASK_EVENT_PROTOCOL_VERSION,
        eventId: `${this.context.runId}:${node.id}:result`,
        type: 'tool.result',
        taskId: this.context.taskId,
        runId: this.context.runId,
        callId: node.id,
        status: result.ok ? 'ok' : 'error',
        outputRef: result.outputRef,
        errorCode: result.ok ? undefined : 'TOOL_FAILED',
        at: this.context.now?.() ?? Date.now(),
      });
      return { ok: result.ok };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知工具执行异常';
      this.emit({
        protocolVersion: TASK_EVENT_PROTOCOL_VERSION,
        eventId: `${this.context.runId}:${node.id}:result`,
        type: 'tool.result',
        taskId: this.context.taskId,
        runId: this.context.runId,
        callId: node.id,
        status: 'error',
        outputRef: 'runtime://tool-threw',
        errorCode: 'TOOL_FAILED',
        reason,
        at: this.context.now?.() ?? Date.now(),
      });
      return { ok: false };
    }
  }
}
