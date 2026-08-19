// packages/provider-sdk/src/driver.ts —— 一个文件=一个作用：ModelDriver 端口（稳定，消费方只依赖此接口）
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
}

export interface ModelDriver {
  /** 供应商标识，如 'openai' | 'anthropic' | 'local' */
  id(): string;
  /** 流式对话：AsyncIterable<string> 逐块返回 delta 内容 */
  chat(req: ChatRequest, apiKey: string): AsyncIterable<string>;
}
