// 一个文件=一种作用：ZCode 会话事件 → b07 会话投影的纯归约器。
//
// 输入是 zcode-agent-adapter 分发出来的 ZCodeAgentEvent：
// - kind='event'：params 是事件信封（eventId/seq/...），adapter 把剩余字段放进 payload，
//   其中 `type` 是会话事件类型（turn.started / part.delta / tool.updated / turn.completed ...），
//   `payload` 是该类型的载荷（与 ZCode packages/shared/src/zcode-protocol 的 strict schema 对应）；
// - kind='notification'：其余通知（如 state.updated），投影器忽略。
//
// 归约产出 ZcodeSessionProjectionState：助手文本流、工具调用记录（可直接喂
// agent-tool-tree 的 reconcile）、回合状态与终止原因。全部纯函数、不可变更新，
// 失败分支（turn.failed）与正常完成一样显式；未知事件类型被忽略而不是抛错——
// 协议演进时旧投影器降级展示比整条事件流崩溃好。

import type { AgentToolCall } from '../agent-tool-tree';
import type { ZCodeAgentEvent } from './zcode-agent-adapter';

export interface ZcodeSessionProjectionState {
  /** 是否有回合在执行中。 */
  readonly turnActive: boolean;
  /** 当前/最近一个回合的事件信封 turnId。 */
  readonly turnId?: string;
  /** 助手文本（part.delta field=text 与 model.streaming text_delta 累积）。 */
  readonly text: string;
  /** 推理流（part.delta field=reasoning）。 */
  readonly reasoning: string;
  /** 工具调用记录，按首次出现顺序；可重入 reconcileAgentToolCallTree。 */
  readonly toolCalls: readonly AgentToolCall[];
  /** 最近一个回合的终态。 */
  readonly lastTurn?: {
    readonly completed: boolean;
    readonly failed: boolean;
    readonly resultType?: string;
    readonly tokenCount?: number;
    readonly error?: string;
  };
}

export const initialZcodeSessionProjection: ZcodeSessionProjectionState = {
  turnActive: false,
  text: '',
  reasoning: '',
  toolCalls: [],
};

function eventPayload(event: ZCodeAgentEvent): Record<string, unknown> | undefined {
  if (event.kind !== 'event') return undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.type !== 'string') return undefined;
  return payload;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toolStatusFor(kind: string): AgentToolCall['status'] {
  if (kind === 'scheduled') return 'pending';
  if (kind === 'result') return 'completed';
  if (kind === 'error') return 'failed';
  return 'running';
}

/** 工具更新事件：按 toolCallId 维护记录；首次出现时补齐名称/父子关系。 */
function applyToolUpdated(state: ZcodeSessionProjectionState, payload: Record<string, unknown>): ZcodeSessionProjectionState {
  const kind = optionalString(payload.kind);
  if (!kind) return state;
  const toolCallId = optionalString(payload.toolCallId);
  if (!toolCallId) return state;

  const existing = state.toolCalls.find((call) => call.toolId === toolCallId);
  const status = toolStatusFor(kind);
  const startedAt = kind === 'started' && typeof payload.startedAt === 'number' ? payload.startedAt : existing?.startedAt;
  const error = kind === 'error' ? optionalString(asRecord(payload.error)?.message) ?? '工具调用失败' : existing?.error;
  const output = kind === 'result' ? payload.result ?? existing?.output : existing?.output;

  const nextCall: AgentToolCall = {
    toolId: toolCallId,
    ...(existing?.parentToolUseId ? { parentToolUseId: existing.parentToolUseId } : typeof payload.parentToolCallId === 'string' ? { parentToolUseId: payload.parentToolCallId } : {}),
    toolName: existing?.toolName ?? optionalString(payload.toolName) ?? 'unknown-tool',
    title: existing?.title ?? optionalString(payload.description) ?? optionalString(payload.toolName) ?? toolCallId,
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(error === undefined ? {} : { error }),
    ...(kind === 'scheduled' && payload.input !== undefined ? { input: payload.input } : existing?.input !== undefined ? { input: existing.input } : {}),
    ...(output === undefined ? {} : { output }),
  };
  const toolCalls = existing
    ? state.toolCalls.map((call) => (call.toolId === toolCallId ? nextCall : call))
    : [...state.toolCalls, nextCall];
  return { ...state, toolCalls };
}

export function reduceZcodeSessionEvent(
  state: ZcodeSessionProjectionState,
  event: ZCodeAgentEvent,
): ZcodeSessionProjectionState {
  const payload = eventPayload(event);
  if (!payload) return state;
  const type = payload.type;
  const inner = asRecord(payload.payload);

  if (type === 'turn.started') {
    return {
      ...initialZcodeSessionProjection,
      turnActive: true,
      ...(event.kind === 'event' && event.envelope.turnId ? { turnId: event.envelope.turnId } : {}),
    };
  }
  if (type === 'part.delta') {
    const field = optionalString(inner?.field) ?? 'text';
    const delta = optionalString(inner?.delta) ?? '';
    if (!delta) return state;
    if (field === 'reasoning') return { ...state, reasoning: state.reasoning + delta };
    if (field === 'text') return { ...state, text: state.text + delta };
    return state;
  }
  if (type === 'model.streaming' && inner) {
    const kind = optionalString(inner.kind);
    const delta = optionalString(inner.delta) ?? '';
    if ((kind === 'text_delta' || kind === 'reasoning_delta') && delta) {
      return kind === 'text_delta' ? { ...state, text: state.text + delta } : { ...state, reasoning: state.reasoning + delta };
    }
    return state;
  }
  if (type === 'tool.updated') return applyToolUpdated(state, inner ?? {});
  if (type === 'turn.completed') {
    const response = optionalString(inner?.response);
    return {
      ...state,
      turnActive: false,
      text: response ?? state.text,
      lastTurn: {
        completed: true,
        failed: false,
        ...(optionalString(inner?.resultType) ? { resultType: optionalString(inner?.resultType) } : {}),
        ...(typeof inner?.tokenCount === 'number' ? { tokenCount: inner.tokenCount } : {}),
      },
    };
  }
  if (type === 'turn.failed') {
    return {
      ...state,
      turnActive: false,
      lastTurn: {
        completed: false,
        failed: true,
        error: optionalString(asRecord(inner?.error)?.message) ?? '回合执行失败',
      },
    };
  }
  return state;
}

export function reduceZcodeSessionEvents(
  state: ZcodeSessionProjectionState,
  events: readonly ZCodeAgentEvent[],
): ZcodeSessionProjectionState {
  let next = state;
  for (const event of events) next = reduceZcodeSessionEvent(next, event);
  return next;
}
