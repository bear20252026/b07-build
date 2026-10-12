import { useCallback, useMemo, useRef, useState } from 'react';
import { ZCodeAgentAdapter, type ZCodeAgentEvent, type ZCodePermissionRequestContext } from './zcode-agent-adapter';
import { initialZcodeSessionProjection, reduceZcodeSessionEvent, type ZcodeSessionProjectionState } from './zcode-session-projector';
import { zcodeWorkspaceRoot } from './zcode-process-client';
import { reconcileAgentToolCallTree, type AgentToolCallTreeNode } from '../agent-tool-tree';

/**
 * ZCode 会话 React 挂载点：adapter（子进程 + 协议）→ 事件投影 → 层级树。
 *
 * 职责边界：这里是唯一持有 adapter 实例与权限裁决回调的地方。权限裁决走
 * 「队列一个待决请求 → 用户点击 → respond」的最小闭环，与 use-direct-conversations
 * 的 pendingWorkspaceWrite 模式一致；没有裁决回调时 adapter 层缺省 deny（fail-closed），
 * 这里挂上回调后由用户逐条决定。
 *
 * 事件归约用 useReducer（reduceZcodeSessionEvent 是纯函数）；层级树每轮用
 * reconcileAgentToolCallTree 与上一棵树做引用稳定对比，避免流式更新击穿 memo。
 */

export type ZcodeSessionStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export interface ZcodePendingPermission {
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
  readonly pendingPermission?: ZcodePendingPermission;
  connect(options: { executable: string; workspacePath?: string }): Promise<void>;
  send(content: string): Promise<void>;
  respondPermission(decision: 'allow' | 'deny', reason?: string): void;
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
  const [pendingPermission, setPendingPermission] = useState<ZcodePendingPermission>();
  const adapterRef = useRef<ZCodeAgentAdapter | undefined>(undefined);
  const treeRef = useRef<readonly AgentToolCallTreeNode[]>([]);
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
    treeRef.current = [];
    // 工作区路径缺省时向原生侧查询当前选中工作区根（与会话进程的工作目录同源）。
    const workspacePath = (options.workspacePath ?? await zcodeWorkspaceRoot()).trim();
    if (!workspacePath) throw new Error('workspace-root-not-selected');
    const adapter = new ZCodeAgentAdapter({
      executable,
      workspace: { workspacePath, workspaceKey: workspacePath },
      onEvent: (event) => applyEvent(event),
      onPermissionRequest: (context: ZCodePermissionRequestContext) => {
        const params = (context.params ?? {}) as Record<string, unknown>;
        setPendingPermission({
          toolName: typeof params.toolName === 'string' ? params.toolName : context.method,
          reason: typeof params.reason === 'string' ? params.reason : '',
          riskLevel: typeof params.riskLevel === 'string' ? params.riskLevel : 'unknown',
          inputPreview: inputPreview(params.input),
          resolve: (decision, reason) => {
            setPendingPermission(undefined);
            context.respond(decision, reason);
          },
        });
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

  const respondPermission = useCallback((decision: 'allow' | 'deny', reason?: string): void => {
    setPendingPermission((current) => {
      current?.resolve(decision, reason);
      return undefined;
    });
  }, []);

  const close = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current;
    adapterRef.current = undefined;
    setPendingPermission(undefined);
    setStatus((current) => (current === 'idle' ? current : 'closed'));
    await adapter?.close().catch(() => undefined);
  }, []);

  const toolTree = useMemo(() => treeRef.current, [projection.toolCalls]);

  return { status, ...(sessionId ? { sessionId } : {}), ...(error ? { error } : {}), projection, toolTree, ...(pendingPermission ? { pendingPermission } : {}), connect, send, respondPermission, close };
}
