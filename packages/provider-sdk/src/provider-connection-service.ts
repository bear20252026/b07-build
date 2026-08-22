import type { CredentialResolver, SessionCredentialStore } from './credential-resolver.js';
import type { ProviderCatalog, ProviderCatalogEntry } from './provider-catalog.js';
import type { ProviderProfile, ProviderProfileRegistry, ProviderProfileStatus } from './provider-profile.js';
import { SessionProviderEndpointRegistry, type SessionProviderProtocol } from './session-provider-endpoints.js';

export type ProviderConnectionProfileStatus = ProviderProfileStatus | 'not-registered';
export type ProviderConnectionProbeOutcome = 'reachable' | 'missing-credential' | 'not-registered' | 'not-active' | 'rejected' | 'unreachable';

export interface ProviderConnectionStatus {
  schemaVersion: 1;
  providerId: string;
  displayName: string;
  driverId: string;
  defaultModel: string;
  credentialReference: string;
  credentialAvailability: 'available' | 'missing' | 'unsupported-reference';
  profileStatus: ProviderConnectionProfileStatus;
  profileRevision?: number;
  canReadSecret: false;
  canAutoConnect: false;
}

export interface ProviderConnectionProbeResult {
  schemaVersion: 1;
  providerId: string;
  outcome: ProviderConnectionProbeOutcome;
  checkedAt: number;
  latencyMs?: number;
  canReadSecret: false;
  canAutoConnect: false;
}

/** 模型列表只返回供应商公开 model id；不返回地址、请求头、密钥或原始响应。 */
export interface ProviderModelDiscoveryResult extends ProviderConnectionProbeResult {
  readonly models: readonly string[];
}

export interface RegisterCatalogProviderRequest {
  providerId: string;
  reviewedBy: string;
  note?: string;
  at: number;
}

export interface ActivateCatalogProviderRequest {
  providerId: string;
  reviewedBy: string;
  note?: string;
  at: number;
}

