import { createHash } from 'node:crypto';
import { AnthropicMessages } from './adapters/anthropic.js';
import { OpenAICompatible } from './adapters/openai.js';
import type { CredentialResolver } from './credential-resolver.js';
import type { ChatRequest, ModelDriver } from './driver.js';
import type { ProviderCatalog, ProviderCatalogEntry } from './provider-catalog.js';
import type { ProviderProfileRegistry } from './provider-profile.js';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const MAX_PROMPT_CHARACTERS = 24_000;
const MAX_OUTPUT_CHARACTERS = 32_000;
const MAX_STREAM_CHUNKS = 4_096;

export interface ProviderInferenceRequest {
  providerId: string;
  /** 未提供时使用经过代码审查的 catalog default；浏览器不可提交 endpoint 或 driver。 */
  model?: string;
  prompt: string;
}

export interface ProviderInferenceResult {
  schemaVersion: 1;
  providerId: string;
  profileId: string;
  profileRevision: number;
  model: string;
  dataBoundary: 'remote-allowed';
  output: string;
  outputDigest: string;
  outputCharacters: number;
  latencyMs: number;
  canReadSecret: false;
  canAutoExecuteTools: false;
  canAutoConnect: false;
}

/** 上游 SSE 的一个已解析文本分块；不会携带 URL、请求头或 API key。 */
export interface ProviderInferenceStreamChunk {
  readonly providerId: string;
  readonly model: string;
  readonly text: string;
}

export type ProviderDriverFactory = (entry: ProviderCatalogEntry) => ModelDriver;

type PreparedInference = Readonly<{
  entry: ProviderCatalogEntry;
  profileId: string;
  profileRevision: number;
  model: string;
  apiKey: string;
  driver: ModelDriver;
  chat: ChatRequest;
}>;

function createBuiltInDriver(entry: ProviderCatalogEntry): ModelDriver {
  if (entry.transport === 'anthropic-messages') {
    return new AnthropicMessages({
      id: entry.driverId,
      baseUrl: entry.baseUrl,
      capabilities: entry.capabilities,
      ...((entry.id === 'mimo' || entry.id.startsWith('mimo-token-plan-')) ? { authentication: 'api-key' as const } : {}),
    });
  }
  return new OpenAICompatible(entry.baseUrl, {
    id: entry.driverId,
    capabilities: entry.capabilities,
    ...((entry.id === 'google-gemini' || entry.id === 'deepseek' || entry.id === 'zhipu') ? { chatCompletionsPath: '/chat/completions' as const } : {}),
    ...((entry.id === 'mimo' || entry.id.startsWith('mimo-token-plan-')) ? { authentication: 'api-key' as const } : {}),
  });
}

function safeProviderId(value: string): boolean {
  return /^[a-z][a-z0-9-]{1,63}$/.test(value);
}

function normalizePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARACTERS) throw new Error(`prompt 必须是 1-${MAX_PROMPT_CHARACTERS} 个字符`);
  return prompt;
}

function modelFor(entry: ProviderCatalogEntry, requested: string | undefined): string {
  const model = (requested ?? entry.defaultModel).trim();
  if (!MODEL_ID.test(model)) throw new Error('model 标识无效');
  return model;
}

/**
 * 模型执行层仅接受已有的激活 Profile。它复用官方 OpenAI/Anthropic-compatible Adapter；
 * `stream` 在上游 SSE 文本分块抵达时立即产出，不缓冲、改写或截断正常桌面对话响应。
 */
export class ProviderInferenceService {
  constructor(
    private readonly catalog: ProviderCatalog,
    private readonly profiles: ProviderProfileRegistry,
    private readonly credentials: CredentialResolver,
    private readonly driverFactory: ProviderDriverFactory = createBuiltInDriver,
    private readonly now: () => number = () => Date.now(),
    /** 仅由同一桌面运行时的连接服务提供会话地址覆盖；浏览器不可传入。 */
    private readonly sessionEntryResolver?: (providerId: string) => ProviderCatalogEntry,
  ) {}

