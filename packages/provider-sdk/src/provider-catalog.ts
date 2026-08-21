import type { ModelCapabilities } from './driver.js';

/** 供应商协议是明确的 adapter 契约，不允许由 UI 或 Profile note 动态决定。 */
export type ProviderTransportKind = 'openai-chat-completions' | 'anthropic-messages';

export interface ProviderCatalogEntry {
  schemaVersion: 1;
  id: string;
  displayName: string;
  transport: ProviderTransportKind;
  driverId: string;
  /** 仅为公开传输地址；不是凭据，也不允许由浏览器任意改写。 */
  baseUrl: string;
  defaultModel: string;
  credentialReference: string;
  maximumDataBoundary: 'remote-allowed';
  capabilities: ModelCapabilities;
  documentationUrl: string;
}

const REMOTE_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128_000,
  supportsTools: false,
  supportsVision: false,
  isLocal: false,
  costTier: 'high',
};

function entry(value: Omit<ProviderCatalogEntry, 'schemaVersion' | 'maximumDataBoundary' | 'capabilities'> & { capabilities?: Partial<ModelCapabilities> }): ProviderCatalogEntry {
  const { capabilities: overrides, ...metadata } = value;
  return Object.freeze({
    schemaVersion: 1,
    maximumDataBoundary: 'remote-allowed' as const,
    ...metadata,
    capabilities: Object.freeze({ ...REMOTE_CAPABILITIES, ...overrides, isLocal: false }),
  });
}

/**
 * 初始商业模型目录。它是静态 allowlist，而非远程 discovery：新增供应商必须经过代码审查，
 * 以避免浏览器通过自定义 endpoint 将 Gateway 变成任意 SSRF 代理。
 */
const BUILT_IN_ENTRIES: readonly ProviderCatalogEntry[] = Object.freeze([
  entry({
    id: 'openai', displayName: 'OpenAI', transport: 'openai-chat-completions', driverId: 'remote.openai',
    baseUrl: 'https://api.openai.com', defaultModel: 'gpt-5.6', credentialReference: 'env.openai',
    documentationUrl: 'https://developers.openai.com/api/reference/overview', capabilities: { supportsTools: true, supportsVision: true, contextWindow: 400_000 },
  }),
  entry({
    id: 'anthropic', displayName: 'Anthropic Claude', transport: 'anthropic-messages', driverId: 'remote.anthropic',
    baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-opus-5', credentialReference: 'env.anthropic',
    documentationUrl: 'https://platform.claude.com/docs/en/api/overview', capabilities: { supportsTools: true, supportsVision: true, contextWindow: 200_000 },
  }),
  entry({
    id: 'google-gemini', displayName: 'Google Gemini', transport: 'openai-chat-completions', driverId: 'remote.google-gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-3.7-flash', credentialReference: 'env.gemini',
    documentationUrl: 'https://ai.google.dev/gemini-api/docs/openai', capabilities: { supportsTools: true, supportsVision: true, contextWindow: 1_000_000, costTier: 'medium' },
  }),
  entry({
    id: 'deepseek', displayName: 'DeepSeek', transport: 'openai-chat-completions', driverId: 'remote.deepseek',
    baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-pro', credentialReference: 'env.deepseek',
    documentationUrl: 'https://api-docs.deepseek.com/zh-cn/', capabilities: { supportsTools: true, contextWindow: 1_000_000, costTier: 'medium' },
  }),
  entry({
    id: 'mistral', displayName: 'Mistral AI', transport: 'openai-chat-completions', driverId: 'remote.mistral',
    baseUrl: 'https://api.mistral.ai', defaultModel: 'mistral-large-latest', credentialReference: 'env.mistral',
    documentationUrl: 'https://docs.mistral.ai/studio-api/conversations/chat-completion', capabilities: { supportsTools: true, supportsVision: true, contextWindow: 128_000, costTier: 'medium' },
  }),
  entry({
    id: 'openrouter', displayName: 'OpenRouter', transport: 'openai-chat-completions', driverId: 'remote.openrouter',
    baseUrl: 'https://openrouter.ai/api', defaultModel: 'openrouter/auto', credentialReference: 'env.openrouter',
    documentationUrl: 'https://openrouter.ai/docs', capabilities: { supportsTools: true, supportsVision: true, contextWindow: 128_000, costTier: 'medium' },
  }),
]);

function copy(entryValue: ProviderCatalogEntry): ProviderCatalogEntry {
  return {
    ...entryValue,
    capabilities: { ...entryValue.capabilities },
  };
}

/** 只读目录：不持有密钥、不会联网、不会自动创建或激活 Provider Profile。 */
export class ProviderCatalog {
  constructor(private readonly entries: readonly ProviderCatalogEntry[] = BUILT_IN_ENTRIES) {
    const ids = new Set<string>();
    for (const item of entries) {
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(item.id) || ids.has(item.id)) throw new Error('provider catalog 包含无效或重复 id');
      if (!/^https:\/\//.test(item.baseUrl) || !/^env\.[a-z][a-z0-9-]{1,63}$/.test(item.credentialReference)) throw new Error('provider catalog 包含不安全端点或凭据引用');
      ids.add(item.id);
    }
  }
  list(): readonly ProviderCatalogEntry[] {
    return this.entries.map(copy);
  }
  get(id: string): ProviderCatalogEntry | undefined {
    return this.entries.find((item) => item.id === id) ? copy(this.entries.find((item) => item.id === id)!) : undefined;
  }
  findByDriverId(driverId: string): ProviderCatalogEntry | undefined {
    return this.entries.find((item) => item.driverId === driverId) ? copy(this.entries.find((item) => item.driverId === driverId)!) : undefined;
  }
}

export const BUILT_IN_PROVIDER_CATALOG = new ProviderCatalog();