/** API key 仅由该显式动作写入 Gateway 当前会话内存；不可被状态、Profile 或 HTTP 响应读取。 */
export interface ConfigureSessionProviderRequest {
  providerId: string;
  reviewedBy: string;
  displayName?: string;
  model?: string;
  /** 可选的用户显式 HTTPS Base URL；只在当前 Gateway 会话内存中有效。 */
  baseUrl?: string;
  /** 显式协议选择会同时影响 adapter、探测路径和认证头；不写入 Profile。 */
  protocol?: SessionProviderProtocol;
  apiKey: string;
  at: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function profileId(provider: ProviderCatalogEntry): string {
  return `provider.${provider.id}`;
}

function requireReview(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error('reviewedBy 必须是安全标识符');
  return value;
}

function statusFor(provider: ProviderCatalogEntry, profile: ProviderProfile | undefined, resolver: CredentialResolver, presentation?: { displayName?: string; model?: string }): ProviderConnectionStatus {
  return {
    schemaVersion: 1,
    providerId: provider.id,
    displayName: presentation?.displayName ?? provider.displayName,
    driverId: provider.driverId,
    defaultModel: presentation?.model ?? provider.defaultModel,
    credentialReference: provider.credentialReference,
    credentialAvailability: resolver.availability(provider.credentialReference).availability,
    profileStatus: profile?.status ?? 'not-registered',
    ...(profile ? { profileRevision: profile.revision } : {}),
    canReadSecret: false,
    canAutoConnect: false,
  };
}

function probePath(provider: ProviderCatalogEntry): string {
  if (provider.transport === 'anthropic-messages') return '/v1/models';
  if (provider.id === 'google-gemini' || provider.id === 'deepseek') return '/models';
  return '/v1/models';
}

function authHeaders(provider: ProviderCatalogEntry, apiKey: string): HeadersInit {
  if (provider.id === 'mimo' || provider.id.startsWith('mimo-token-plan-')) {
    return provider.transport === 'anthropic-messages'
      ? { accept: 'application/json', 'anthropic-version': '2023-06-01', 'api-key': apiKey }
      : { accept: 'application/json', 'api-key': apiKey };
  }
  if (provider.transport === 'anthropic-messages') {
    return { accept: 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': apiKey };
  }
  return { accept: 'application/json', authorization: `Bearer ${apiKey}` };
}

/**
 * 连接控制面不执行推理任务。探测仅请求官方 model-list endpoint，且必须由操作者显式触发；
 * 它不会持久化探测结果、不自动注册 profile、不自动激活 profile，也不会透露 endpoint 或 key。
 */
export class ProviderConnectionService {
  constructor(
    private readonly catalog: ProviderCatalog,
    private readonly profiles: ProviderProfileRegistry,
    private readonly credentials: CredentialResolver & Partial<SessionCredentialStore>,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly sessionEndpoints = new SessionProviderEndpointRegistry(),
  ) {}

  private readonly sessionPresentation = new Map<string, { displayName?: string; model?: string }>();

  list(): readonly ProviderConnectionStatus[] {
    return this.catalog.list().map((provider) => this.statusFor(provider));
  }

  register(request: RegisterCatalogProviderRequest): ProviderConnectionStatus {
    const provider = this.requireProvider(request.providerId);
    const existing = this.profiles.get(profileId(provider));
    if (existing) throw new Error(`${provider.displayName} 已登记；请显式激活、停用、撤销或更新既有 Profile`);
    this.profiles.register({
      id: profileId(provider),
      displayName: provider.displayName,
      driverIds: [provider.driverId],
      maximumDataBoundary: provider.maximumDataBoundary,
      credentialReference: provider.credentialReference,
      reviewedBy: requireReview(request.reviewedBy),
      note: request.note ?? '由本地操作者显式登记的目录供应商；API key 不进入 Provider Profile。',
      at: request.at,
    });
    return this.statusFor(provider);
  }

  /**
   * 新手向导的单向会话配置动作。显示名与模型仅留在本次 Gateway 会话投影中；
   * API key 由 SessionCredentialStore 接收后不可读、不可列举、不可持久化。
   */
  configureSession(request: ConfigureSessionProviderRequest): ProviderConnectionStatus {
    const provider = this.requireProvider(request.providerId);
    const store = this.credentials.storeFromExplicitOperatorIntent;
    if (typeof store !== 'function') throw new Error('当前 Gateway 未启用会话凭据保管器');
    const displayName = request.displayName?.trim();
    const model = request.model?.trim();
    if (displayName !== undefined && (!displayName || displayName.length > 80)) throw new Error('显示名称必须为 1-80 字符');
    if (model !== undefined && !IDENTIFIER.test(model)) throw new Error('模型标识无效');
    if (request.baseUrl !== undefined) this.sessionEndpoints.configure(provider, { baseUrl: request.baseUrl, protocol: request.protocol });
    store.call(this.credentials, provider.credentialReference, request.apiKey);
    this.sessionPresentation.set(provider.id, { ...(displayName ? { displayName } : {}), ...(model ? { model } : {}) });
    const existing = this.profiles.get(profileId(provider));
    if (!existing) this.register({ providerId: provider.id, reviewedBy: request.reviewedBy, note: '由本地操作者显式快速配置；API key 仅保留在 Gateway 当前进程内存。', at: request.at });
    if (this.profiles.get(profileId(provider))?.status !== 'active') this.activate({ providerId: provider.id, reviewedBy: request.reviewedBy, note: '由本地操作者显式启用；不会自动发送模型请求。', at: request.at });
    return this.statusFor(provider);
  }

  activate(request: ActivateCatalogProviderRequest): ProviderConnectionStatus {
    const provider = this.requireProvider(request.providerId);
    const credential = this.credentials.availability(provider.credentialReference).availability;
    if (credential !== 'available') throw new Error(`${provider.displayName} 缺少 Gateway host 的凭据引用；不会激活远程 Profile`);
    const current = this.profiles.get(profileId(provider));
    if (!current) throw new Error(`${provider.displayName} 尚未登记；必须先由操作者显式登记`);
    if (current.status !== 'active') this.profiles.activate(profileId(provider), requireReview(request.reviewedBy), request.at, request.note);
    return statusFor(provider, this.profiles.get(profileId(provider)), this.credentials);
  }

  async discoverModels(providerId: string): Promise<ProviderModelDiscoveryResult> {
    const provider = this.resolveSessionProvider(providerId);
    const checkedAt = this.now();
    const profile = this.profiles.get(profileId(provider));
    if (!profile) return { schemaVersion: 1, providerId, outcome: 'not-registered', checkedAt, models: [], canReadSecret: false, canAutoConnect: false };
    if (profile.status !== 'active') return { schemaVersion: 1, providerId, outcome: 'not-active', checkedAt, models: [], canReadSecret: false, canAutoConnect: false };
    const apiKey = this.credentials.resolve(provider.credentialReference);
    if (!apiKey) return { schemaVersion: 1, providerId, outcome: 'missing-credential', checkedAt, models: [], canReadSecret: false, canAutoConnect: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const startedAt = this.now();
    try {
      const response = await this.fetcher(`${provider.baseUrl.replace(/\/$/, '')}${probePath(provider)}`, { method: 'GET', headers: authHeaders(provider, apiKey), signal: controller.signal });
      const latencyMs = Math.max(0, this.now() - startedAt);
      if (!response.ok) return { schemaVersion: 1, providerId, outcome: 'rejected', checkedAt, latencyMs, models: [], canReadSecret: false, canAutoConnect: false };
      const payload: unknown = await response.json();
      const rows = payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
      const models = [...new Set(rows.map((row) => row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined).filter((id): id is string => typeof id === 'string' && IDENTIFIER.test(id)))].sort().slice(0, 100);
      return { schemaVersion: 1, providerId, outcome: 'reachable', checkedAt, latencyMs, models, canReadSecret: false, canAutoConnect: false };
    } catch {
      return { schemaVersion: 1, providerId, outcome: 'unreachable', checkedAt, latencyMs: Math.max(0, this.now() - startedAt), models: [], canReadSecret: false, canAutoConnect: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(providerId: string): Promise<ProviderConnectionProbeResult> {
    const provider = this.resolveSessionProvider(providerId);
    const checkedAt = this.now();
    const profile = this.profiles.get(profileId(provider));
    if (!profile) return { schemaVersion: 1, providerId, outcome: 'not-registered', checkedAt, canReadSecret: false, canAutoConnect: false };
    if (profile.status !== 'active') return { schemaVersion: 1, providerId, outcome: 'not-active', checkedAt, canReadSecret: false, canAutoConnect: false };
    const apiKey = this.credentials.resolve(provider.credentialReference);
    if (!apiKey) return { schemaVersion: 1, providerId, outcome: 'missing-credential', checkedAt, canReadSecret: false, canAutoConnect: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const startedAt = this.now();
    try {
      const response = await this.fetcher(`${provider.baseUrl.replace(/\/$/, '')}${probePath(provider)}`, {
        method: 'GET', headers: authHeaders(provider, apiKey), signal: controller.signal,
      });
      const latencyMs = Math.max(0, this.now() - startedAt);
      if (response.ok) return { schemaVersion: 1, providerId, outcome: 'reachable', checkedAt, latencyMs, canReadSecret: false, canAutoConnect: false };
      return { schemaVersion: 1, providerId, outcome: 'rejected', checkedAt, latencyMs, canReadSecret: false, canAutoConnect: false };
    } catch {
      return { schemaVersion: 1, providerId, outcome: 'unreachable', checkedAt, latencyMs: Math.max(0, this.now() - startedAt), canReadSecret: false, canAutoConnect: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 供同一 Gateway 内的推理服务复用会话地址；不会向 HTTP 或 WebView 投影 endpoint。 */
  resolveSessionProvider(providerId: string): ProviderCatalogEntry {
    return this.sessionEndpoints.resolve(this.requireProvider(providerId));
  }

  private statusFor(provider: ProviderCatalogEntry): ProviderConnectionStatus {
    return statusFor(provider, this.profiles.get(profileId(provider)), this.credentials, this.sessionPresentation.get(provider.id));
  }

  private requireProvider(providerId: string): ProviderCatalogEntry {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(providerId)) throw new Error('providerId 无效');
    const provider = this.catalog.get(providerId);
    if (!provider) throw new Error('providerId 不在已审核目录中');
    return provider;
  }
}
