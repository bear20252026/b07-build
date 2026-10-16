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
import { executeHookChain, type HookSelector } from './hook-executor.js';
import type { HookInvocation } from './hook-contract.js';

export interface ControlledToolRequest {
  taskId: string;
  runId: string;
  actionId: string;
  callId: string;
  inputHash: string;
  tool: ToolRef;
  at: number;
  /**
   * 工具入参。可选：老调用方不带入参时行为完全不变。
   *
   * 一旦提供，PreToolUse Hook 就能看到它、并按需改写（改写后的版本进入实际调用）。
   * 刻意保持可选，是为了让本次接入**不改动任何既有调用点的行为**。
   */
  input?: Readonly<Record<string, unknown>>;
}

export interface ControlledToolResult {
  status: ToolStatus;
  outputRef: string;
  errorCode?: string;
  reason?: string;
  /** 仅表示工具因可恢复的审批/预算门控而未启动，不等同于工具执行失败。 */
  blocked?: boolean;
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
 *
 * ## Hook 链接入（基线 1 的六段式）
 *
 * 完整顺序是「参数校验 → 规则匹配 → 用户确认 → **Hook 决策** → 实际调用 → 结果回写」。
 * 本类此前只覆盖前三段与后两段，第四段（Hook）由 `hooks` 注入后补齐：
 *
 * - `PreToolUse` 在**审批通过之后、预算扣减之前**运行。放在审批后是因为：Hook 若
 *   改写了入参，应当由改写后的版本去消耗预算；放在预算前是因为被 Hook 拦下的调用
 *   不该扣预算。
 * - `PostToolUse` 在**调用之后、结果事件之前**运行，只能观测，不影响已经发生的结果。
 *
 * `hooks` 缺省为 `undefined`，此时行为与接入前**逐字节相同**。
 */
export class ControlledToolRunner {
  constructor(
    private readonly policy: CapabilityPolicy,
    private readonly approvals: ApprovalPort,
    private readonly runner: ToolRunner,
    private readonly emit: Emit,
    private readonly budget: ExecutionBudget = new InMemoryExecutionBudget(),
    private readonly hooks?: HookSelector,
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
        blocked: true,
      };
      this.emit(resultEvent(request, result, 'approval-pending'));
      return result;
    }

    // 第四段：Hook 决策（参数校验与规则匹配已过、用户确认已过、尚未实际调用）。
    // Hook 可拦下调用，也可改写入参；改写结果进入后续所有环节（含预算与真实调用）。
    let effectiveInput = request.input;
    if (this.hooks !== undefined) {
      const chain = executeHookChain(this.hooks, 'PreToolUse', {
        event: 'PreToolUse',
        taskId: request.taskId,
        runId: request.runId,
        toolName: request.tool.name,
        toolInput: request.input,
        risk: request.tool.risk,
        capability: request.tool.capability,
      });

      if (chain.blocked) {
        const result: ControlledToolResult = {
          status: 'error',
          outputRef: 'hook://blocked',
          errorCode: 'HOOK_BLOCKED',
          reason: chain.blockReason,
          blocked: true,
        };
        this.emit(resultEvent(request, result, 'hook-blocked'));
        return result;
      }
      effectiveInput = chain.resolvedInput;
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
        blocked: true,
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

    // 真实调用携带**改写后**的入参：Hook 的 Modify 必须真正生效，否则它只是摆设。
    const executionResult = await this.runner.run({
      id: request.callId,
      kind: 'tool',
      tool: request.tool,
      input: effectiveInput,
      budget: undefined,
      idempotencyKey: request.inputHash,
      deps: [],
    });
    const result: ControlledToolResult = executionResult.ok
      ? { status: 'ok', outputRef: executionResult.outputRef }
      : { status: 'error', outputRef: executionResult.outputRef, errorCode: 'TOOL_FAILED' };

    // 第五段之后：PostToolUse 只能观测已发生的结果，其返回值不改变 result。
    if (this.hooks !== undefined) {
      const invocation: HookInvocation = {
        event: 'PostToolUse',
        taskId: request.taskId,
        runId: request.runId,
        toolName: request.tool.name,
        toolInput: effectiveInput,
        risk: request.tool.risk,
        capability: request.tool.capability,
        toolSucceeded: executionResult.ok,
      };
      // 结果事件必须在 Hook 之后发出：Hook 是"结果回写前的最后一道观测"。
      executeHookChain(this.hooks, 'PostToolUse', invocation);
    }

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
