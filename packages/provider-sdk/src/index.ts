// packages/provider-sdk/src/index.ts —— 一个文件=一个作用：包导出面（只 re-export，不写逻辑）
export type { ModelDriver, ChatRequest, ChatMessage } from './driver';
export { ModelRouter } from './router';
export type { TaskKind } from './router';
export { OpenAICompatible } from './adapters/openai';
