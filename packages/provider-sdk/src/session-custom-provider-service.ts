import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { AnthropicMessages } from './adapters/anthropic.js';
import { OpenAICompatible } from './adapters/openai.js';
import type { CredentialResolver, SessionCredentialStore } from './credential-resolver.js';
import type { ModelCapabilities, ModelDriver } from './driver.js';
import type { ProviderConnectionProbeResult, ProviderConnectionStatus, ProviderModelDiscoveryResult } from './provider-connection-service.js';
import type { ProviderInferenceResult, ProviderInferenceStreamChunk } from './provider-inference-service.js';

export type CustomProviderProtocol = 'openai-compatible' | 'anthropic-compatible';

export interface ConfigureCustomProviderSessionRequest {
  displayName: string;
  protocol: CustomProviderProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface CustomProviderInferenceRequest {
  providerId: string;
  prompt: string;
  model?: string;
}

type SessionCustomProvider = Readonly<{
  providerId: string;
  driverId: string;
  credentialReference: string;
  displayName: string;
  protocol: CustomProviderProtocol;
  baseUrl: string;
  model: string;
}>;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const PROVIDER_ID = /^custom-[a-z0-9-]{8,96}$/;
const MAX_PROMPT_CHARACTERS = 24_000;
const MAX_OUTPUT_CHARACTERS = 32_000;
const MAX_STREAM_CHUNKS = 4_096;
const CUSTOM_CAPABILITIES: ModelCapabilities = Object.freeze({
  contextWindow: 128_000,
  supportsTools: false,
  supportsVision: false,
  isLocal: false,
  costTier: 'high',
});

function normalizePublicHttpsBaseUrl(value: string, protocol: CustomProviderProtocol): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('自定义 Base URL 必须是完整 HTTPS 地址');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')) {
    throw new Error('自定义 Base URL 仅允许无认证信息、无查询参数的 HTTPS 标准端口地址');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || isIP(hostname) !== 0 || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === 'metadata' || hostname.endsWith('.metadata')) {
    throw new Error('自定义 Base URL 必须使用公开 DNS 主机名；本机、私网或 IP 地址请使用受控本地模型端点');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/(?:chat\/completions|messages)$/i.test(path)) throw new Error('请输入服务 Base URL，不要输入完整 chat completion 或 messages 操作路径');
  const normalized = `${parsed.origin}${path}`;
  return protocol === 'openai-compatible' && /\/v1$/i.test(path) ? normalized.slice(0, -3) : normalized;
}

function safeDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || /[\r\n\0]/.test(normalized)) throw new Error('自定义显示名称必须为 1-80 个有效字符');
  return normalized;
}

function safeModel(value: string): string {
  const normalized = value.trim();
  if (!MODEL_ID.test(normalized)) throw new Error('自定义模型标识无效');
  return normalized;
}

function safeProviderId(value: string): boolean {
  return PROVIDER_ID.test(value);
}

function statusFor(provider: SessionCustomProvider, credentials: CredentialResolver): ProviderConnectionStatus {
  return {
    schemaVersion: 1,
    providerId: provider.providerId,
    displayName: provider.displayName,
    driverId: provider.driverId,
    defaultModel: provider.model,
    credentialReference: provider.credentialReference,
    credentialAvailability: credentials.availability(provider.credentialReference).availability,
    profileStatus: 'active',
    profileRevision: 1,
    canReadSecret: false,
    canAutoConnect: false,
  };
}

/**
 * 受控 custom provider 会话。endpoint、api key 与 driver metadata 只在 Gateway 进程内存；
 * 该服务不持久化、列举 secret 或向浏览器返回 endpoint/header。
 */
export class SessionCustomProviderService {
  private readonly providers = new Map<string, SessionCustomProvider>();

  constructor(
    private readonly credentials: CredentialResolver & Partial<SessionCredentialStore>,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  list(): readonly ProviderConnectionStatus[] {
    return [...this.providers.values()].map((provider) => statusFor(provider, this.credentials))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.providerId.localeCompare(right.providerId));
  }

  configureSession(request: ConfigureCustomProviderSessionRequest): ProviderConnectionStatus {
    const store = this.credentials.storeFromExplicitOperatorIntent;
    if (typeof store !== 'function') throw new Error('当前 Gateway 未启用会话凭据保管器');
    if (request.protocol !== 'openai-compatible' && request.protocol !== 'anthropic-compatible') throw new Error('自定义协议必须是 OpenAI-compatible 或 Anthropic-compatible');
    const providerId = `custom-${randomUUID()}`;
    const provider: SessionCustomProvider = Object.freeze({
      providerId,
      driverId: `remote.${providerId}`,
      credentialReference: `session.${providerId}`,
      displayName: safeDisplayName(request.displayName),
      protocol: request.protocol,
      baseUrl: normalizePublicHttpsBaseUrl(request.baseUrl, request.protocol),
      model: safeModel(request.model),
    });
    store.call(this.credentials, provider.credentialReference, request.apiKey);
    this.providers.set(provider.providerId, provider);
    return statusFor(provider, this.credentials);
  }

