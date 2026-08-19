// 一个文件=一种作用：在调用 ToolRunner 前执行能力策略和审批门控。
import {
  TASK_EVENT_PROTOCOL_VERSION,
  type CapabilityPolicy,
  type TaskEvent,
  type ToolRef,
  type ToolStatus,
} from '@awo/protocol';
import type { Emit, ToolRunner } from './executor.js';
import { InMemoryExecutionBudget, type ExecutionBudget } from './execution-budget.js';

export interface ControlledToolRequest {
  taskId: string;
  runId: string;
  actionId: string;
  callId: string;
  inputHash: string;
  tool: ToolRef;
  at: number;
}

export interface ControlledToolResult {
  status: ToolStatus;
  outputRef: string;
  errorCode?: string;
  reason?: string;
}

export interface ApprovalPort {
  isApproved(actionId: string): boolean;
}

interface EventContext {
  protocolVersion: typeof TASK_EVENT_PROTOCOL_VERSION;
  taskId: string;
  runId: string;
  eventId: string;
  at: number;
}

function eventContext(request: ControlledToolRequest, suffix: string): EventContext {
  return {
    protocolVersion: TASK_EVENT_PROTOCOL_VERSION,
    taskId: request.taskId,
    runId: request.runId,
    eventId: `${request.callId}:${suffix}`,
    at: request.at,
  };
}

function resultEvent(
  request: ControlledToolRequest,
  result: ControlledToolResult,
  suffix: string,
): TaskEvent {
  return {
    ...eventContext(request, suffix),
    type: 'tool.result',
    callId: request.callId,
    ...result,
  };
}

/**
 * 运行时安全门：策略拒绝时绝不触达底层工具；需审批时仅在明确批准后调用。
 * 它不保存审批状态，也不实现工具本身，分别由 C4 的 ApprovalPort 与 ToolRunner 提供。
 */
export class ControlledToolRunner {
  constructor(
    private readonly policy: CapabilityPolicy,
    private readonly approvals: ApprovalPort,
    private readonly runner: ToolRunner,
    private readonly emit: Emit,
    private readonly budget: ExecutionBudget = new InMemoryExecutionBudget(),
  ) {}

  async run(request: ControlledToolRequest): Promise<ControlledToolResult> {
    const evaluation = this.policy.evaluate({
      capability: request.tool.capability,
      risk: request.tool.risk,
      taskId: request.taskId,
      runId: request.runId,
      actionId: request.actionId,
    });

    if (evaluation.decision === 'deny') {
      const result: ControlledToolResult = {
        status: 'error',
        outputRef: 'policy://denied',
        errorCode: 'CAPABILITY_DENIED',
        reason: evaluation.reason,
      };
      this.emit(resultEvent(request, result, 'denied'));
      return result;
    }

    if (evaluation.decision === 'require_approval' && !this.approvals.isApproved(request.actionId)) {
      const approvalEvent: TaskEvent = {
        ...eventContext(request, 'approval-required'),
        type: 'approval.required',
        actionId: request.actionId,
        capability: request.tool.capability,
        risk: request.tool.risk,
        reason: evaluation.reason,
      };
      this.emit(approvalEvent);

      const result: ControlledToolResult = {
        status: 'error',
        outputRef: 'policy://approval-pending',
        errorCode: 'APPROVAL_REQUIRED',
        reason: evaluation.reason,
      };
      this.emit(resultEvent(request, result, 'approval-pending'));
      return result;
    }

    const budgetDecision = this.budget.tryConsume({
      runId: request.runId,
      toolName: request.tool.name,
      inputHash: request.inputHash,
    });
    if (!budgetDecision.allowed) {
      this.emit({
        ...eventContext(request, 'execution-blocked'),
        type: 'execution.blocked',
        callId: request.callId,
        code: budgetDecision.code,
        reason: budgetDecision.reason,
      });
      const result: ControlledToolResult = {
        status: 'error',
        outputRef: 'budget://blocked',
        errorCode: budgetDecision.code,
        reason: budgetDecision.reason,
      };
      this.emit(resultEvent(request, result, 'budget-blocked'));
      return result;
    }

    const callEvent: TaskEvent = {
      ...eventContext(request, 'called'),
      type: 'tool.called',
      callId: request.callId,
      tool: request.tool,
      inputHash: request.inputHash,
    };
    this.emit(callEvent);

    const executionResult = await this.runner.run({
      id: request.callId,
      kind: 'tool',
      tool: request.tool,
      budget: undefined,
      idempotencyKey: request.inputHash,
      deps: [],
    });
    const result: ControlledToolResult = executionResult.ok
      ? { status: 'ok', outputRef: executionResult.outputRef }
      : { status: 'error', outputRef: executionResult.outputRef, errorCode: 'TOOL_FAILED' };
    this.emit(resultEvent(request, result, 'result'));
    return result;
  }
}

/** 用于测试或受控演示的只读审批端口，真实存储可在不改运行时的情况下替换。 */
export class InMemoryApprovalPort implements ApprovalPort {
  constructor(private readonly approvedActionIds: ReadonlySet<string> = new Set()) {}

  isApproved(actionId: string): boolean {
    return this.approvedActionIds.has(actionId);
  }
}
