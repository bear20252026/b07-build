// 一个文件=一种作用：AI Work OS 跨语言事件与能力策略类型（C3/C6 的唯一事实源）。

export const TASK_EVENT_PROTOCOL_VERSION = '1.0' as const;

export type TaskEventProtocolVersion = typeof TASK_EVENT_PROTOCOL_VERSION;
export type RiskLevel = 'low' | 'medium' | 'high';
export type ToolStatus = 'ok' | 'error';
export type ApprovalDecision = 'approved' | 'rejected';
export type CapabilityDecision = 'allow' | 'require_approval' | 'deny';

/**
 * 功能能力是授权的最小单位。新增能力必须先在此处声明，不能以任意字符串绕过策略层。
 */
export type Capability =
  | 'document.parse'
  | 'model.chat'
  | 'filesystem.read'
  | 'filesystem.write'
  | 'network.fetch'
  | 'shell.execute'
  | 'browser.control';

/** 每条事件都必须携带的可回放/可审计上下文。 */
export interface EventEnvelope {
  protocolVersion: TaskEventProtocolVersion;
  eventId: string;
  taskId: string;
  runId: string;
  at: number;
}

export interface PlanStep {
  id: string;
  description: string;
  risk?: RiskLevel;
}

/**
 * 工具引用同时声明能力与风险；执行器只根据该显式声明请求授权，不能猜测工具行为。
 */
export interface ToolRef {
  name: string;
  args: unknown;
  capability: Capability;
  risk: RiskLevel;
}

/**
 * 一条规则只表达一种能力的决策。缺失规则时由策略实现默认拒绝。
 * risk 未指定表示该能力的全部风险等级均匹配。
 */
export interface CapabilityPolicyRule {
  capability: Capability;
  decision: CapabilityDecision;
  risk?: RiskLevel;
  reason: string;
}

export interface CapabilityRequest {
  capability: Capability;
  risk: RiskLevel;
  taskId: string;
  runId: string;
  actionId: string;
}

export interface CapabilityEvaluation {
  decision: CapabilityDecision;
  reason: string;
}

export interface TaskCreatedEvent extends EventEnvelope {
  type: 'task.created';
  goal: string;
}

export interface PlanProposedEvent extends EventEnvelope {
  type: 'plan.proposed';
  steps: PlanStep[];
}

export interface ApprovalRequiredEvent extends EventEnvelope {
  type: 'approval.required';
  actionId: string;
  capability: Capability;
  risk: RiskLevel;
  reason: string;
}

export interface ApprovalResolvedEvent extends EventEnvelope {
  type: 'approval.resolved';
  actionId: string;
  decision: ApprovalDecision;
  resolvedBy: string;
}

export interface ToolCalledEvent extends EventEnvelope {
  type: 'tool.called';
  callId: string;
  tool: ToolRef;
  inputHash: string;
}

export interface ToolResultEvent extends EventEnvelope {
  type: 'tool.result';
  callId: string;
  status: ToolStatus;
  outputRef: string;
  errorCode?: string;
  reason?: string;
}

export interface ArtifactCreatedEvent extends EventEnvelope {
  type: 'artifact.created';
  artifactId: string;
  mime: string;
  path: string;
}

export interface TaskCompletedEvent extends EventEnvelope {
  type: 'task.completed';
  summaryRef: string;
}

export interface TaskFailedEvent extends EventEnvelope {
  type: 'task.failed';
  code: string;
  message: string;
}

/** 上下文预算器压缩历史时的可回放决策记录。 */
export interface ContextCompactedEvent extends EventEnvelope {
  type: 'context.compacted';
  retainedItemIds: string[];
  compactedItemIds: string[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  reason: 'budget_exceeded';
}

/** 执行预算阻止一次工具调用时的结构化证据。 */
export interface ExecutionBlockedEvent extends EventEnvelope {
  type: 'execution.blocked';
  callId: string;
  code: 'STEP_BUDGET_EXCEEDED' | 'REPEATED_TOOL_CALL';
  reason: string;
}

export type TaskEvent =
  | TaskCreatedEvent
  | PlanProposedEvent
  | ApprovalRequiredEvent
  | ApprovalResolvedEvent
  | ToolCalledEvent
  | ToolResultEvent
  | ArtifactCreatedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | ContextCompactedEvent
  | ExecutionBlockedEvent;

/** C4 端口：所有能力策略实现都必须遵守这一稳定接口。 */
export interface CapabilityPolicy {
  evaluate(request: CapabilityRequest): CapabilityEvaluation;
}
