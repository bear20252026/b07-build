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

export type ProviderDriverFactory = (entry: ProviderCatalogEntry) => ModelDriver;

function createBuiltInDriver(entry: ProviderCatalogEntry): ModelDriver {
  if (entry.transport === 'anthropic-messages') {
    return new AnthropicMessages({ id: entry.driverId, baseUrl: entry.baseUrl, capabilities: entry.capabilities });
  }
  return new OpenAICompatible(entry.baseUrl, {
    id: entry.driverId,
    capabilities: entry.capabilities,
    ...((entry.id === 'google-gemini' || entry.id === 'deepseek') ? { chatCompletionsPath: '/chat/completions' as const } : {}),
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
 * 模型执行层仅接受已有的激活 Profile。它不登记、启用、探测、轮换凭据或调用工具；
 * 网络请求由现有 ModelDriver 执行，秘密只在持有 CredentialResolver 的 Gateway host 内短暂使用。
 */
export class ProviderInferenceService {
  constructor(
    private readonly catalog: ProviderCatalog,
    private readonly profiles: ProviderProfileRegistry,
    private readonly credentials: CredentialResolver,
    private readonly driverFactory: ProviderDriverFactory = createBuiltInDriver,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async infer(request: ProviderInferenceRequest): Promise<ProviderInferenceResult> {
    if (!safeProviderId(request.providerId)) throw new Error('providerId 无效');
    const entry = this.catalog.get(request.providerId);
    if (!entry) throw new Error('providerId 不在已审核目录中');
    const profileId = `provider.${entry.id}`;
    const profile = this.profiles.get(profileId);
    if (!profile || profile.status !== 'active') throw new Error('远程模型必须先由操作者显式登记并启用 Provider Profile');
    if (!profile.driverIds.includes(entry.driverId) || profile.maximumDataBoundary !== 'remote-allowed') throw new Error('Provider Profile driver allowlist 或数据边界不允许此远程模型调用');
    const apiKey = this.credentials.resolve(entry.credentialReference);
    if (!apiKey) throw new Error('Gateway host 未配置该 Provider 的凭据引用；不会发出网络请求');
    const prompt = normalizePrompt(request.prompt);
    const model = modelFor(entry, request.model);
    const driver = this.driverFactory(entry);
    if (driver.id() !== entry.driverId) throw new Error('Provider Driver 身份与已审核目录不匹配');
    const chat: ChatRequest = { model, stream: true, temperature: 0.2, messages: [{ role: 'user', content: prompt }] };
    const startedAt = this.now();
    const chunks: string[] = [];
    let outputCharacters = 0;
    let chunkCount = 0;
    try {
      for await (const chunk of driver.chat(chat, apiKey)) {
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
      throw new Error('远程模型请求未完成；请在供应商控制台检查凭据、配额、模型标识与网络策略');
    }
    const output = chunks.join('');
    const latencyMs = Math.max(0, this.now() - startedAt);
    return {
      schemaVersion: 1,
      providerId: entry.id,
      profileId,
      profileRevision: profile.revision,
      model,
      dataBoundary: 'remote-allowed',
      output,
      outputDigest: createHash('sha256').update(output).digest('hex'),
      outputCharacters: output.length,
      latencyMs,
      canReadSecret: false,
      canAutoExecuteTools: false,
      canAutoConnect: false,
    };
  }
}
