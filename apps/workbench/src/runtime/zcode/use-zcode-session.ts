import { useCallback, useMemo, useRef, useState } from 'react';
import { ZCodeAgentAdapter, type ZCodeAgentEvent, type ZCodePermissionRequestContext, type ZCodeUserInputRequestContext } from './zcode-agent-adapter';
import { initialZcodeSessionProjection, reduceZcodeSessionEvent, type ZcodeSessionProjectionState } from './zcode-session-projector';
import { zcodeWorkspaceRoot } from './zcode-process-client';
import { ApprovalRequestQueue, type ApprovalQueueEntry } from './approval-request-queue';
import { reconcileAgentToolCallTree, type AgentToolCallTreeNode } from '../agent-tool-tree';

/**
 * ZCode 会话 React 挂载点：adapter（子进程 + 协议）→ 事件投影 → 层级树。
 *
 * 职责边界：这里是唯一持有 adapter 实例与裁决回调的地方。反向请求（权限 /
 * 用户输入）进入 ApprovalRequestQueue——requestId 索引、消耗即移除的独立
 * 状态机保证恰好一次应答（R1 审计 R2：React 状态更新函数不承担事务语义）；
 * 关闭会话时对全部未决请求明确拒绝（fail-closed）。响应契约按 ZCode 协议
 * 分流：requestPermission → { decision }，requestUserInput → { action, content? }。
 */

export type ZcodeSessionStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export type ZcodePendingRequest = ApprovalQueueEntry;

export interface ZcodeSessionController {
  readonly status: ZcodeSessionStatus;
  readonly sessionId?: string;
  readonly error?: string;
  readonly projection: ZcodeSessionProjectionState;
  readonly toolTree: readonly AgentToolCallTreeNode[];
  /** 未决反向请求队列（权限 + 用户输入）；UI 逐条渲染、逐条应答。 */
  readonly pendingRequests: readonly ZcodePendingRequest[];
  readonly streamIncomplete: boolean;
  connect(options: { executable: string; workspacePath?: string }): Promise<void>;
  send(content: string): Promise<void>;
  /** 应答队列中的一条请求；decision='allow' 时 content 作为用户输入的结构化回答。 */
  respondRequest(id: string, decision: 'allow' | 'deny', reason?: string, content?: unknown): void;
  close(): Promise<void>;
}

function inputPreview(input: unknown): string {
  if (input === undefined) return '（无参数）';
  try {
    return JSON.stringify(input, null, 2).slice(0, 2_000);
  } catch {
    return String(input).slice(0, 2_000);
  }
}

