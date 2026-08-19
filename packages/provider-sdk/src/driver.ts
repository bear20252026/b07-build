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

export type ModelCostTier = 'low' | 'medium' | 'high';

export interface ModelCapabilities {
  /** 可用于一次任务的最大上下文 token 预算。 */
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
  /** 模型推理是否在操作者本机或其受控局域环境内完成。 */
  isLocal: boolean;
  costTier: ModelCostTier;
}

export interface ModelDriver {
  /** 供应商标识，如 'openai' | 'anthropic' | 'local' */
  id(): string;
  /** 能力描述可选，以兼容早期 adapter；缺失时路由器使用保守默认值。 */
  capabilities?(): ModelCapabilities;
  /** 流式对话：AsyncIterable<string> 逐块返回 delta 内容 */
  chat(req: ChatRequest, apiKey: string): AsyncIterable<string>;
}
