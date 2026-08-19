// 一个文件=一种作用：DAG 执行语义（节点依赖、幂等键、预算与事件发射）。
// 不碰窗口/DB/provider：工具真实执行由 capability runtime 注入（port 式依赖）。
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

export class DAGExecutor {
  constructor(
    private readonly context: DAGRunContext,
    private readonly emit: Emit,
    private readonly runner: ToolRunner,
  ) {}

  async run(nodes: DAGNode[]): Promise<void> {
    // 构造期校验：拒绝成环。
    const pending = new Map(nodes.map((node) => [node.id, node]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`cycle detected at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of nodes.find((node) => node.id === id)?.deps ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    nodes.forEach((node) => visit(node.id));

    while (pending.size > 0) {
      const ready = [...pending.values()].filter((node) =>
        node.deps.every((dependency) => !pending.has(dependency)),
      );
      if (ready.length === 0) throw new Error('DAG blocked: unresolved deps');

      for (const node of ready) {
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
        pending.delete(node.id);
      }
    }
  }
}
