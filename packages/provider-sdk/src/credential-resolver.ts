import type { ProviderCatalog } from './provider-catalog.js';

export type CredentialAvailability = 'available' | 'missing' | 'unsupported-reference';

export interface CredentialAvailabilitySummary {
  reference: string;
  availability: CredentialAvailability;
}

/**
 * 凭据解析端口只允许 Gateway composition root 使用。它的实现不得返回给 HTTP route、
 * 日志、TaskEvent 或浏览器；外部只能获得 availability 元数据。
 */
export interface CredentialResolver {
  availability(reference: string): CredentialAvailabilitySummary;
  resolve(reference: string): string | undefined;
}

const ENVIRONMENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'env.openai': 'OPENAI_API_KEY',
  'env.anthropic': 'ANTHROPIC_API_KEY',
  'env.gemini': 'GEMINI_API_KEY',
  'env.deepseek': 'DEEPSEEK_API_KEY',
  'env.mistral': 'MISTRAL_API_KEY',
  'env.openrouter': 'OPENROUTER_API_KEY',
});

function safeReference(value: string): boolean {
  return /^env\.[a-z][a-z0-9-]{1,63}$/.test(value);
}

/**
 * 环境变量实现。构造时注入只读 lookup，从而让 route 无法读取 process.env；真实 secret
 * 仅在模型 transport 即将请求时从 composition root 的该 adapter 获取。
 */
export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly lookup: (name: string) => string | undefined) {}
  availability(reference: string): CredentialAvailabilitySummary {
    if (!safeReference(reference) || !ENVIRONMENT_NAMES[reference]) return { reference, availability: 'unsupported-reference' };
    const value = this.lookup(ENVIRONMENT_NAMES[reference]);
    return { reference, availability: value?.trim() ? 'available' : 'missing' };
  }
  resolve(reference: string): string | undefined {
    if (!safeReference(reference) || !ENVIRONMENT_NAMES[reference]) return undefined;
    const value = this.lookup(ENVIRONMENT_NAMES[reference]);
    return value?.trim() || undefined;
  }
}

export interface ProviderCredentialStatus {
  providerId: string;
  credentialReference: string;
  availability: CredentialAvailability;
  canReadSecret: false;
  canAutoConnect: false;
}

/** 对 catalog 的脱敏投影；没有 provider endpoint、API key 或 token 长度等信息。 */
export function summarizeProviderCredentials(catalog: ProviderCatalog, resolver: CredentialResolver): readonly ProviderCredentialStatus[] {
  return catalog.list().map((provider) => ({
    providerId: provider.id,
    credentialReference: provider.credentialReference,
    availability: resolver.availability(provider.credentialReference).availability,
    canReadSecret: false,
    canAutoConnect: false,
  }));
}
