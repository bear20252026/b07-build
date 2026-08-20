import type {
  AdministratorAuthorityLedger,
  ComponentManagementAuthority,
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
  TrustedDesktopIssuerRegistry,
} from '@awo/agent-runtime';
import type { KnowledgeWorkspaceService, SkillPackRegistry } from '@awo/knowledge-workflow';
import type { LocalModelHealthRegistry, ProviderProfileRegistry } from '@awo/provider-sdk';
import type { InputProvenanceV1, TaskEvent } from '@awo/protocol';
import type { ControlPlaneDiagnosticReportV1 } from '../control-plane-diagnostics.js';
import type { SecurityPostureReportV1 } from '@awo/agent-runtime';
import type { GatewayComponentLockReportV1 } from '../component-lock-report.js';
import type { GatewayComponentManagementReportV1 } from '../component-management-report.js';

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
  readonly administratorLeases: AdministratorAuthorityLedger;
  readonly trustedDesktopIssuers: TrustedDesktopIssuerRegistry;
  readonly controlPlaneDiagnostics: () => ControlPlaneDiagnosticReportV1;
  readonly securityPostureAudit: () => SecurityPostureReportV1;
  /** 仅由进程内已认证 native host 调用；HTTP router 与 Workbench 不暴露 manage()。 */
  readonly componentManagement: ComponentManagementAuthority;
  readonly componentManagementReport: () => GatewayComponentManagementReportV1;
  readonly componentLockReport: () => GatewayComponentLockReportV1;
  readonly defaultKnowledgeWorkspaceId: string;
  readonly requests: Map<string, TaskRuntimeRequest>;
  readonly eventsByRun: Map<string, TaskEvent[]>;
  readonly approvedActions: Set<string>;
  readonly createTaskRequest: (
    goal: string,
    profileId: import('@awo/protocol').AgentProfileId,
    authorityMode: import('@awo/protocol').ExecutionAuthorityMode,
    identity: { taskId: string; runId: string },
    externalInputProvenance?: readonly InputProvenanceV1[],
  ) => TaskRuntimeRequest;
  readonly createEvent: (type: TaskEvent['type'], taskId: string, runId: string, payload: Record<string, unknown>) => TaskEvent;
}
