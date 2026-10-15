import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildMcpAppBridgeError,
  buildMcpAppBridgeResponse,
  buildMcpAppInitializeResult,
  buildMcpAppSandbox,
  injectContentSecurityPolicy,
  mapToolResultToCallToolResult,
  negotiateMcpAppProtocolVersion,
  parseMcpAppBridgeMessage,
  MCP_APP_BRIDGE_ERROR_CODES,
  MCP_APP_MAX_MESSAGE_CHARS,
  type McpAppAdmission,
  type McpAppBridgeHostDescriptor,
} from '@awo/protocol';
import { McpAppInstanceLease } from '../../runtime/zcode/mcp-app-lease';
import { mcpAppDocumentUrlForApp, releaseMcpAppDocument, stageMcpAppDocument } from '../../runtime/zcode/mcp-app-document-client';

/**
 * MCP Apps 宿主：把已准入的交互式应用 HTML 渲染进沙箱 iframe。
 *
 * 隔离完全来自 @awo/protocol 的准入策略（R2 审计确认的边界）：
 * - iframe sandbox 只带 allow-scripts/allow-forms——应用停留在不透明源，
 *   无法触碰宿主 DOM / 存储 / 顶层导航 / 弹窗；
 * - 应用 HTML 经 injectContentSecurityPolicy 注入宿主 CSP（多条取交集）；
 * - 应用 → 宿主走官方 ext-apps 线格式（R4-02）：parseMcpAppBridgeMessage
 *   方法白名单 + 大小限制 + 工具二次准入，违规只记录并按 JSON-RPC 语义应答。
 *
 * 本组件不执行任何工具：onToolCallRequest 由持有 MCP 连接的页面注入；
 * 结果按官方 CallToolResult 形状回给 iframe（目标源必须为 '*'——沙箱化
 * iframe 处于不透明源，这是浏览器规定的唯一合法 targetOrigin）。
 */

/** 握手时缺省暴露的宿主身份：桌面端 AI Work OS，可代理工具调用。 */
const DEFAULT_HOST_DESCRIPTOR: McpAppBridgeHostDescriptor = {
  hostInfo: { name: 'AI Work OS', version: '0.19.0' },
  hostCapabilities: { serverTools: {} },
  hostContext: { platform: 'desktop' },
};

export interface McpAppHostProps {
  /** 已通过 validateMcpAppManifest 准入的应用。 */
  readonly admission: McpAppAdmission;
  /** 应用 HTML（来自其声明服务器对应的 MCP 资源），宿主注入 CSP 后经 srcdoc 渲染。 */
  readonly html: string;
  /** 执行应用请求的工具调用；未提供时调用请求被记录并以 internalError 应答。 */
  readonly onToolCallRequest?: (toolName: string, args: unknown) => Promise<unknown>;
  /** 握手时暴露给应用的宿主身份（hostInfo / capabilities / context）；缺省为桌面端默认身份。 */
  readonly hostDescriptor?: McpAppBridgeHostDescriptor;
  /** 准入策略违规（未知方法、超限、未准入工具）时回调，供审计记录。 */
  readonly onGateViolation?: (reason: string, detail: unknown) => void;
}

