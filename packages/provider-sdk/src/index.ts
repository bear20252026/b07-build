// packages/provider-sdk/src/index.ts —— 一个文件=一个作用：包导出面（只 re-export，不写逻辑）
export type { ModelDriver, ChatRequest, ChatMessage, ModelCapabilities, ModelCostTier } from './driver';
export { ModelRouter } from './router';
export type { TaskKind, DataBoundary, ModelRouteRequest, ModelRouteCandidate, ModelRouteDecision } from './router';
export { OpenAICompatible } from './adapters/openai';
export type { OpenAICompatibleOptions } from './adapters/openai';
export { LocalOpenAICompatible } from './adapters/local-openai';
export type { LocalOpenAIOptions } from './adapters/local-openai';
export { AnthropicMessages } from './adapters/anthropic';
export type { AnthropicOptions } from './adapters/anthropic';
