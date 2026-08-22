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

/** 单向会话密钥写入端口；不包含 get、list、serialize 或持久化能力。 */
export interface SessionCredentialStore {
  storeFromExplicitOperatorIntent(reference: string, apiKey: string): void;
  clearSessionCredential(reference: string): void;
}

const ENVIRONMENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'env.openai': 'OPENAI_API_KEY',
  'env.anthropic': 'ANTHROPIC_API_KEY',
  'env.gemini': 'GEMINI_API_KEY',
  'env.deepseek': 'DEEPSEEK_API_KEY',
  'env.mistral': 'MISTRAL_API_KEY',
  'env.openrouter': 'OPENROUTER_API_KEY',
  'env.mimo': 'MIMO_API_KEY',
  'env.mimo-token-plan-cn': 'MIMO_TOKEN_PLAN_CN_API_KEY',
  'env.longcat': 'LONGCAT_API_KEY',
  'env.kimi': 'MOONSHOT_API_KEY',
  'env.zhipu': 'ZAI_API_KEY',
});

function isEnvironmentReference(value: string): boolean {
  return /^env\.[a-z][a-z0-9-]{1,63}$/.test(value) && Boolean(ENVIRONMENT_NAMES[value]);
}

/** 仅 custom session service 生成；不对应环境变量，也绝不序列化。 */
function isCustomSessionReference(value: string): boolean {
  return /^session\.custom-[a-z0-9-]{8,96}$/.test(value);
}

function safeReference(value: string): boolean {
  return isEnvironmentReference(value) || isCustomSessionReference(value);
}

/**
 * 环境变量实现。构造时注入只读 lookup，从而让 route 无法读取 process.env；真实 secret
 * 仅在模型 transport 即将请求时从 composition root 的该 adapter 获取。
 */
export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly lookup: (name: string) => string | undefined) {}
  availability(reference: string): CredentialAvailabilitySummary {
    if (!isEnvironmentReference(reference)) return { reference, availability: 'unsupported-reference' };
    const value = this.lookup(ENVIRONMENT_NAMES[reference]);
    return { reference, availability: value?.trim() ? 'available' : 'missing' };
  }
  resolve(reference: string): string | undefined {
    if (!isEnvironmentReference(reference)) return undefined;
    const value = this.lookup(ENVIRONMENT_NAMES[reference]);
    return value?.trim() || undefined;
  }
}

/**
 * Gateway session 内存覆盖层。它只接受已审核 `env.*` 或 custom service 生成的 `session.custom-*` 短生命周期 key：
 * 不提供读取、列举、序列化或持久化接口；进程退出即清空。外部只能获得 availability。
 */
export class SessionCredentialResolver implements CredentialResolver, SessionCredentialStore {
  private readonly sessionSecrets = new Map<string, string>();
  constructor(private readonly fallback: CredentialResolver) {}

  availability(reference: string): CredentialAvailabilitySummary {
    if (!safeReference(reference)) return { reference, availability: 'unsupported-reference' };
    if (this.sessionSecrets.has(reference)) return { reference, availability: 'available' };
    return isEnvironmentReference(reference) ? this.fallback.availability(reference) : { reference, availability: 'missing' };
  }

  resolve(reference: string): string | undefined {
    if (!safeReference(reference)) return undefined;
    return this.sessionSecrets.get(reference) ?? (isEnvironmentReference(reference) ? this.fallback.resolve(reference) : undefined);
  }

  storeFromExplicitOperatorIntent(reference: string, apiKey: string): void {
    if (!safeReference(reference)) throw new Error('凭据引用不受支持');
    const normalized = apiKey.trim();
    if (normalized.length < 8 || normalized.length > 4_096 || /[\r\n\0]/.test(normalized)) throw new Error('API key 格式无效');
    this.sessionSecrets.set(reference, normalized);
  }

  clearSessionCredential(reference: string): void {
    this.sessionSecrets.delete(reference);
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
