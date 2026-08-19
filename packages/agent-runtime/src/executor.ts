// packages/agent-runtime/src/executor.ts
// 一个文件=一个作用：DAG 执行语义（节点=一种作用、幂等键、预算、事件发射）。
// 不碰窗口/DB/provider：工具真实执行由 capability runtime 注入（port 式依赖）。
import type { TaskEvent } from '@awo/protocol';

export type Emit = (e: TaskEvent) => void;

export interface DAGNode {
  id: string;
  kind: 'model' | 'tool';
  budget?: number;
  idempotencyKey?: string;
  deps: string[];
}

/** 工具执行器端口：消费方只依赖此接口，真实实现可整体替换（积木规则） */
export interface ToolRunner {
  run(node: DAGNode): Promise<{ ok: boolean; outputRef: string }>;
}

export class DAGExecutor {
  constructor(
    private readonly emit: Emit,
    private readonly runner: ToolRunner,
  ) {}

  async run(nodes: DAGNode[]): Promise<void> {
    // 构造期校验：拒绝成环
    const pending = new Map(nodes.map((n) => [n.id, n]));
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) throw new Error(`cycle detected at ${id}`);
      visited.add(id);
      for (const d of nodes.find((n) => n.id === id)?.deps ?? []) visit(d);
    };
    nodes.forEach((n) => visit(n.id));

    while (pending.size > 0) {
      const ready = [...pending.values()].filter((n) =>
        n.deps.every((d) => !pending.has(d)),
      );
      if (ready.length === 0) throw new Error('DAG blocked: unresolved deps');
      for (const node of ready) {
        this.emit({
          type: 'tool.called',
          callId: node.id,
          tool: { name: node.id, args: {} },
          inputHash: node.idempotencyKey ?? node.id,
          at: Date.now(),
        });
        const res = await this.runner.run(node);
        this.emit({
          type: 'tool.result',
          callId: node.id,
          status: res.ok ? 'ok' : 'error',
          outputRef: res.outputRef,
          at: Date.now(),
        });
        pending.delete(node.id);
      }
    }
  }
}
