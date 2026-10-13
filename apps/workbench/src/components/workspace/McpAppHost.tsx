import { useEffect, useMemo, useRef } from 'react';
import { buildMcpAppSandbox, gateMcpAppMessage, injectContentSecurityPolicy, type McpAppAdmission } from '@awo/protocol';
import { McpAppInstanceLease } from '../../runtime/zcode/mcp-app-lease';

/**
 * MCP Apps 宿主：把已准入的交互式应用 HTML 渲染进沙箱 iframe。
 *
 * 隔离完全来自 @awo/protocol 的准入策略（R2 审计确认的边界）：
 * - iframe sandbox 只带 allow-scripts/allow-forms——应用停留在不透明源，
 *   无法触碰宿主 DOM / 存储 / 顶层导航 / 弹窗；
 * - 应用 HTML 经 injectContentSecurityPolicy 注入宿主 CSP（多条取交集）；
 * - 应用 → 宿主的所有 postMessage 都过 gateMcpAppMessage 白名单 + 大小限制 +
 *   工具二次准入校验，违规消息只记录不执行。
 *
 * 本组件不执行任何工具：onToolCallRequest 由持有 MCP 连接的页面注入；
 * 结果经 postMessage 回给 iframe（目标源必须为 '*'——沙箱化 iframe 处于
 * 不透明源，这是浏览器规定的唯一合法 targetOrigin）。
 */

export interface McpAppHostProps {
  /** 已通过 validateMcpAppManifest 准入的应用。 */
  readonly admission: McpAppAdmission;
  /** 应用 HTML（来自其声明服务器对应的 MCP 资源），宿主注入 CSP 后经 srcdoc 渲染。 */
  readonly html: string;
  /** 执行应用请求的工具调用；未提供时调用请求被记录并拒绝。 */
  readonly onToolCallRequest?: (toolName: string, args: unknown) => Promise<unknown>;
  /** 准入策略违规（未知消息类型、超限、未准入工具）时回调，供审计记录。 */
  readonly onGateViolation?: (reason: string, detail: unknown) => void;
}

/** 工具调用结果回传给 iframe 的信封（与 gateMcpAppMessage 的类型白名单对应）。 */
export function toolCallResultMessage(toolCallId: string, ok: boolean, result: unknown): { type: 'toolCallResult'; payload: { toolCallId: string; ok: boolean; result: unknown } } {
  return { type: 'toolCallResult', payload: { toolCallId, ok, result } };
}

export function McpAppHost({ admission, html, onToolCallRequest, onGateViolation }: McpAppHostProps) {
  const sandbox = useMemo(() => buildMcpAppSandbox(admission.manifest), [admission.manifest]);
  const document = useMemo(() => injectContentSecurityPolicy(html, sandbox.contentSecurityPolicy), [html, sandbox.contentSecurityPolicy]);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // 实例租约（R1 审计 R4-03）：iframe 每次（重新）加载都换代，迟到的工具结果
  // 只有代际仍匹配才回投——跨插件结果错投在投递边界被封闭。
  const leaseRef = useRef(new McpAppInstanceLease());
  const latest = useRef({ admission, onToolCallRequest, onGateViolation });
  latest.current = { admission, onToolCallRequest, onGateViolation };

  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const frame = frameRef.current;
      // 只接受当前 iframe 自己发出的消息：来源窗口不匹配直接忽略。
      if (!frame || event.source !== frame.contentWindow) return;
      const gated = gateMcpAppMessage(event.data, latest.current.admission);
      if (!gated.ok) {
        latest.current.onGateViolation?.(gated.reason, event.data);
        return;
      }
      if (gated.type !== 'toolCallRequest') return;
      const payload = (gated.payload ?? {}) as Record<string, unknown>;
      const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
      const executor = latest.current.onToolCallRequest;
      if (!toolCallId || !toolName || !executor) {
        latest.current.onGateViolation?.('mcpapp-tool-executor-unavailable', event.data);
        void frame.contentWindow?.postMessage(toolCallResultMessage(toolCallId, false, 'tool execution unavailable'), '*');
        return;
      }
      leaseRef.current.issue(toolCallId);
      void executor(toolName, payload.arguments)
        .then((result) => {
          // 结果回投前校验代际：iframe 已导航/重载时旧实例的结果被丢弃。
          if (!leaseRef.current.deliver(toolCallId)) {
            latest.current.onGateViolation?.('mcpapp-result-stale-instance', { toolCallId });
            return;
          }
          frame.contentWindow?.postMessage(toolCallResultMessage(toolCallId, true, result), '*');
        })
        .catch((error: unknown) => {
          if (!leaseRef.current.deliver(toolCallId)) {
            latest.current.onGateViolation?.('mcpapp-result-stale-instance', { toolCallId });
            return;
          }
          frame.contentWindow?.postMessage(toolCallResultMessage(toolCallId, false, error instanceof Error ? error.message : String(error)), '*');
        });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div data-mcp-app-id={admission.manifest.id} style={{ display: 'grid', gap: 8 }}>
      <div style={{ color: 'var(--muted)', fontSize: 11 }}>
        沙箱化 MCP 应用：{admission.manifest.displayName} · 可调用工具 {admission.admittedToolNames.join('、') || '无'}
      </div>
      <iframe
        ref={frameRef}
        sandbox={sandbox.sandboxAttributes.join(' ')}
        srcDoc={document}
        onLoad={() => {
          // 每次文档（重新）加载都是新实例：旧代际的未决结果就此失效。
          leaseRef.current.rotate();
        }}
        style={{ width: '100%', minHeight: 320, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)' }}
        title={admission.manifest.displayName}
      />
    </div>
  );
}
