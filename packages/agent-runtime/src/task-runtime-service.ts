// 一个文件=一种作用：任务运行时服务边界；可由 HTTP/IPC/CLI 适配器调用，不包含传输协议实现。
import type { DAGNode } from './executor.js';
import {
  RecoverableTaskRuntime,
  type LocalTaskSnapshot,
  type RecoverableTaskRequest,
  type TaskSnapshotStore,
} from './recoverable-task-runtime.js';

export interface TaskRuntimeRequest extends RecoverableTaskRequest {
  /** 为调用方保留任务目标；运行时不把自然语言直接当作权限或工具参数。 */
  goal: string;
}

export interface TaskRuntimeService {
  submit(request: TaskRuntimeRequest): Promise<LocalTaskSnapshot>;
  resume(request: TaskRuntimeRequest): Promise<LocalTaskSnapshot>;
  snapshot(taskId: string, runId: string): LocalTaskSnapshot | undefined;
}

/**
 * Node 本地运行时实现。submit 与 resume 共享同一可恢复工厂：是否恢复由快照是否存在决定，
 * 但两个语义入口可供 UI/API 做明确授权与审计。
 */
export class LocalTaskRuntimeService implements TaskRuntimeService {
  constructor(private readonly snapshots: TaskSnapshotStore) {}

  async submit(request: TaskRuntimeRequest): Promise<LocalTaskSnapshot> {
    this.assertTaskShape(request.nodes, request.goal);
    return new RecoverableTaskRuntime(request, this.snapshots).run();
  }

  async resume(request: TaskRuntimeRequest): Promise<LocalTaskSnapshot> {
    const existing = this.snapshots.load(request.taskId, request.runId);
    if (!existing) throw new Error(`cannot resume missing run ${request.runId}`);
    this.assertTaskShape(request.nodes, request.goal);
    return new RecoverableTaskRuntime(request, this.snapshots).run();
  }

  snapshot(taskId: string, runId: string): LocalTaskSnapshot | undefined {
    return this.snapshots.load(taskId, runId);
  }

  private assertTaskShape(nodes: readonly DAGNode[], goal: string): void {
    if (!goal.trim()) throw new Error('task goal 不能为空');
    if (nodes.length === 0) throw new Error('task 至少需要一个可验证 DAG 节点');
  }
}