  /** 供桌面对话使用：从现有 Provider Adapter 实时转发标准 SSE 文本分块。 */
  async *stream(request: ProviderInferenceRequest): AsyncIterable<ProviderInferenceStreamChunk> {
    const prepared = this.prepare(request);
    try {
      for await (const text of prepared.driver.chat(prepared.chat, prepared.apiKey)) {
        if (typeof text !== 'string') throw new Error('模型返回了无效文本分块');
        if (text) yield { providerId: prepared.entry.id, model: prepared.model, text };
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('安全')) throw error;
      throw new Error('远程模型流式请求未完成；请在供应商控制台检查凭据、配额、模型标识与网络策略');
    }
  }

  /** 供 task/run 成果写入使用：消费同一 Adapter 流并产生受限的聚合结果。 */
  async infer(request: ProviderInferenceRequest): Promise<ProviderInferenceResult> {
    const prepared = this.prepare(request);
    const startedAt = this.now();
    const chunks: string[] = [];
    let outputCharacters = 0;
    let chunkCount = 0;
    try {
      for await (const text of prepared.driver.chat(prepared.chat, prepared.apiKey)) {
        chunkCount += 1;
        if (chunkCount > MAX_STREAM_CHUNKS) throw new Error('模型流式输出超过任务成果分块上限');
        if (typeof text !== 'string') throw new Error('模型返回了无效文本分块');
        const remaining = MAX_OUTPUT_CHARACTERS - outputCharacters;
        if (remaining <= 0) break;
        const accepted = text.slice(0, remaining);
        chunks.push(accepted);
        outputCharacters += accepted.length;
        if (accepted.length < text.length) break;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('任务成果')) throw error;
      throw new Error('远程模型请求未完成；请在供应商控制台检查凭据、配额、模型标识与网络策略');
    }
    const output = chunks.join('');
    return {
      schemaVersion: 1,
      providerId: prepared.entry.id,
      profileId: prepared.profileId,
      profileRevision: prepared.profileRevision,
      model: prepared.model,
      dataBoundary: 'remote-allowed',
      output,
      outputDigest: createHash('sha256').update(output).digest('hex'),
      outputCharacters: output.length,
      latencyMs: Math.max(0, this.now() - startedAt),
      canReadSecret: false,
      canAutoExecuteTools: false,
      canAutoConnect: false,
    };
  }

  private prepare(request: ProviderInferenceRequest): PreparedInference {
    if (!safeProviderId(request.providerId)) throw new Error('providerId 无效');
    const catalogEntry = this.catalog.get(request.providerId);
    if (!catalogEntry) throw new Error('providerId 不在已审核目录中');
    const entry = this.sessionEntryResolver?.(request.providerId) ?? catalogEntry;
    if (entry.id !== catalogEntry.id || entry.driverId !== catalogEntry.driverId || entry.credentialReference !== catalogEntry.credentialReference) {
      throw new Error('桌面会话 Provider 覆盖违反已审核目录身份约束');
    }
    const profileId = `provider.${entry.id}`;
    const profile = this.profiles.get(profileId);
    if (!profile || profile.status !== 'active') throw new Error('远程模型必须先由操作者显式登记并启用 Provider Profile');
    if (!profile.driverIds.includes(entry.driverId) || profile.maximumDataBoundary !== 'remote-allowed') throw new Error('Provider Profile driver allowlist 或数据边界不允许此远程模型调用');
    const apiKey = this.credentials.resolve(entry.credentialReference);
    if (!apiKey) throw new Error('桌面会话未配置该 Provider 的凭据；不会发出网络请求');
    const model = modelFor(entry, request.model);
    const driver = this.driverFactory(entry);
    if (driver.id() !== entry.driverId) throw new Error('Provider Driver 身份与已审核目录不匹配');
    return {
      entry,
      profileId,
      profileRevision: profile.revision,
      model,
      apiKey,
      driver,
      chat: { model, stream: true, temperature: 0.2, messages: [{ role: 'user', content: normalizePrompt(request.prompt) }] },
    };
  }
}
