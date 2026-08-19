// 一个文件=一种作用：为本机 OpenAI-compatible 服务提供明确的隐私与能力标签。
import type { ModelCapabilities } from '../driver.js';
import { OpenAICompatible } from './openai.js';

export interface LocalOpenAIOptions {
  id?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

/**
 * 适用于 Ollama、LM Studio、vLLM 等暴露 OpenAI Chat Completions 协议的本机端点。
 * 不在此处猜测服务是否启动；连通性失败由调用路径显式处理，避免路由层产生隐式网络副作用。
 */
export class LocalOpenAICompatible extends OpenAICompatible {
  constructor(baseUrl: string, options: LocalOpenAIOptions = {}) {
    const capabilities: ModelCapabilities = {
      contextWindow: options.contextWindow ?? 32_768,
      supportsTools: options.supportsTools ?? false,
      supportsVision: options.supportsVision ?? false,
      isLocal: true,
      costTier: 'low',
    };
    super(baseUrl, { id: options.id ?? 'local', capabilities });
  }
}
