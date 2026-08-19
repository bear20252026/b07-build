import type {
  AgentAdapterControlPlane,
  AuditedScheduleControlPlane,
  ExtensionActivationPlanner,
  ExtensionDoctor,
  ExtensionRegistry,
  McpRegistry,
  ReadOnlySubtaskService,
  RunTrajectoryLedger,
  SqliteExtensionPlanStore,
  SqliteTaskCommandReceiptStore,
  LocalTaskRuntimeService,
  TaskRuntimeRequest,
} from '@awo/agent-runtime';
import type { KnowledgeWorkspaceService, SkillPackRegistry } from '@awo/knowledge-workflow';
import type { LocalModelHealthRegistry, ProviderProfileRegistry } from '@awo/provider-sdk';
import type { TaskEvent } from '@awo/protocol';

/** Gateway route 使用的组合对象；只能由 composition root 创建并注入。 */
export interface GatewayDependencies {
  readonly runtime: LocalTaskRuntimeService;
  readonly commandReceipts: SqliteTaskCommandReceiptStore;
  readonly readOnlySubtasks: ReadOnlySubtaskService;
  readonly mcpRegistry: McpRegistry;
  readonly extensionRegistry: ExtensionRegistry;
  readonly extensionPlanStore: SqliteExtensionPlanStore;
  readonly extensionActivationPlanner: ExtensionActivationPlanner;
  readonly extensionDoctor: ExtensionDoctor;
  readonly providerProfiles: ProviderProfileRegistry;
  readonly localModelHealth: LocalModelHealthRegistry;
  readonly knowledgeWorkspaces: KnowledgeWorkspaceService;
  readonly skillPacks: SkillPackRegistry;
  readonly agentAdapters: AgentAdapterControlPlane;
  readonly schedules: AuditedScheduleControlPlane;
  readonly runTrajectory: RunTrajectoryLedger;
  readonly defaultKnowledgeWorkspaceId: string;
  readonly requests: Map<string, TaskRuntimeRequest>;
  readonly eventsByRun: Map<string, TaskEvent[]>;
  readonly approvedActions: Set<string>;
  readonly createTaskRequest: (goal: string, profileId: import('@awo/protocol').AgentProfileId, identity: { taskId: string; runId: string }) => TaskRuntimeRequest;
  readonly createEvent: (type: TaskEvent['type'], taskId: string, runId: string, payload: Record<string, unknown>) => TaskEvent;
}