/** 校验 zcodeUserInputQuestionSchema 形状；不合法整体忽略（宁可不渲染也不误答）。 */
function parseQuestions(value: unknown): ApprovalQueueEntry['questions'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return undefined;
  const questions: {
    question: string;
    header?: string;
    options: { value: string; label: string }[];
    multiSelect?: boolean;
  }[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.question !== 'string' || !candidate.question) return undefined;
    if (!Array.isArray(candidate.options) || candidate.options.length === 0) return undefined;
    const options: { value: string; label: string }[] = [];
    for (const option of candidate.options) {
      if (typeof option !== 'object' || option === null) return undefined;
      const entry = option as Record<string, unknown>;
      if (typeof entry.value !== 'string' || !entry.value || typeof entry.label !== 'string') return undefined;
      options.push({ value: entry.value, label: entry.label });
    }
    questions.push({
      question: candidate.question,
      ...(typeof candidate.header === 'string' ? { header: candidate.header } : {}),
      options,
      ...(candidate.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

export function useZcodeSession(): ZcodeSessionController {
  const [status, setStatus] = useState<ZcodeSessionStatus>('idle');
  const [sessionId, setSessionId] = useState<string>();
  const [error, setError] = useState<string>();
  const [projection, setProjection] = useState<ZcodeSessionProjectionState>(initialZcodeSessionProjection);
  const [pendingRequests, setPendingRequests] = useState<readonly ZcodePendingRequest[]>([]);
  const [streamIncomplete, setStreamIncomplete] = useState(false);
  const adapterRef = useRef<ZCodeAgentAdapter | undefined>(undefined);
  const treeRef = useRef<readonly AgentToolCallTreeNode[]>([]);
  const requestCounter = useRef(0);
  // 事务语义（入队/消耗/恰好一次应答）在队列状态机里；React state 只做展示镜像。
  const queueRef = useRef(new ApprovalRequestQueue());
  const [, setTreeTick] = useState(0);

  const applyEvent = useCallback((event: ZCodeAgentEvent): void => {
    setProjection((current) => {
      const next = reduceZcodeSessionEvent(current, event);
      if (next.toolCalls !== current.toolCalls) {
        treeRef.current = reconcileAgentToolCallTree(next.toolCalls, treeRef.current);
        setTreeTick((tick) => tick + 1);
      }
      return next;
    });
  }, []);

  const connect = useCallback(async (options: { executable: string; workspacePath?: string }): Promise<void> => {
    if (adapterRef.current) throw new Error('zcode-session-already-connected');
    const executable = options.executable.trim();
    if (!executable) throw new Error('zcode-session-options-missing');
    setStatus('connecting');
    setError(undefined);
    setProjection(initialZcodeSessionProjection);
    queueRef.current = new ApprovalRequestQueue();
    setPendingRequests([]);
    setStreamIncomplete(false);
    treeRef.current = [];
    // 工作区路径缺省时向原生侧查询当前选中工作区根（与会话进程的工作目录同源）。
    const workspacePath = (options.workspacePath ?? await zcodeWorkspaceRoot()).trim();
    if (!workspacePath) throw new Error('workspace-root-not-selected');
    const adapter = new ZCodeAgentAdapter({
      executable,
      workspace: { workspacePath, workspaceKey: workspacePath },
      onEvent: (event) => {
        applyEvent(event);
        if (event.kind !== 'notification') return;
        // 补齐无望 → 提示；权威快照救回 → 撤销提示。两条必须成对，
        // 否则缺口恢复后界面会一直挂着「视图可能不完整」。
        if (event.method === 'session/streamIncomplete') setStreamIncomplete(true);
        if (event.method === 'session/streamRecovered') setStreamIncomplete(false);
      },
      onPermissionRequest: (context: ZCodePermissionRequestContext) => {
        const params = (context.params ?? {}) as Record<string, unknown>;
        const id = typeof params.requestId === 'string' && params.requestId ? params.requestId : `perm-${++requestCounter.current}`;
        queueRef.current.add({
          id,
          kind: 'permission',
          toolName: typeof params.toolName === 'string' ? params.toolName : context.method,
          reason: typeof params.reason === 'string' ? params.reason : '',
          riskLevel: typeof params.riskLevel === 'string' ? params.riskLevel : 'unknown',
          inputPreview: inputPreview(params.input),
          resolve: (decision, reason) => context.respond(decision, reason),
        });
        setPendingRequests(queueRef.current.list());
      },
      onUserInputRequest: (context: ZCodeUserInputRequestContext) => {
        const params = (context.params ?? {}) as Record<string, unknown>;
        const id = typeof params.requestId === 'string' && params.requestId ? params.requestId : `input-${++requestCounter.current}`;
        queueRef.current.add({
          id,
          kind: 'userInput',
          toolName: typeof params.toolName === 'string' ? params.toolName : '用户输入',
          reason: typeof params.prompt === 'string' ? params.prompt : '',
          riskLevel: 'unknown',
          inputPreview: inputPreview(params.input),
          questions: parseQuestions(params.questions),
          // 契约映射（R1 审计 04）：界面 allow/deny → 协议 accept/decline；
          // content 携带界面上实际作答的结构化内容，不再裸 accept。
          resolve: (decision, reason, content) => context.respond(decision === 'allow' ? 'accept' : 'decline', content, reason),
        });
        setPendingRequests(queueRef.current.list());
      },
      onExit: (code) => {
        adapterRef.current = undefined;
        // 进程退出 = 未决请求不会再有裁决时机：全部明确拒绝（fail-closed）。
        queueRef.current.denyAll('zcode process exited');
        setPendingRequests([]);
        setStatus((current) => (current === 'error' ? current : 'closed'));
        if (code !== 0 && code !== null) setError(`ZCode 进程异常退出（code ${code}）。`);
      },
    });
    adapterRef.current = adapter;
    try {
      const id = await adapter.connect();
      setSessionId(id);
      setStatus('connected');
    } catch (connectError) {
      adapterRef.current = undefined;
      setStatus('error');
      setError(connectError instanceof Error ? connectError.message : String(connectError));
      throw connectError;
    }
  }, [applyEvent]);

  const send = useCallback(async (content: string): Promise<void> => {
    const adapter = adapterRef.current;
    if (!adapter || !adapter.sessionId) throw new Error('zcode-session-not-connected');
    await adapter.send(content);
  }, []);

  const respondRequest = useCallback((id: string, decision: 'allow' | 'deny', reason?: string, content?: unknown): void => {
    // 恰好一次应答由队列状态机保证：消耗失败（已应答/不存在）是 no-op。
    queueRef.current.respond(id, decision, reason, content);
    setPendingRequests(queueRef.current.list());
  }, []);

  const close = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current;
    adapterRef.current = undefined;
    // 关闭会话 = 对全部未决请求明确拒绝（R1 审计 05），不允许有请求悬空。
    queueRef.current.denyAll('session closed');
    setPendingRequests([]);
    setStatus((current) => (current === 'idle' ? current : 'closed'));
    await adapter?.close().catch(() => undefined);
  }, []);

  const toolTree = useMemo(() => treeRef.current, [projection.toolCalls]);

  return {
    status,
    ...(sessionId ? { sessionId } : {}),
    ...(error ? { error } : {}),
    projection,
    toolTree,
    pendingRequests,
    streamIncomplete,
    connect,
    send,
    respondRequest,
    close,
  };
}
