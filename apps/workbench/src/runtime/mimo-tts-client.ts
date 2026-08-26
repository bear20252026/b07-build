export interface WorkbenchMimoTtsPreview {
  readonly schemaVersion: 1;
  readonly providerId: 'mimo';
  readonly model: 'mimo-v2.5-tts';
  readonly voice: string;
  readonly audioMime: 'audio/wav';
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

const BASE_URL = '';
const ALLOWED_FIELDS = new Set(['schemaVersion', 'providerId', 'model', 'voice', 'audioMime', 'audioBase64', 'audioBytes', 'inputDigest', 'inputCharacters', 'latencyMs', 'dataBoundary', 'canReadSecret', 'canAutoPlay', 'canAutoSpeak', 'canAutoExecute']);

function parsePreview(value: unknown): WorkbenchMimoTtsPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Companion TTS 返回格式无效');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !ALLOWED_FIELDS.has(key))) throw new Error('Companion TTS 响应包含未允许字段');
  if (source.schemaVersion !== 1 || source.providerId !== 'mimo' || source.model !== 'mimo-v2.5-tts' || source.audioMime !== 'audio/wav' || source.dataBoundary !== 'remote-allowed') throw new Error('Companion TTS 响应标识无效');
  if (typeof source.voice !== 'string' || typeof source.audioBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.audioBase64) || typeof source.audioBytes !== 'number' || typeof source.inputDigest !== 'string' || typeof source.inputCharacters !== 'number' || typeof source.latencyMs !== 'number') throw new Error('Companion TTS 响应格式无效');
  if (source.canReadSecret !== false || source.canAutoPlay !== false || source.canAutoSpeak !== false || source.canAutoExecute !== false) throw new Error('Companion TTS 响应违反受控语音边界');
  return source as unknown as WorkbenchMimoTtsPreview;
}

/** 仅在调用方明确提供服务端点时试听；不会缓存或持久化音频。 */
export class HttpMimoTtsClient {
  constructor(private readonly baseUrl = BASE_URL, private readonly request: typeof fetch = globalThis.fetch) {}

  async preview(input: { text: string; voice?: string }): Promise<WorkbenchMimoTtsPreview> {
    const response = await this.request(`${this.baseUrl}/api/companion/tts/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'companion-tts-preview-v1' },
      body: JSON.stringify(input),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string' ? (payload as { error: string }).error : 'Companion TTS 试听失败';
      throw new Error(message);
    }
    return parsePreview(payload);
  }
}
