// 一个文件=一种作用：MCP Apps（交互式 UI 插件）的准入与隔离策略。
//
// 背景：MCP Apps 允许 MCP 服务器返回交互式 HTML，在宿主 WebView 的 iframe 里渲染。
// 这类内容是不可信第三方代码，ZCode 用 Electron 的 webview 隔离，b07 在 Tauri 上
// 必须自建同等强度的隔离。本模块提供三个纯函数层，供后续宿主组件与注册流程调用：
//
// 1. manifest 准入（validateMcpAppManifest）：应用声明只能引用**同一 MCP 服务器
//    已注册**的工具名，权限不允许自授；
// 2. 沙箱属性（buildMcpAppSandbox）：iframe sandbox 白名单 + CSP——刻意**不给**
//    allow-same-origin（保持不透明源，无法读宿主 DOM/存储）、不给 allow-top-navigation
//    与 allow-popups；网络默认全禁，声明了 apiOrigins 才进 connect-src；
// 3. postMessage 门（gateMcpAppMessage）：应用 → 宿主只接受白名单类型、大小受限的
//    消息；工具调用请求必须再次对上注册表，防止渲染层伪造未注册调用。
//
// 这里不渲染任何东西：宿主 iframe 组件（消费 buildMcpAppSandbox 的输出）是后续工作。

/** 应用可以请求的工具白名单：只能是声明它的那个 MCP 服务器里已注册的工具。 */
export interface McpAppResourceManifest {
  schemaVersion: 1;
  /** 应用 id：`mcpapp-` 前缀 + 服务器 id + 资源名的摘要形式，由注册流程生成。 */
  id: string;
  /** 声明该应用的 MCP 服务器 id；工具引用与 HTML 资源都归属它。 */
  serverId: string;
  displayName: string;
  /** 该服务器的一个 MCP 资源 URI（ui:// 或 text/html 资源），宿主从这里取 HTML。 */
  htmlResourceUri: string;
  /** 应用可以通过 postMessage 门请求调用的工具名；必须是该服务器 declaredTools 的子集。 */
  requestedToolNames: readonly string[];
  /** 应用需要联网访问的 API 源（https://origin）；缺省 = 完全断网。 */
  apiOrigins?: readonly string[];
}

export interface McpAppAdmission {
  manifest: McpAppResourceManifest;
  /** 准入通过的工具白名单（server declaredTools 与 requestedToolNames 的交集）。 */
  admittedToolNames: readonly string[];
}

export type McpAppAdmissionResult =
  | { ok: true; admission: McpAppAdmission }
  | { ok: false; reason: string };

const APP_ID_PATTERN = /^mcpapp-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESOURCE_URI_PATTERN = /^(ui:\/\/|mcp:\/\/)[^\s]{1,512}$/;
const HTTPS_ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/;
/** 应用 → 宿主允许的消息类型白名单。 */
export const MCP_APP_MESSAGE_TYPES = ['toolCallRequest', 'ready', 'resize'] as const;
export type McpAppMessageType = (typeof MCP_APP_MESSAGE_TYPES)[number];
/** 单条 postMessage 消息的载荷上限：渲染层不应有理由传大对象。 */
export const MCP_APP_MAX_MESSAGE_CHARS = 64_000;

/** 声明服务器的最小结构化视图：MCP 注册表里的服务端清单天然满足该形状。 */
export interface McpAppHostingServer {
  readonly id: string;
  readonly declaredTools: readonly { readonly name: string }[];
}

export function validateMcpAppManifest(
  manifest: unknown,
  server: McpAppHostingServer,
): McpAppAdmissionResult {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { ok: false, reason: 'mcpapp-manifest-invalid' };
  }
  const candidate = manifest as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) return { ok: false, reason: 'mcpapp-schema-version-unsupported' };
  if (typeof candidate.id !== 'string' || !APP_ID_PATTERN.test(candidate.id)) {
    return { ok: false, reason: 'mcpapp-id-invalid' };
  }
  if (typeof candidate.serverId !== 'string' || candidate.serverId !== server.id || !SERVER_ID_PATTERN.test(candidate.serverId)) {
    // 应用必须由它所属的 MCP 服务器声明：跨服务器借用工具名是伪造路径。
    return { ok: false, reason: 'mcpapp-server-mismatch' };
  }
  if (typeof candidate.displayName !== 'string' || candidate.displayName.trim().length === 0 || candidate.displayName.length > 80) {
    return { ok: false, reason: 'mcpapp-display-name-invalid' };
  }
  if (typeof candidate.htmlResourceUri !== 'string' || !RESOURCE_URI_PATTERN.test(candidate.htmlResourceUri)) {
    return { ok: false, reason: 'mcpapp-resource-uri-invalid' };
  }
  if (!Array.isArray(candidate.requestedToolNames)) {
    return { ok: false, reason: 'mcpapp-tools-invalid' };
  }
  const declared = new Set(server.declaredTools.map((tool) => tool.name));
  const requested = candidate.requestedToolNames;
  if (requested.length > 64 || requested.some((name) => typeof name !== 'string' || name.length === 0 || name.length > 128)) {
    return { ok: false, reason: 'mcpapp-tools-invalid' };
  }
  // 权限最小化：声明的工具必须真实注册过；未注册的引用直接整单拒绝而不是静默裁剪，
  // 否则应用作者无法发现声明错误，审查者也无法核对 diff。
  for (const name of requested) {
    if (!declared.has(name as string)) return { ok: false, reason: 'mcpapp-tool-not-declared' };
  }
  const apiOrigins = candidate.apiOrigins;
  if (apiOrigins !== undefined) {
    if (!Array.isArray(apiOrigins) || apiOrigins.length > 16 || apiOrigins.some((origin) => typeof origin !== 'string' || !HTTPS_ORIGIN_PATTERN.test(origin))) {
      return { ok: false, reason: 'mcpapp-api-origins-invalid' };
    }
  }
  return {
    ok: true,
    admission: {
      manifest: {
        schemaVersion: 1,
        id: candidate.id,
        serverId: candidate.serverId,
        displayName: candidate.displayName,
        htmlResourceUri: candidate.htmlResourceUri,
        requestedToolNames: requested as readonly string[],
        ...(Array.isArray(apiOrigins) ? { apiOrigins: apiOrigins as readonly string[] } : {}),
      },
      admittedToolNames: requested as readonly string[],
    },
  };
}

