import { invoke } from '@tauri-apps/api/core';

/**
 * MCP App 文档来源客户端（R4-01）：把已准入应用的 HTML 暂存到原生侧，
 * 由 `mcpapp://` 自定义协议以**响应头 CSP** 提供独立来源的隔离文档。
 *
 * 为什么不用 srcdoc：srcdoc 文档会继承主窗口 CSP（script-src 'self'），
 * 插件的内联脚本无法运行，注入的 CSP 只能叠加不能放宽。
 * URL 形态：Windows/WebView2 把 `mcpapp://localhost/<id>/index.html` 映射为
 * `http://mcpapp.localhost/<id>/index.html`（路径保留）；其余平台保持原样。
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

export function mcpAppDocumentUrl(instanceId: string, isWindows = /Windows/i.test(navigator.userAgent)): string {
  return isWindows
    ? `http://mcpapp.localhost/${instanceId}/index.html`
    : `mcpapp://localhost/${instanceId}/index.html`;
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
