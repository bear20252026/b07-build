import { invoke } from '@tauri-apps/api/core';
import { deriveMcpAppSandboxLabel } from './mcp-app-origin';

/**
 * MCP App 文档来源客户端（R4-01）：把已准入应用的 HTML 暂存到原生侧，
 * 由 `mcpapp://` 自定义协议以**响应头 CSP** 提供独立来源的隔离文档。
 *
 * 为什么不用 srcdoc：srcdoc 文档会继承主窗口 CSP（script-src 'self'），
 * 插件的内联脚本无法运行，注入的 CSP 只能叠加不能放宽。
 *
 * URL 形态（来源 = scheme + host，路径不参与 origin；instanceId 始终在路径上）：
 * - 非 Windows：`mcpapp://<host>/<id>/index.html`；
 * - Windows/WebView2：`http://mcpapp.<host>/<id>/index.html`——wry 只拦截
 *   `http://mcpapp.*` 前缀并把 `http://mcpapp.` 还原成 `mcpapp://`（`custom_protocol_workaround.rs`），
 *   故宿主标签必须落在 `mcpapp` 与 `localhost` 之间，`<hash>.mcpapp.localhost` 不会被拦截。
 *
 * P2-3：`<host>` 由 appIdentity 派生（`mcpAppDocumentUrlForApp`），同一 app 恒定、不同 app 隔离。
 * 旧的 `mcpAppDocumentUrl` 保留共享 `localhost` 宿主，供既有调用方（GenUiHost）不变更地继续使用。
 */

export interface McpAppDocumentDeps {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
}

const defaultDeps: McpAppDocumentDeps = {
  invoke: (command, args) => invoke(command, args),
};

function nativeRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

function buildMcpAppDocumentUrl(host: string, instanceId: string, isWindows: boolean): string {
  return isWindows
    ? `http://mcpapp.${host}/${instanceId}/index.html`
    : `mcpapp://${host}/${instanceId}/index.html`;
}

/** 共享来源（宿主固定 `localhost`）：所有应用同一 origin，保留给既有调用方，勿用于新接线。 */
export function mcpAppDocumentUrl(instanceId: string, isWindows = /Windows/i.test(navigator.userAgent)): string {
  return buildMcpAppDocumentUrl('localhost', instanceId, isWindows);
}

/**
 * per-app 稳定来源（P2-3）：宿主由 appIdentity 派生，同一 app 多次挂载得到**同一 origin**，
 * 不同 app 得到**不同 origin**（隔离）；instanceId 仍在路径上，路由语义不变。
 */
export function mcpAppDocumentUrlForApp(
  instanceId: string,
  appIdentity: string,
  isWindows = /Windows/i.test(navigator.userAgent),
): string {
  // `.localhost` 保留：loopback 语义明确，且与既有 `mcpapp.localhost` 惯例一致。
  return buildMcpAppDocumentUrl(`${deriveMcpAppSandboxLabel(appIdentity)}.localhost`, instanceId, isWindows);
}

/** 暂存实例文档（同 id 重复暂存视为换代整体替换）；非原生环境明确抛错由宿主回退 srcdoc。 */
export async function stageMcpAppDocument(
  instanceId: string,
  html: string,
  contentSecurityPolicy: string,
  deps: McpAppDocumentDeps = defaultDeps,
): Promise<void> {
  if (!nativeRuntime()) throw new Error('mcpapp-native-unavailable');
  await deps.invoke('mcpapp_stage_document', { instanceId, html, contentSecurityPolicy });
}

/** 释放实例文档；幂等。 */
export async function releaseMcpAppDocument(
  instanceId: string,
  deps: McpAppDocumentDeps = defaultDeps,
): Promise<void> {
  if (!nativeRuntime()) return;
  await deps.invoke('mcpapp_release_document', { instanceId });
}