export interface McpAppSandboxPolicy {
  /** iframe 的 sandbox 属性值；刻意不含 allow-same-origin / allow-top-navigation / allow-popups。 */
  sandboxAttributes: readonly string[];
  /** 注入到 iframe 的 CSP（宿主以 <meta http-equiv> 或沙箱页响应头落地）。 */
  contentSecurityPolicy: string;
  /** postMessage 通信约定：宿主与 iframe 只能通过 window.postMessage 交换白名单类型。 */
  postMessageProtocol: 'structured-allowlist';
}

/** 沙箱属性确定性生成：同一 manifest 永远得到同一策略，审查 diff 就是安全 diff。 */
export function buildMcpAppSandbox(manifest: McpAppResourceManifest): McpAppSandboxPolicy {
  const connectSrc = manifest.apiOrigins?.length ? ` connect-src ${manifest.apiOrigins.join(' ')};` : '';
  return {
    // allow-scripts 是运行应用的前提；allow-forms 允许应用内表单；其余一律不给。
    sandboxAttributes: ['allow-scripts', 'allow-forms'],
    // 注意（R1 审计）：frame-ancestors 只在 HTTP 响应头里生效，放在 <meta> 中会被
    // 浏览器忽略——这里刻意不生成它。iframe 嵌套隔离由 sandbox 属性承担；
    // 若未来改为通过网络服务应用 HTML，必须在响应头层另行设置 frame-ancestors。
    contentSecurityPolicy: [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      'img-src data: blob:',
      'font-src data:',
      "base-uri 'none'",
      "form-action 'none'",
      connectSrc.trimEnd(),
    ]
      .filter((part) => part.length > 0)
      .join(' ')
      .trim(),
    postMessageProtocol: 'structured-allowlist',
  };
}

/**
 * 把宿主 CSP 以 <meta http-equiv> 注入应用 HTML（srcdoc 宿主路径）。
 * 多条 CSP 并存时取交集（最严格者生效），应用自带的 CSP 不会被本条放宽；
 * 注入点尽量前移（<head> 之后），保证对后续资源的约束尽早生效。
 */
export function injectContentSecurityPolicy(html: string, contentSecurityPolicy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy.replace(/"/g, '&quot;')}">`;
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch) {
    const position = headMatch.index + headMatch[0].length;
    return `${html.slice(0, position)}${meta}${html.slice(position)}`;
  }
  const htmlMatch = /<html[^>]*>/i.exec(html);
  if (htmlMatch) {
    const position = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, position)}<head>${meta}</head>${html.slice(position)}`;
  }
  return `${meta}${html}`;
}

export type McpAppGateResult =
  | { ok: true; type: McpAppMessageType; payload: unknown }
  | { ok: false; reason: string };

/**
 * 应用 → 宿主消息门。工具调用请求在此做二次校验：消息里声明的工具必须
 * 在准入白名单内（渲染层伪造未注册调用会在这里被拦下）。
 */
export function gateMcpAppMessage(
  raw: unknown,
  admission: Pick<McpAppAdmission, 'admittedToolNames'>,
): McpAppGateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'mcpapp-message-invalid' };
  }
  const message = raw as Record<string, unknown>;
  if (typeof message.type !== 'string' || !(MCP_APP_MESSAGE_TYPES as readonly string[]).includes(message.type)) {
    return { ok: false, reason: 'mcpapp-message-type-forbidden' };
  }
  const serialized = JSON.stringify(message.payload ?? null);
  if (serialized.length > MCP_APP_MAX_MESSAGE_CHARS) {
    return { ok: false, reason: 'mcpapp-message-too-large' };
  }
  if (message.type === 'toolCallRequest') {
    const payload = typeof message.payload === 'object' && message.payload !== null ? (message.payload as Record<string, unknown>) : undefined;
    const toolName = payload?.toolName;
    if (typeof toolName !== 'string' || !admission.admittedToolNames.includes(toolName)) {
      return { ok: false, reason: 'mcpapp-tool-not-admitted' };
    }
    const args = 'arguments' in (payload ?? {}) ? payload?.arguments : undefined;
    if (args !== undefined && serialized.length > MCP_APP_MAX_MESSAGE_CHARS) {
      return { ok: false, reason: 'mcpapp-message-too-large' };
    }
  }
  return { ok: true, type: message.type as McpAppMessageType, payload: message.payload ?? null };
}
