// 一个文件=一种作用：本地可恢复任务运行时工厂；只编排既有端口，不实现 DB、UI 或具体工具。
import type { AgentProfileId, CapabilityPolicy } from '@awo/protocol';
import { getAgentProfile, ProfiledCapabilityPolicy } from './agent-profile.js';
import { ControlledToolRunner, type ApprovalPort } from './controlled-tool-runner.js';
import {
  DAGExecutor,
  type DAGExecutionStats,
  type DAGNode,
  type DAGNodeOutcome,
  type Emit,
  type ToolRunner,
} from './executor.js';
import { InMemoryExecutionBudget } from './execution-budget.js';

export type TaskRunStatus = 'created' | 'running' | 'blocked' | 'completed' | 'failed';

export interface LocalTaskSnapshot {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  profileId: AgentProfileId;
  status: TaskRunStatus;
  nodeOutcomes: Readonly<Record<string, DAGNodeOutcome>>;
  stats?: Readonly<DAGExecutionStats>;
  attempt: number;
  updatedAt: number;
}

/** 本地优先存储端口：内存、SQLite append-only 或 Rust 控制面适配器都可替换。 */
export interface TaskSnapshotStore {
  load(taskId: string, runId: string): LocalTaskSnapshot | undefined;
  save(snapshot: LocalTaskSnapshot): void;
}

function copySnapshot(snapshot: LocalTaskSnapshot): LocalTaskSnapshot {
  return {
    ...snapshot,
    nodeOutcomes: { ...snapshot.nodeOutcomes },
    stats: snapshot.stats ? { ...snapshot.stats } : undefined,
  };
}

/** 用于本地开发和测试；生产 SQLite 适配器可在不触碰运行时语义的情况下替换它。 */
export class InMemoryTaskSnapshotStore implements TaskSnapshotStore {
  private readonly snapshots = new Map<string, LocalTaskSnapshot>();

  load(taskId: string, runId: string): LocalTaskSnapshot | undefined {
    const snapshot = this.snapshots.get(`${taskId}:${runId}`);
    return snapshot ? copySnapshot(snapshot) : undefined;
  }

  save(snapshot: LocalTaskSnapshot): void {
    this.snapshots.set(`${snapshot.taskId}:${snapshot.runId}`, copySnapshot(snapshot));
  }
}

export interface RecoverableTaskRequest {
  taskId: string;
  runId: string;
  profileId: AgentProfileId;
  nodes: readonly DAGNode[];
  baselinePolicy: CapabilityPolicy;
  approvals: ApprovalPort;
  runner: ToolRunner;
  emit: Emit;
  maxConcurrency?: number;
  now?: () => number;
}

/**
 * 本地任务运行时工厂。恢复只跳过 `ok` 节点；failed/blocked 节点会在下一次调用中重新接受策略与审批判断。
 */
export class RecoverableTaskRuntime {
  constructor(
    private readonly request: RecoverableTaskRequest,
    private readonly snapshots: TaskSnapshotStore,
  ) {}

  async run(): Promise<LocalTaskSnapshot> {
    const now = this.request.now ?? Date.now;
    const profile = getAgentProfile(this.request.profileId);
    const existing = this.snapshots.load(this.request.taskId, this.request.runId);
    const nodeOutcomes: Record<string, DAGNodeOutcome> = { ...(existing?.nodeOutcomes ?? {}) };
    for (const [nodeId, outcome] of Object.entries(nodeOutcomes)) {
      if (outcome !== 'ok') delete nodeOutcomes[nodeId];
    }

    let snapshot: LocalTaskSnapshot = {
      schemaVersion: 1,
      taskId: this.request.taskId,
      runId: this.request.runId,
      profileId: this.request.profileId,
      status: 'running',
      nodeOutcomes,
      stats: undefined,
      attempt: (existing?.attempt ?? 0) + 1,
      updatedAt: now(),
    };
    this.snapshots.save(snapshot);

    const policy = new ProfiledCapabilityPolicy(profile, this.request.baselinePolicy);
    const controlledRunner = new ControlledToolRunner(
      policy,
      this.request.approvals,
      this.request.runner,
      this.request.emit,
      new InMemoryExecutionBudget({
        maxToolCalls: profile.maxToolCalls,
        maxIdenticalCalls: profile.maxIdenticalCalls,
      }),
    );
    const dagRunner: ToolRunner = {
      run: async (node) => {
        const result = await controlledRunner.run({
          taskId: this.request.taskId,
          runId: this.request.runId,
          actionId: `${this.request.runId}:${node.id}`,
          callId: node.id,
          inputHash: node.idempotencyKey ?? node.id,
          tool: node.tool,
          at: now(),
        });
        return {
          ok: result.status === 'ok',
          outputRef: result.outputRef,
          blocked: result.blocked,
          errorCode: result.errorCode,
        };
      },
    };

    const executor = new DAGExecutor(
      { taskId: this.request.taskId, runId: this.request.runId, now },
      this.request.emit,
      dagRunner,
      {
        maxConcurrency: this.request.maxConcurrency,
        completedNodeIds: Object.entries(nodeOutcomes)
          .filter(([, outcome]) => outcome === 'ok')
          .map(([nodeId]) => nodeId),
        // ControlledToolRunner 是唯一的工具事件发射者，防止本层重复记录。
        emitToolEvents: false,
        onNodeSettled: ({ nodeId, outcome }) => {
          nodeOutcomes[nodeId] = outcome;
          snapshot = {
            ...snapshot,
            nodeOutcomes: { ...nodeOutcomes },
            updatedAt: now(),
          };
          this.snapshots.save(snapshot);
        },
      },
    );

    const stats = await executor.run(this.request.nodes);
    const status: TaskRunStatus = stats.failedNodes > 0
      ? 'failed'
      : stats.blockedNodes > 0
        ? 'blocked'
        : 'completed';
    snapshot = {
      ...snapshot,
      status,
      nodeOutcomes: { ...nodeOutcomes },
      stats,
      updatedAt: now(),
    };
    this.snapshots.save(snapshot);
    return copySnapshot(snapshot);
  }
}
