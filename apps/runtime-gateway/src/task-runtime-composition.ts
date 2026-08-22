import { createHash, randomUUID } from 'node:crypto';
import type { AgentProfileId, CapabilityPolicyRule, InputProvenanceV1, TaskEvent } from '@awo/protocol';
import {
  InMemoryApprovalPort,
  LocalTaskRuntimeService,
  RuleBasedCapabilityPolicy,
  type AdministratorAuthorityLedger,
  type RunTrajectoryLedger,
  type RunWorkspaceLedger,
  type TaskFileWorkspace,
  type TaskRuntimeRequest,
  type TaskSnapshotStore,
} from '@awo/agent-runtime';
import { createTaskNodes } from './task-node-factory.js';

export interface TaskModelInferenceResult {
  readonly providerId: string;
  readonly model: string;
  readonly output: string;
  readonly outputDigest: string;
  readonly outputCharacters: number;
  readonly latencyMs: number;
}

/** 仅 Gateway composition root 注入的模型端口；任务 runner 不读取密钥、端点或环境变量。 */
export interface TaskModelInferencePort {
  infer(input: { goal: string; profileId: AgentProfileId }): Promise<TaskModelInferenceResult | undefined>;
}

export interface TaskRuntimeComposition {
  readonly runtime: LocalTaskRuntimeService;
  readonly requests: Map<string, TaskRuntimeRequest>;
  readonly eventsByRun: Map<string, TaskEvent[]>;
  readonly approvedActions: Set<string>;
  readonly createTaskRequest: (
    goal: string,
    profileId: AgentProfileId,
    authorityMode: import('@awo/protocol').ExecutionAuthorityMode,
    identity: { taskId: string; runId: string },
    externalInputProvenance?: readonly InputProvenanceV1[],
  ) => TaskRuntimeRequest;
  readonly createEvent: (type: TaskEvent['type'], taskId: string, runId: string, payload: Record<string, unknown>) => TaskEvent;
}

export interface CreateTaskRuntimeCompositionOptions {
  readonly snapshotStore: TaskSnapshotStore;
  readonly baselineRules: readonly CapabilityPolicyRule[];
  readonly administratorLeases: AdministratorAuthorityLedger;
  readonly runTrajectory: RunTrajectoryLedger;
  readonly runWorkspace: RunWorkspaceLedger;
  readonly taskFiles: TaskFileWorkspace;
  readonly modelInference?: TaskModelInferencePort;
}

function runKey(taskId: string, runId: string): string {
  return `${taskId}:${runId}`;
}

/**
 * task/run 的运行期状态仅在 Gateway 进程内；其持久证据经显式账本端口写入。
 * 此模块不读取环境变量、不创建 SQLite、不监听端口，也不向 UI 暴露文件系统或凭据。
 */
export function createTaskRuntimeComposition({
  snapshotStore,
  baselineRules,
  administratorLeases,
  runTrajectory,
  runWorkspace,
  taskFiles,
  modelInference,
}: CreateTaskRuntimeCompositionOptions): TaskRuntimeComposition {
  const runtime = new LocalTaskRuntimeService(snapshotStore);
  const requests = new Map<string, TaskRuntimeRequest>();
  const eventsByRun = new Map<string, TaskEvent[]>();
  const approvedActions = new Set<string>();

  const createEvent: TaskRuntimeComposition['createEvent'] = (type, taskId, runId, payload) => (
    { protocolVersion: '1.0', eventId: `gateway:${runId}:${type}:${randomUUID()}`, taskId, runId, at: Date.now(), type, ...payload } as TaskEvent
  );

  const createTaskRequest: TaskRuntimeComposition['createTaskRequest'] = (
    goal,
    profileId,
    authorityMode,
    identity,
    externalInputProvenance = [],
  ) => {
    const { taskId, runId } = identity;
    const inputProvenance: readonly InputProvenanceV1[] = [
      {
        schemaVersion: 1,
        inputId: `gateway-goal:${taskId}`,
        trust: 'operator-authored',
        sourceKind: 'operator',
        contentDigest: createHash('sha256').update(goal).digest('hex'),
      },
      ...externalInputProvenance,
    ];
    const generatedFilesByCall = new Map<string, readonly { logicalPath: string; content: string }[]>();
    const existingEvents = eventsByRun.get(runKey(taskId, runId));
    const events: TaskEvent[] = existingEvents ?? [
      createEvent('task.created', taskId, runId, { goal }),
      createEvent('agent.profile.selected', taskId, runId, { profileId }),
      createEvent('execution.authority.selected', taskId, runId, { authorityMode }),
      createEvent('input.provenance.recorded', taskId, runId, { provenance: inputProvenance }),
      createEvent('plan.proposed', taskId, runId, { steps: createTaskNodes(profileId).map((node) => ({ id: node.id, description: node.tool.name, risk: node.tool.risk })) }),
    ];
    if (!existingEvents) {
      for (const event of events) runTrajectory.recordTaskEvent(event, 'gateway.intent');
    }
    const request: TaskRuntimeRequest = {
      taskId,
      runId,
      goal,
      profileId,
      authorityMode,
      inputProvenance,
      administratorLeases,
      nodes: createTaskNodes(profileId),
      baselinePolicy: new RuleBasedCapabilityPolicy(baselineRules),
      approvals: new InMemoryApprovalPort(approvedActions),
      runner: {
        async run(node) {
          if (node.tool.capability === 'model.chat') {
            const result = await modelInference?.infer({ goal, profileId });
            if (result) {
              generatedFilesByCall.set(node.id, [{
                logicalPath: 'model-output/response.md',
                content: `# 模型响应\n\n- provider: ${result.providerId}\n- model: ${result.model}\n- latency: ${result.latencyMs}ms\n- digest: ${result.outputDigest}\n\n${result.output}\n`,
              }]);
            }
          }
          if (node.tool.capability === 'filesystem.read') {
            // 用户上传只能在这个 task/run 专属、能力受控的读取步骤形成瞬时文本投影。
            // 不把内容附入事件/DTO，且当前任务 runner 不会由此自动调用远程 Provider。
            taskFiles.projectUserUploadedText(taskId, runId);
          }
          if (node.tool.capability === 'filesystem.write') {
            generatedFilesByCall.set(node.id, [{
              logicalPath: 'deliverables/task-delivery.md',
              content: `# 受控任务交付\n\n本文件由已批准的 filesystem.write 工具在本地 task/run 专属目录中创建。\n\n- task: ${taskId}\n- run: ${runId}\n- 可自动执行：否\n- 可自动解压：否\n`,
            }]);
          }
          return { ok: true, outputRef: `local://task/${taskId}/${node.id}` };
        },
      },
      emit(nextEvent) {
        events.push(nextEvent);
        runTrajectory.recordTaskEvent(nextEvent, 'task-runtime');
        const artifact = runWorkspace.recordTaskEvent(nextEvent);
        if (nextEvent.type === 'tool.result' && nextEvent.status === 'ok' && artifact) {
          for (const file of generatedFilesByCall.get(nextEvent.callId) ?? []) {
            taskFiles.publishTextFile({ taskId, runId, artifactLedgerId: artifact.artifactLedgerId, ...file, createdAt: nextEvent.at });
          }
          generatedFilesByCall.delete(nextEvent.callId);
        }
      },
    };
    eventsByRun.set(runKey(taskId, runId), events);
    return request;
  };

  return { runtime, requests, eventsByRun, approvedActions, createTaskRequest, createEvent };
}
