import { useCallback, useMemo, useRef, useState } from 'react';
import { ZCodeAgentAdapter, type ZCodeAgentEvent, type ZCodePermissionRequestContext, type ZCodeUserInputRequestContext } from './zcode-agent-adapter';
import { initialZcodeSessionProjection, reduceZcodeSessionEvent, type ZcodeSessionProjectionState } from './zcode-session-projector';
import { zcodeWorkspaceRoot } from './zcode-process-client';
import { reconcileAgentToolCallTree, type AgentToolCallTreeNode } from '../agent-tool-tree';

/**
 * ZCode 会话 React 挂载点：adapter（子进程 + 协议）→ 事件投影 → 层级树。
 *
 * 职责边界：这里是唯一持有 adapter 实例与裁决回调的地方。反向请求（权限 /
 * 用户输入）进入**带 id 的审批队列**——两条并发请求各占一位、各答一次，
 * 关闭会话时对全部未决请求明确拒绝（fail-closed）。响应契约按 ZCode 协议
 * 分流：requestPermission → { decision }，requestUserInput → { action }。
 */

export type ZcodeSessionStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export interface ZcodePendingRequest {
  /** 队列内唯一标识：来自请求参数的 requestId，缺失时由本地计数生成。 */
  readonly id: string;
  readonly kind: 'permission' | 'userInput';
  readonly toolName: string;
  readonly reason: string;
  readonly riskLevel: string;
  readonly inputPreview: string;
  resolve(decision: 'allow' | 'deny', reason?: string): void;
}

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
  respondRequest(id: string, decision: 'allow' | 'deny', reason?: string): void;
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
        if (event.kind === 'notification' && event.method === 'session/streamIncomplete') {
          setStreamIncomplete(true);
        }
      },
      onPermissionRequest: (context: ZCodePermissionRequestContext) => {
        const params = (context.params ?? {}) as Record<string, unknown>;
        const id = typeof params.requestId === 'string' && params.requestId ? params.requestId : `perm-${++requestCounter.current}`;
        setPendingRequests((current) => [
          ...current,
          {
            id,
            kind: 'permission',
            toolName: typeof params.toolName === 'string' ? params.toolName : context.method,
            reason: typeof params.reason === 'string' ? params.reason : '',
            riskLevel: typeof params.riskLevel === 'string' ? params.riskLevel : 'unknown',
            inputPreview: inputPreview(params.input),
            resolve: (decision, reason) => context.respond(decision, reason),
          },
        ]);
      },
      onUserInputRequest: (context: ZCodeUserInputRequestContext) => {
        const params = (context.params ?? {}) as Record<string, unknown>;
        const id = typeof params.requestId === 'string' && params.requestId ? params.requestId : `input-${++requestCounter.current}`;
        setPendingRequests((current) => [
          ...current,
          {
            id,
            kind: 'userInput',
            toolName: typeof params.toolName === 'string' ? params.toolName : '用户输入',
            reason: typeof params.prompt === 'string' ? params.prompt : '',
            riskLevel: 'unknown',
            inputPreview: Array.isArray(params.questions) ? inputPreview(params.questions) : inputPreview(params.input),
            // 契约映射：界面上的「允许/拒绝」→ 协议的 accept/decline（R1 审计 04）。
            resolve: (decision, reason) => context.respond(decision === 'allow' ? 'accept' : 'decline', undefined, reason),
          },
        ]);
      },
      onExit: (code) => {
        adapterRef.current = undefined;
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

  const respondRequest = useCallback((id: string, decision: 'allow' | 'deny', reason?: string): void => {
    setPendingRequests((current) => {
      // 先移除再应答：同一条请求不可能被应答两次（重复点击是 no-op）。
      const target = current.find((request) => request.id === id);
      if (!target) return current;
      target.resolve(decision, reason);
      return current.filter((request) => request.id !== id);
    });
  }, []);

  const close = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current;
    adapterRef.current = undefined;
    // 关闭会话 = 对全部未决请求明确拒绝，不允许有请求悬空（R1 审计 05）。
    setPendingRequests((current) => {
      for (const request of current) request.resolve('deny', 'session closed');
      return [];
    });
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