  async discoverModels(providerId: string): Promise<ProviderModelDiscoveryResult> {
    const provider = this.requireProvider(providerId);
    const checkedAt = this.now();
    const apiKey = this.credentials.resolve(provider.credentialReference);
    if (!apiKey) return { schemaVersion: 1, providerId, outcome: 'missing-credential', checkedAt, models: [], canReadSecret: false, canAutoConnect: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const startedAt = this.now();
    try {
      const response = await this.fetcher(`${provider.baseUrl.replace(/\/$/, '')}/v1/models`, {
        method: 'GET',
        headers: provider.protocol === 'openai-compatible'
          ? { accept: 'application/json', authorization: `Bearer ${apiKey}` }
          : { accept: 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: controller.signal,
      });
      const latencyMs = Math.max(0, this.now() - startedAt);
      if (!response.ok) return { schemaVersion: 1, providerId, outcome: 'rejected', checkedAt, latencyMs, models: [], canReadSecret: false, canAutoConnect: false };
      const payload: unknown = await response.json();
      const data = payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
      const models = [...new Set(data.map((item) => item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined).filter((id): id is string => typeof id === 'string' && MODEL_ID.test(id)))].sort().slice(0, 100);
      return { schemaVersion: 1, providerId, outcome: 'reachable', checkedAt, latencyMs, models, canReadSecret: false, canAutoConnect: false };
    } catch {
      return { schemaVersion: 1, providerId, outcome: 'unreachable', checkedAt, latencyMs: Math.max(0, this.now() - startedAt), models: [], canReadSecret: false, canAutoConnect: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(providerId: string): Promise<ProviderConnectionProbeResult> {
    const result = await this.discoverModels(providerId);
    const { models: _models, ...probe } = result;
    return probe;
  }

  /** 以标准 Adapter 的文本分块实时驱动桌面 UI；不包含 endpoint、header 或 API key。 */
  async *stream(request: CustomProviderInferenceRequest): AsyncIterable<ProviderInferenceStreamChunk> {
    const provider = this.requireProvider(request.providerId);
    const apiKey = this.credentials.resolve(provider.credentialReference);
    if (!apiKey) throw new Error('桌面会话缺少该自定义 Provider 的凭据；不会发出网络请求');
    const prompt = request.prompt.trim();
    if (!prompt || prompt.length > MAX_PROMPT_CHARACTERS) throw new Error(`prompt 必须是 1-${MAX_PROMPT_CHARACTERS} 个字符`);
    const model = safeModel(request.model ?? provider.model);
    const driver = this.createDriver(provider);
    try {
      for await (const text of driver.chat({ model, stream: true, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }, apiKey)) {
        if (typeof text !== 'string') throw new Error('模型返回了无效文本分块');
        if (text) yield { providerId: provider.providerId, model, text };
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('安全')) throw error;
      throw new Error('自定义远程模型流式请求未完成；请检查 Base URL、协议、凭据、模型标识和服务端网络策略');
    }
  }

  async infer(request: CustomProviderInferenceRequest): Promise<ProviderInferenceResult> {
    const provider = this.requireProvider(request.providerId);
    const apiKey = this.credentials.resolve(provider.credentialReference);
    if (!apiKey) throw new Error('Gateway 当前会话缺少该自定义 Provider 的凭据；不会发出网络请求');
    const prompt = request.prompt.trim();
    if (!prompt || prompt.length > MAX_PROMPT_CHARACTERS) throw new Error(`prompt 必须是 1-${MAX_PROMPT_CHARACTERS} 个字符`);
    const model = safeModel(request.model ?? provider.model);
    const driver = this.createDriver(provider);
    const startedAt = this.now();
    const chunks: string[] = [];
    let outputCharacters = 0;
    let chunkCount = 0;
    try {
      for await (const chunk of driver.chat({ model, stream: true, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }, apiKey)) {
        chunkCount += 1;
        if (chunkCount > MAX_STREAM_CHUNKS) throw new Error('模型流式输出超过安全分块上限');
        if (typeof chunk !== 'string') throw new Error('模型返回了无效文本分块');
        const remaining = MAX_OUTPUT_CHARACTERS - outputCharacters;
        if (remaining <= 0) break;
        const accepted = chunk.slice(0, remaining);
        chunks.push(accepted);
        outputCharacters += accepted.length;
        if (accepted.length < chunk.length) break;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('安全')) throw error;
      throw new Error('自定义远程模型请求未完成；请检查 Base URL、协议、凭据、模型标识和服务端网络策略');
    }
    const output = chunks.join('');
    const outputDigest = createHash('sha256').update(output).digest('hex');
    return {
      schemaVersion: 1,
      providerId: provider.providerId,
      profileId: `session.${provider.providerId}`,
      profileRevision: 1,
      model,
      dataBoundary: 'remote-allowed',
      output,
      outputDigest,
      outputCharacters: output.length,
      latencyMs: Math.max(0, this.now() - startedAt),
      canReadSecret: false,
      canAutoExecuteTools: false,
      canAutoConnect: false,
    };
  }

  private requireProvider(providerId: string): SessionCustomProvider {
    if (!safeProviderId(providerId)) throw new Error('custom providerId 无效');
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('custom Provider 仅在当前 Gateway 会话有效；请重新显式配置');
    return provider;
  }

  private createDriver(provider: SessionCustomProvider): ModelDriver {
    if (provider.protocol === 'anthropic-compatible') return new AnthropicMessages({ id: provider.driverId, baseUrl: provider.baseUrl, capabilities: CUSTOM_CAPABILITIES });
    return new OpenAICompatible(provider.baseUrl, { id: provider.driverId, capabilities: CUSTOM_CAPABILITIES });
  }
}
