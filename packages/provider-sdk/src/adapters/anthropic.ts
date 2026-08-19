// 一个文件=一种作用：Anthropic Messages API 协议适配；路由策略留在 ModelRouter。
import type { ChatMessage, ChatRequest, ModelCapabilities, ModelDriver } from '../driver.js';

interface AnthropicStreamEvent {
  type?: string;
  delta?: { text?: string };
}

export interface AnthropicOptions {
  id?: string;
  baseUrl?: string;
  capabilities?: Partial<ModelCapabilities>;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 200_000,
  supportsTools: false,
  supportsVision: true,
  isLocal: false,
  costTier: 'high',
};

function toAnthropicMessages(messages: readonly ChatMessage[]): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  const normalized = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: message.content,
    }));
  return { ...(system ? { system } : {}), messages: normalized };
}

export class AnthropicMessages implements ModelDriver {
  private readonly driverId: string;
  private readonly baseUrl: string;
  private readonly modelCapabilities: ModelCapabilities;

  constructor(options: AnthropicOptions = {}) {
    this.driverId = options.id ?? 'anthropic';
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.modelCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities, isLocal: false };
  }

  id(): string {
    return this.driverId;
  }

  capabilities(): ModelCapabilities {
    return { ...this.modelCapabilities };
  }

  async *chat(request: ChatRequest, apiKey: string): AsyncIterable<string> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 4_096,
        stream: true,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(system === undefined ? {} : { system }),
        messages,
      }),
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
        try {
          const event = JSON.parse(line.slice(5).trim()) as AnthropicStreamEvent;
          if (event.type === 'content_block_delta' && event.delta?.text) yield event.delta.text;
        } catch {
          // 忽略非 JSON keepalive 与不完整的 SSE 负载，后续块仍可继续解析。
        }
      }
    }
  }
}