export function McpAppHost({ admission, html, onToolCallRequest, hostDescriptor, onGateViolation }: McpAppHostProps) {
  const sandbox = useMemo(() => buildMcpAppSandbox(admission.manifest), [admission.manifest]);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // 实例租约（R1 审计 R4-03）：iframe 每次（重新）加载都换代，迟到的工具结果
  // 只有代际仍匹配才回投——跨插件结果错投在投递边界被封闭。
  const leaseRef = useRef(new McpAppInstanceLease());
  const latest = useRef({ admission, onToolCallRequest, hostDescriptor, onGateViolation });
  latest.current = { admission, onToolCallRequest, hostDescriptor, onGateViolation };

  // R4-01：优先走 `mcpapp://` 独立来源（CSP 为响应头、不受主窗口 CSP 继承限制）；
  // 原生暂存不可用时回退 srcdoc + 注入 CSP（局限：主窗口 script-src 'self' 仍会
  // 阻止内联脚本——回退路径只保证隔离，不保证应用能运行）。
  const [servedUrl, setServedUrl] = useState<string>();
  const [fallbackDocument, setFallbackDocument] = useState<string>();
  const instanceIdRef = useRef(`app-${crypto.randomUUID()}`);
  useEffect(() => {
    let cancelled = false;
    const csp = sandbox.contentSecurityPolicy;
    void (async () => {
      try {
        await stageMcpAppDocument(instanceIdRef.current, html, csp);
        if (!cancelled) {
          setFallbackDocument(undefined);
          // P2-3：来源按 appIdentity 派生——同一 app 多次挂载共用同一 origin，
          // 不同 app 的 origin 互不相同（沙箱 iframe 是不透明源，应用之间不会串存储）。
          setServedUrl(mcpAppDocumentUrlForApp(instanceIdRef.current, admission.manifest.id));
        }
      } catch {
        if (!cancelled) {
          setServedUrl(undefined);
          setFallbackDocument(injectContentSecurityPolicy(html, csp));
        }
      }
    })();
    return () => {
      cancelled = true;
      void releaseMcpAppDocument(instanceIdRef.current).catch(() => undefined);
    };
  }, [html, sandbox.contentSecurityPolicy]);

  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const frame = frameRef.current;
      // 只接受当前 iframe 自己发出的消息：来源窗口不匹配直接忽略。
      if (!frame || event.source !== frame.contentWindow) return;
      const respond = (message: Record<string, unknown>): void => {
        void frame.contentWindow?.postMessage(message, '*');
      };
      const current = latest.current;
      const incoming = parseMcpAppBridgeMessage(event.data, current.admission);
      if (!incoming.ok) {
        current.onGateViolation?.(incoming.reason, event.data);
        // 能提取到请求 id 且判定为协议违规的，必须按 JSON-RPC error 应答——
        // 官方 SDK 应用依靠应答感知失败；非 JSON-RPC 噪声（无 code）静默丢弃。
        if (incoming.id !== undefined && incoming.code !== undefined) {
          respond(buildMcpAppBridgeError(incoming.id, incoming.code, incoming.reason));
        }
        return;
      }
      // 通知类（initialized / size-changed）无需应答；宿主当前不依据它们改变行为。
      if (incoming.kind === 'initialized' || incoming.kind === 'sizeChanged') return;
      if (incoming.kind === 'initialize') {
        respond(buildMcpAppBridgeResponse(
          incoming.id,
          buildMcpAppInitializeResult(current.hostDescriptor ?? DEFAULT_HOST_DESCRIPTOR, negotiateMcpAppProtocolVersion(incoming.protocolVersion)),
        ));
        return;
      }
      if (incoming.kind === 'ping') {
        respond(buildMcpAppBridgeResponse(incoming.id, {}));
        return;
      }
      // tools/call：准入已在桥上二次校验，这里经页面注入的执行器落到网关/连接。
      const toolCallId = String(incoming.id);
      const executor = current.onToolCallRequest;
      if (!executor) {
        current.onGateViolation?.('mcpapp-tool-executor-unavailable', event.data);
        respond(buildMcpAppBridgeError(incoming.id, MCP_APP_BRIDGE_ERROR_CODES.internalError, 'tool execution unavailable'));
        return;
      }
      leaseRef.current.issue(toolCallId);
      void executor(incoming.toolName, incoming.args)
        .then((result) => {
          // 结果回投前校验代际：iframe 已导航/重载时旧实例的结果被丢弃。
          if (!leaseRef.current.deliver(toolCallId)) {
            current.onGateViolation?.('mcpapp-result-stale-instance', { toolCallId });
            return;
          }
          // 工具执行为业务结果：成功/失败都以 CallToolResult 回（isError 表达失败）。
          respond(buildMcpAppBridgeResponse(incoming.id, mapToolResultToCallToolResult(result)));
        })
        .catch((error: unknown) => {
          if (!leaseRef.current.deliver(toolCallId)) {
            current.onGateViolation?.('mcpapp-result-stale-instance', { toolCallId });
            return;
          }
          const message = (error instanceof Error ? error.message : String(error)).slice(0, MCP_APP_MAX_MESSAGE_CHARS);
          respond(buildMcpAppBridgeResponse(incoming.id, { content: [{ type: 'text', text: message }], isError: true }));
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
      {servedUrl ? (
        <iframe
          ref={frameRef}
          sandbox={sandbox.sandboxAttributes.join(' ')}
          src={servedUrl}
          onLoad={() => {
            // 每次文档（重新）加载都是新实例：旧代际的未决结果就此失效。
            leaseRef.current.rotate();
          }}
          style={{ width: '100%', minHeight: 320, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)' }}
          title={admission.manifest.displayName}
        />
      ) : (
        <iframe
          ref={frameRef}
          sandbox={sandbox.sandboxAttributes.join(' ')}
          srcDoc={fallbackDocument ?? ''}
          onLoad={() => {
            leaseRef.current.rotate();
          }}
          style={{ width: '100%', minHeight: 320, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)' }}
          title={admission.manifest.displayName}
        />
      )}
    </div>
  );
}
