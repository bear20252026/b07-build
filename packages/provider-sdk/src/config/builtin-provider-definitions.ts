// 一个文件=一种作用：把内置离线目录物化成注册表可直接装载的 Provider 定义（纯函数，零 IO）。

import { OFFICIAL_PROVIDER_PRESETS, type OfficialProviderPreset } from './official-provider-presets.js';
import { PROVIDER_PROTOCOLS, type ModelOptionSpecs, type ProviderDefinition, type ProviderModelDefinition, type ProviderProtocol } from './types.js';

/**
 * 标准模型选项规格：推理档位与输出上限。
 * `map` 里的 `$reasoningLevel` / `$maxOutputTokens` 是模板引用，编译时替换为实际值。
 */
export function standardModelOptionSpecs(): ModelOptionSpecs {
  return {
    reasoningLevel: {
      map: '{"reasoning_effort":"$reasoningLevel"}',
      values: ['disabled', 'low', 'medium', 'high'],
      defaultValue: 'medium',
    },
    maxOutputTokens: {
      // 无默认值：调用方不提供时整支跳过，不会给请求体塞一个凭空捏造的上限。
      // 引用必须写成 JSON 字符串（`"$x"`），因为模板整体必须先通过 JSON.parse。
      map: '{"max_tokens":"$maxOutputTokens"}',
    },
  };
}

function protocolForPreset(preset: OfficialProviderPreset): ProviderProtocol {
  const declared = PROVIDER_PROTOCOLS.find((protocol) => preset.defaultBaseUrls[protocol] !== undefined);
  return declared ?? 'openai-compatible';
}

function modelDefinitions(preset: OfficialProviderPreset): readonly ProviderModelDefinition[] {
  const models = preset.officialModels.length > 0 ? preset.officialModels : [preset.defaultModel];
  return models.map((modelId) => ({ modelId, optionSpecs: standardModelOptionSpecs() }));
}

/** 内置目录 → Provider 定义；离线、确定性，不读任何外部来源。 */
export function builtinProviderDefinitions(
  presets: readonly OfficialProviderPreset[] = OFFICIAL_PROVIDER_PRESETS,
): readonly ProviderDefinition[] {
  return presets.map((preset) => {
    const protocol = protocolForPreset(preset);
    return {
      providerId: preset.id,
      providerName: preset.title,
      protocol,
      defaultBaseUrl: preset.defaultBaseUrls[protocol] ?? '',
      defaultModel: preset.defaultModel,
      models: modelDefinitions(preset),
    };
  });
}
