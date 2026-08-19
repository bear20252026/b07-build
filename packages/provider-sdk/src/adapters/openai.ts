// packages/provider-sdk/src/adapters/openai.ts
// 一个文件=一个作用：OpenAI-compatible 协议适配（AgentForge 手写 fetch+SSE 同款）。
import type { ModelDriver, ChatRequest } from '../driver';

interface OpenAIDelta {
  choices?: { delta?: { content?: string } }[];
}

export class OpenAICompatible implements ModelDriver {
  constructor(private readonly baseUrl: string) {}

  id(): string {
    return 'openai';
  }

  async *chat(req: ChatRequest, apiKey: string): AsyncIterable<string> {
    const r = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...req, stream: true }),
    });
    if (!r.ok || !r.body) {
      throw new Error(`provider http ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') return;
        try {
          const j = JSON.parse(d) as OpenAIDelta;
          const c = j.choices?.[0]?.delta?.content ?? '';
          if (c) yield c;
        } catch {
          /* 忽略半包/非 JSON 行，继续等下一块 */
        }
      }
    }
  }
}
