// 一个文件=一种作用：OpenAI-compatible 协议适配。只处理 HTTP/SSE，不参与模型选择。
import type { ChatRequest, ModelCapabilities, ModelDriver } from '../driver.js';

interface OpenAIDelta {
  choices?: { delta?: { content?: string } }[];
}

export interface OpenAICompatibleOptions {
  id?: string;
  capabilities?: ModelCapabilities;
  /** 默认兼容 OpenAI、DeepSeek、Mistral 与 OpenRouter；Gemini 兼容层使用 /chat/completions。 */
  chatCompletionsPath?: '/v1/chat/completions' | '/chat/completions';
  /** 仅供经过代码审查的官方兼容端点使用；浏览器和自定义 Profile 不可提交任意 header。 */
  authentication?: 'bearer' | 'api-key';
}

const REMOTE_DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128_000,
  supportsTools: false,
  supportsVision: false,
  isLocal: false,
  costTier: 'high',
};

export class OpenAICompatible implements ModelDriver {
  private readonly driverId: string;
  private readonly modelCapabilities: ModelCapabilities;
  private readonly chatCompletionsPath: '/v1/chat/completions' | '/chat/completions';
  private readonly authentication: 'bearer' | 'api-key';

  constructor(
    private readonly baseUrl: string,
    options: OpenAICompatibleOptions = {},
  ) {
    this.driverId = options.id ?? 'openai';
    this.modelCapabilities = options.capabilities ?? REMOTE_DEFAULT_CAPABILITIES;
    this.chatCompletionsPath = options.chatCompletionsPath ?? '/v1/chat/completions';
    this.authentication = options.authentication ?? 'bearer';
  }

  id(): string {
    return this.driverId;
  }

  capabilities(): ModelCapabilities {
    return { ...this.modelCapabilities };
  }

  async *chat(req: ChatRequest, apiKey: string): AsyncIterable<string> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${this.chatCompletionsPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.authentication === 'api-key' ? { 'api-key': apiKey } : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({ ...req, stream: true }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`provider http ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const payload = JSON.parse(data) as OpenAIDelta;
          const content = payload.choices?.[0]?.delta?.content ?? '';
          if (content) yield content;
        } catch {
          // 仅忽略没有构成完整 JSON 的 SSE 负载；网络错误由 reader 原样传递。
        }
      }
    }
  }
}
