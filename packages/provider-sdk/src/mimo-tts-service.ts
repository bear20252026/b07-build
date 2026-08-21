import { createHash } from 'node:crypto';
import type { CredentialResolver } from './credential-resolver.js';
import type { ProviderCatalog } from './provider-catalog.js';
import type { ProviderProfileRegistry } from './provider-profile.js';

const MAX_TEXT_CHARACTERS = 1_200;
const MAX_AUDIO_BASE64_CHARACTERS = 5_600_000;
const VOICES = new Set(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']);

export interface MimoTtsPreviewRequest {
  readonly text: string;
  readonly voice?: string;
}

export interface MimoTtsPreviewResult {
  readonly schemaVersion: 1;
  readonly providerId: 'mimo';
  readonly model: 'mimo-v2.5-tts';
  readonly voice: string;
  readonly audioMime: 'audio/wav';
  /** 仅供当前本机响应立即播放；不得写入账本、Profile、事件、设置或日志。 */
  readonly audioBase64: string;
  readonly audioBytes: number;
  readonly inputDigest: string;
  readonly inputCharacters: number;
  readonly latencyMs: number;
  readonly dataBoundary: 'remote-allowed';
  readonly canReadSecret: false;
  readonly canAutoPlay: false;
  readonly canAutoSpeak: false;
  readonly canAutoExecute: false;
}

function safeText(value: string): string {
  const text = value.trim();
  if (!text || text.length > MAX_TEXT_CHARACTERS) throw new Error(`TTS 文本必须是 1-${MAX_TEXT_CHARACTERS} 个字符`);
  return text;
}

function safeVoice(value: string | undefined): string {
  const voice = value ?? 'mimo_default';
  if (!VOICES.has(voice)) throw new Error('TTS 音色必须是审核过的 MiMo 预置音色');
  return voice;
}

function validAudioBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_AUDIO_BASE64_CHARACTERS && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * MiMo TTS 是一次性、操作者显式发起的音频请求。它不复用聊天推理接口，不读取对话历史，
 * 不接受 endpoint/key/model/style/工具字段，也不持久化音频。秘密只由 Gateway 内存凭据解析器短暂使用。
 */
export class MimoTtsService {
  constructor(
    private readonly catalog: ProviderCatalog,
    private readonly profiles: ProviderProfileRegistry,
    private readonly credentials: CredentialResolver,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async preview(request: MimoTtsPreviewRequest): Promise<MimoTtsPreviewResult> {
    const entry = this.catalog.get('mimo');
    if (!entry || entry.transport !== 'openai-chat-completions') throw new Error('MiMo TTS 目录条目不可用');
    const profile = this.profiles.get('provider.mimo');
    if (!profile || profile.status !== 'active' || !profile.driverIds.includes(entry.driverId)) throw new Error('请先在模型连接中显式配置并启用 Xiaomi MiMo；不会自动连接 Provider');
    const apiKey = this.credentials.resolve(entry.credentialReference);
    if (!apiKey) throw new Error('Gateway 当前会话没有 MiMo 凭据；不会发起语音请求');
    const text = safeText(request.text);
    const voice = safeVoice(request.voice);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const startedAt = this.now();
    try {
      const response = await this.fetcher(`${entry.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          model: 'mimo-v2.5-tts',
          messages: [
            { role: 'user', content: '请用自然、清晰、适合桌面助手的中性语气朗读。' },
            { role: 'assistant', content: text },
          ],
          audio: { format: 'wav', voice },
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`MiMo TTS 返回 HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const candidate = payload && typeof payload === 'object' ? payload as { choices?: readonly { message?: { audio?: { data?: unknown } } }[] } : undefined;
      const audioBase64 = candidate?.choices?.[0]?.message?.audio?.data;
      if (!validAudioBase64(audioBase64)) throw new Error('MiMo TTS 未返回有效的 WAV 音频数据');
      const audioBytes = Buffer.from(audioBase64, 'base64').byteLength;
      return {
        schemaVersion: 1, providerId: 'mimo', model: 'mimo-v2.5-tts', voice, audioMime: 'audio/wav', audioBase64, audioBytes,
        inputDigest: createHash('sha256').update(text).digest('hex'), inputCharacters: text.length, latencyMs: Math.max(0, this.now() - startedAt), dataBoundary: 'remote-allowed',
        canReadSecret: false, canAutoPlay: false, canAutoSpeak: false, canAutoExecute: false,
      };
    } catch (error) {
      if (error instanceof Error && /TTS|MiMo|HTTP/.test(error.message)) throw error;
      throw new Error('MiMo TTS 请求未完成；请检查会话凭据、配额、模型服务与网络策略');
    } finally {
      clearTimeout(timer);
    }
  }
}
