import { isIP } from 'node:net';
import type { ProviderCatalogEntry, ProviderTransportKind } from './provider-catalog.js';

function normalizeOpenAiBasePath(pathname: string): string {
  const path = pathname.replace(/\/+$/, '');
  return /\/v1$/i.test(path) ? path.slice(0, -3) : path;
}

/**
 * 只接受显式填写的公网 HTTPS 基础地址。该检查防止本机 Gateway 被地址编辑功能变成
 * 内网或本机 SSRF 代理；实际地址只保留在当前 Gateway 进程内存，绝不进入 Profile、日志或 HTTP 响应。
 */
export function normalizePublicHttpsProviderBaseUrl(value: string, transport: ProviderTransportKind): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('连接地址必须是完整 HTTPS Base URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')) {
    throw new Error('连接地址仅允许无认证信息、无查询参数的 HTTPS 标准端口地址');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || isIP(hostname) !== 0 || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === 'metadata' || hostname.endsWith('.metadata')) {
    throw new Error('连接地址必须使用公开 DNS 主机名；本机、私网或 IP 地址请使用本地模型端点管理');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/(?:chat\/completions|messages)$/i.test(path)) throw new Error('请输入服务 Base URL，不要输入完整 chat completion 或 messages 操作路径');
  const normalizedPath = transport === 'openai-chat-completions' ? normalizeOpenAiBasePath(path) : path;
  return `${parsed.origin}${normalizedPath}`;
}

/** 会话覆盖层：仅将已验证的地址投影给连接探测和实际推理，进程退出后自动清空。 */
export class SessionProviderEndpointRegistry {
  private readonly overrides = new Map<string, string>();

  configure(provider: ProviderCatalogEntry, baseUrl: string): void {
    this.overrides.set(provider.id, normalizePublicHttpsProviderBaseUrl(baseUrl, provider.transport));
  }

  clear(providerId: string): void {
    this.overrides.delete(providerId);
  }

  resolve(provider: ProviderCatalogEntry): ProviderCatalogEntry {
    const baseUrl = this.overrides.get(provider.id);
    return baseUrl ? { ...provider, baseUrl, capabilities: { ...provider.capabilities } } : provider;
  }
}
