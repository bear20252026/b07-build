import type {
  AdministratorAuthorityLedger,
  AgentAdapterControlPlane,
  AuditedScheduleControlPlane,
  ExtensionActivationPlanner,
  ExtensionDoctor,
  ExtensionRegistry,
  McpRegistry,
  ReadOnlySubtaskService,
  RunTrajectoryLedger,
  RunWorkspaceLedger,
  SqliteExtensionPlanStore,
  SqliteTaskCommandReceiptStore,
  LocalTaskRuntimeService,
  LocalProjectWorkspaceService,
  TaskRuntimeRequest,
  TaskFileWorkspace,
  TrustedDesktopIssuerRegistry,
} from '@awo/agent-runtime';
import type { KnowledgeWorkspaceService, SkillPackRegistry } from '@awo/knowledge-workflow';
import type { LocalModelHealthRegistry, ProviderConnectionService, ProviderInferenceService, ProviderProfileRegistry, SessionCustomProviderService } from '@awo/provider-sdk';
import type { InputProvenanceV1, TaskEvent } from '@awo/protocol';
import type { ControlPlaneDiagnosticReportV1 } from '../control-plane-diagnostics.js';
import type { SecurityPostureReportV1 } from '@awo/agent-runtime';
import type { GatewayComponentLockReportV1 } from '../component-lock-report.js';
import type { GatewayComponentManagementReportV1 } from '../component-management-report.js';
import type { GatewayNativeHostAuthenticationReportV1 } from '../native-host-authentication-report.js';
import type { GatewayWindowsNativeReleaseReportV1 } from '../windows-native-release-report.js';

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
  /** 只暴露登记、激活、脱敏状态与操作者显式 probe；密钥解析仍封装在服务内部。 */
  readonly providerConnections: ProviderConnectionService;
  /** 实际推理仅接受现有 active Profile；route 不能传入凭据、端点、驱动或工具定义。 */
  readonly providerInference: ProviderInferenceService;
  /** custom 连接只存在当前 Gateway 进程；route 无法读取其 endpoint、header 或密钥。 */
  readonly customProviders: SessionCustomProviderService;
  readonly localModelHealth: LocalModelHealthRegistry;
  readonly knowledgeWorkspaces: KnowledgeWorkspaceService;
  readonly skillPacks: SkillPackRegistry;
  readonly agentAdapters: AgentAdapterControlPlane;
  readonly schedules: AuditedScheduleControlPlane;
  readonly runTrajectory: RunTrajectoryLedger;
  /** 运行产出与检查点仅为脱敏、不可复放 metadata。 */
  readonly runWorkspace: RunWorkspaceLedger;
  /** task/run 专属的受控文件、文本预览和显式 ZIP 交付服务；路由永远不获得裸文件系统。 */
  readonly taskFiles: TaskFileWorkspace;
  /** 项目只管理本地 metadata 与 task/run 归属，不能读取文件、密钥或执行任务。 */
  readonly projects: LocalProjectWorkspaceService;
  readonly administratorLeases: AdministratorAuthorityLedger;
  readonly trustedDesktopIssuers: TrustedDesktopIssuerRegistry;
  readonly controlPlaneDiagnostics: () => ControlPlaneDiagnosticReportV1;
  readonly securityPostureAudit: () => SecurityPostureReportV1;
  /** 仅投影脱敏认证摘要；HTTP router 不持有 challenge、envelope 或 component management mutation 端口。 */
  readonly nativeHostAuthenticationReport: () => GatewayNativeHostAuthenticationReportV1;
  /** Windows-only 脱敏发布摘要；HTTP router 不持有 release evidence、expected digest 或 bridge trust mutation。 */
  readonly windowsNativeReleaseReport: () => GatewayWindowsNativeReleaseReportV1;
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
