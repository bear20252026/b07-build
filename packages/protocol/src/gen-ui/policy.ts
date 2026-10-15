// 一个文件=一种作用：Gen UI 沙箱策略——iframe sandbox 属性与 CSP（含 CDN 静态域白名单）的
// 确定性生成，复用 b07 既有 MCP Apps 隔离思路（`mcp-app-admission.ts`），只把网络来源
// 从「声明式 apiOrigins」扩展为「固定 CDN 白名单 + 可选额外 API 源」。
//
// 与上游差异：上游 Gen UI 走自建 `zcode-sandbox://` 协议 + 响应头 CSP；b07 复用
// `mcpapp://` 文档暂存通道与 `<meta>`/响应头双路径（见 McpAppHost 的 R4-01 说明），
// 故这里只产出策略值，落地方式由宿主组件决定。

import { GEN_UI_STATIC_DOMAINS, GEN_UI_HTML_MAX_BYTES, genUiByteLength } from './contract.js';

export interface GenUiSandboxPolicy {
  /** iframe 的 sandbox 属性值；刻意不含 allow-same-origin / allow-top-navigation / allow-popups。 */
  readonly sandboxAttributes: readonly string[];
  /** 注入到 iframe 的 CSP（宿主以 <meta http-equiv> 或沙箱页响应头落地）。 */
  readonly contentSecurityPolicy: string;
  /** postMessage 通信约定：宿主与 iframe 只通过 window.postMessage 交换白名单方法。 */
  readonly postMessageProtocol: 'structured-allowlist';
}

function httpsDomains(domains: readonly string[]): string {
  return domains.map((domain) => `https://${domain}`).join(' ');
}

/**
 * 确定性生成 Gen UI 沙箱策略：同一输入永远得到同一策略，审查 diff 就是安全 diff。
 * 静态域白名单来自 `GEN_UI_STATIC_DOMAINS`；`apiOrigins` 仅允许追加 https 源到 connect-src。
 */
export function buildGenUiSandboxPolicy(options: { readonly apiOrigins?: readonly string[] } = {}): GenUiSandboxPolicy {
  const staticScripts = httpsDomains(GEN_UI_STATIC_DOMAINS);
  const fontDomains = httpsDomains(GEN_UI_STATIC_DOMAINS.filter((domain) => domain.startsWith('fonts.')));
  const connectSources = [staticScripts, ...(options.apiOrigins ?? [])].filter((part) => part.length > 0).join(' ');
  return {
    sandboxAttributes: ['allow-scripts', 'allow-forms'],
    contentSecurityPolicy: [
      "default-src 'none'",
      `script-src 'unsafe-inline' ${staticScripts}`,
      `style-src 'unsafe-inline' ${staticScripts}`,
      `img-src data: blob: ${staticScripts}`,
      `font-src data: ${fontDomains}`,
      `connect-src ${connectSources}`,
      "base-uri 'none'",
      "form-action 'none'",
    ]
      .join(' ')
      .trim(),
    postMessageProtocol: 'structured-allowlist',
  };
}

/** HTML 大小门：超过 5MB 的生成页面直接拒绝（上游同值）。 */
export function isGenUiHtmlWithinLimit(html: string): boolean {
  return genUiByteLength(html) <= GEN_UI_HTML_MAX_BYTES;
}
