import type { DirectProviderProtocol } from './direct-provider-client';

export type OfficialProviderPreset = Readonly<{
  id: string;
  title: string;
  description: string;
  defaultModel: string;
  officialModels: readonly string[];
  defaultBaseUrls: Partial<Record<DirectProviderProtocol, string>>;
}>;

/**
 * 首批仅收录已经逐项阅读厂商官方文档、且适合现有 HTTPS/SSE 普通聊天链路的模型。
 * 模型目录会变化：这份离线候选不覆盖用户手填模型，也不替代用户点击后的账户模型发现结果。
 */
export const OFFICIAL_PROVIDER_PRESETS: readonly OfficialProviderPreset[] = [
  { id: 'deepseek', title: 'DeepSeek', description: 'V4 官方目录', defaultModel: 'deepseek-v4-pro', officialModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'], defaultBaseUrls: { 'openai-compatible': 'https://api.deepseek.com/v1', 'anthropic-compatible': 'https://api.deepseek.com/anthropic' } },
  { id: 'mimo', title: 'Xiaomi MiMo（按量）', description: 'sk- 密钥', defaultModel: 'mimo-v2.5-pro', officialModels: ['mimo-v2.5-pro', 'mimo-v2.5'], defaultBaseUrls: { 'openai-compatible': 'https://api.xiaomimimo.com/v1', 'anthropic-compatible': 'https://api.xiaomimimo.com/anthropic' } },
  { id: 'mimo-token-plan-cn', title: 'MiMo Token Plan（中国）', description: 'tp- 订阅密钥', defaultModel: 'mimo-v2.5-pro', officialModels: ['mimo-v2.5-pro', 'mimo-v2.5'], defaultBaseUrls: { 'openai-compatible': 'https://token-plan-cn.xiaomimimo.com/v1', 'anthropic-compatible': 'https://token-plan-cn.xiaomimimo.com/anthropic' } },
  { id: 'kimi', title: 'Kimi', description: 'Moonshot AI', defaultModel: 'kimi-k3', officialModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'], defaultBaseUrls: { 'openai-compatible': 'https://api.moonshot.cn/v1' } },
  { id: 'zhipu', title: '智谱 GLM', description: 'GLM 系列', defaultModel: 'glm-5.3', officialModels: ['glm-5.3', 'glm-5.2', 'glm-5v-turbo'], defaultBaseUrls: { 'openai-compatible': 'https://open.bigmodel.cn/api/paas/v4' } },
  { id: 'longcat', title: 'LongCat', description: '美团龙猫', defaultModel: 'LongCat-2.0', officialModels: ['LongCat-2.0'], defaultBaseUrls: { 'openai-compatible': 'https://api.longcat.chat/openai/v1', 'anthropic-compatible': 'https://api.longcat.chat/anthropic' } },
  { id: 'baidu-qianfan', title: '百度千帆 / 文心', description: 'ModelBuilder V2', defaultModel: 'ernie-5.1', officialModels: ['ernie-5.1', 'ernie-5.0', 'ernie-5.0-thinking-preview', 'ernie-5.0-thinking-latest', 'ernie-4.5-turbo-32k', 'ernie-4.5-turbo-128k', 'ernie-x1.1-preview', 'ernie-x1.1'], defaultBaseUrls: { 'openai-compatible': 'https://qianfan.baidubce.com/v2' } },
  { id: 'baichuan', title: '百川智能', description: 'Baichuan4 系列', defaultModel: 'Baichuan4-Turbo', officialModels: ['Baichuan4-Turbo', 'Baichuan4-Air', 'Baichuan4', 'Baichuan3-Turbo', 'Baichuan3-Turbo-128k', 'Baichuan2-Turbo'], defaultBaseUrls: { 'openai-compatible': 'https://api.baichuan-ai.com/v1' } },
  { id: 'sensenova', title: '商汤日日新 SenseNova', description: 'OpenAI 兼容', defaultModel: 'SenseChat-5', officialModels: ['SenseChat-5', 'SenseChat', 'SenseChat-Turbo', 'SenseChat-5-Cantonese', 'SenseNova-V6.5-Pro', 'SenseNova-V6.5-Turbo'], defaultBaseUrls: { 'openai-compatible': 'https://api.sensenova.cn/compatible-mode/v2' } },
  { id: 'qwen-model-studio', title: '阿里云百炼 / Qwen', description: '需填写 Workspace 地址', defaultModel: 'qwen3.8-max', officialModels: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash'], defaultBaseUrls: {} },
  { id: 'hunyuan', title: '腾讯混元', description: '既有 OpenAI 兼容', defaultModel: 'hunyuan-turbos-latest', officialModels: ['hunyuan-turbos-latest'], defaultBaseUrls: { 'openai-compatible': 'https://api.hunyuan.cloud.tencent.com/v1' } },
  { id: 'tokenhub', title: '腾讯 TokenHub', description: '新模型目录', defaultModel: 'hy3', officialModels: ['hy3'], defaultBaseUrls: { 'openai-compatible': 'https://tokenhub-intl.tencentcloudmaas.com/v1' } },
  { id: 'doubao-ark', title: '火山方舟 / 豆包', description: '中国北京', defaultModel: 'doubao-seed-2-1-pro-260628', officialModels: ['doubao-seed-evolving', 'doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628'], defaultBaseUrls: { 'openai-compatible': 'https://ark.cn-beijing.volces.com/api/v3' } },
  { id: 'minimax', title: 'MiniMax', description: 'M 系列', defaultModel: 'MiniMax-M3', officialModels: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2'], defaultBaseUrls: { 'openai-compatible': 'https://api.minimaxi.com/v1' } },
  { id: 'stepfun', title: '阶跃星辰 StepFun', description: '开放平台 API', defaultModel: 'step-3.7-flash', officialModels: ['step-3.7-flash', 'step-3.5-flash'], defaultBaseUrls: { 'openai-compatible': 'https://api.stepfun.com/v1' } },
  { id: 'stepfun-plan', title: '阶跃星辰 Step Plan', description: '订阅方案', defaultModel: 'step-3.7-flash', officialModels: ['step-3.7-flash'], defaultBaseUrls: { 'openai-compatible': 'https://api.stepfun.com/step_plan/v1', 'anthropic-compatible': 'https://api.stepfun.com/step_plan' } },
  { id: 'iflytek-spark', title: '讯飞星火', description: 'HTTP / SSE', defaultModel: '4.0Ultra', officialModels: ['4.0Ultra', 'generalv3.5', 'max-32k', 'generalv3', 'pro-128k', 'lite'], defaultBaseUrls: { 'openai-compatible': 'https://spark-api-open.xf-yun.com/v1' } },
  { id: 'openai', title: 'OpenAI', description: 'Chat Completions', defaultModel: 'gpt-5.6', officialModels: [], defaultBaseUrls: { 'openai-compatible': 'https://api.openai.com/v1' } },
  { id: 'google-gemini', title: 'Google Gemini', description: 'OpenAI-compatible', defaultModel: 'gemini-3.7-flash', officialModels: [], defaultBaseUrls: { 'openai-compatible': 'https://generativelanguage.googleapis.com/v1beta/openai' } },
  { id: 'mistral', title: 'Mistral AI', description: 'OpenAI-compatible', defaultModel: 'mistral-large-latest', officialModels: [], defaultBaseUrls: { 'openai-compatible': 'https://api.mistral.ai/v1' } },
  { id: 'openrouter', title: 'OpenRouter', description: '多模型路由', defaultModel: 'openrouter/auto', officialModels: [], defaultBaseUrls: { 'openai-compatible': 'https://openrouter.ai/api/v1' } },
  { id: 'anthropic', title: 'Anthropic Claude', description: 'Messages API', defaultModel: 'claude-opus-5', officialModels: [], defaultBaseUrls: { 'anthropic-compatible': 'https://api.anthropic.com' } },
];

export function officialModelsForProvider(providerId: string, displayName = ''): readonly string[] {
  const exact = OFFICIAL_PROVIDER_PRESETS.find((preset) => preset.id === providerId);
  if (exact) return exact.officialModels;
  // 旧版本和“自定义 API”会保留用户选择的连接 ID；仅用明确厂商品牌匹配离线候选，绝不改写该连接的地址、密钥、协议或已选模型。
  const identity = `${providerId} ${displayName}`.toLocaleLowerCase();
  if (identity.includes('deepseek')) return OFFICIAL_PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek')?.officialModels ?? [];
  if (identity.includes('moonshot') || identity.includes('kimi')) return OFFICIAL_PROVIDER_PRESETS.find((preset) => preset.id === 'kimi')?.officialModels ?? [];
  return [];
}
