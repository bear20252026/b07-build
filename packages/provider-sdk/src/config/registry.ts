// 一个文件=一种作用：provider 注册表（纯内存索引，零 IO）。
// 上游参考：ZCode `packages/provider/src/registry.ts`。

import { compileModelOptionMap, resolveModelOptionValues } from './option-map.js';
import type { ModelId, ModelSelection, ProviderDefinition, ProviderId, ProviderModelDefinition } from './types.js';

export type ModelSelectionValidation =
  | { readonly ok: true; readonly requestPatch: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: 'provider-not-found'; readonly providerId: ProviderId }
  | {
      readonly ok: false;
      readonly code: 'model-not-found';
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly ok: false;
      readonly code: 'option-not-supported';
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
      readonly option: string;
      readonly value: string;
      readonly supportedValues: readonly string[];
    };

export interface ProviderRegistryView {
  readonly revision: number;
  readonly providers: readonly ProviderDefinition[];
}

export interface ProviderRegistryChangedEvent {
  readonly revision: number;
  readonly reason: string;
}

/**
 * 纯注册表：只做「定义 → 索引 → 选择校验」。
 * 不读文件、不发网络、不读环境变量；远端目录层负责把远端数据喂给 `replace`。
 */
export class ProviderRegistry {
  #view: ProviderRegistryView;
  #providerById = new Map<ProviderId, ProviderDefinition>();
  #modelByProviderId = new Map<ProviderId, Map<ModelId, ProviderModelDefinition>>();
  readonly #listeners = new Set<(event: ProviderRegistryChangedEvent) => void>();

  constructor(providers: readonly ProviderDefinition[] = []) {
    this.#view = freezeView(0, providers);
    this.#rebuildIndexes();
  }

  get revision(): number {
    return this.#view.revision;
  }

  getView(): ProviderRegistryView {
    return this.#view;
  }

  listProviders(): readonly ProviderDefinition[] {
    return this.#view.providers;
  }

  getProvider(providerId: ProviderId): ProviderDefinition | undefined {
    return this.#providerById.get(providerId);
  }

  getModel(providerId: ProviderId, modelId: ModelId): ProviderModelDefinition | undefined {
    return this.#modelByProviderId.get(providerId)?.get(modelId);
  }

  /** 校验一次模型选择，并在通过时顺带产出请求体补丁（选项映射的唯一入口）。 */
  validateSelection(selection: ModelSelection): ModelSelectionValidation {
    if (!this.#providerById.has(selection.providerId)) {
      return { ok: false, code: 'provider-not-found', providerId: selection.providerId };
    }
    const model = this.getModel(selection.providerId, selection.modelId);
    if (!model) {
      return {
        ok: false,
        code: 'model-not-found',
        providerId: selection.providerId,
        modelId: selection.modelId,
      };
    }
    try {
      return {
        ok: true,
        requestPatch: compileModelOptionMap(model.optionSpecs, selection.options),
      };
    } catch (error) {
      const detail = error as { code?: string; option?: string; message?: string };
      if (detail.code === 'value-not-supported' && detail.option) {
        const spec = model.optionSpecs[detail.option];
        return {
          ok: false,
          code: 'option-not-supported',
          providerId: selection.providerId,
          modelId: selection.modelId,
          option: detail.option,
          value: selection.options?.[detail.option] ?? '',
          supportedValues: Object.freeze([...(spec?.values ?? [])]),
        };
      }
      throw error;
    }
  }

  /** 解析出该模型实际生效的选项值（含默认值回填）。 */
  resolveOptionValues(
    providerId: ProviderId,
    modelId: ModelId,
    options: Readonly<Record<string, string>> | undefined,
  ): Readonly<Record<string, string>> | undefined {
    const model = this.getModel(providerId, modelId);
    return model ? resolveModelOptionValues(model.optionSpecs, options) : undefined;
  }

  /** 整体替换目录；revision 自增并广播给订阅者。 */
  replace(providers: readonly ProviderDefinition[], reason: string): void {
    this.#view = freezeView(this.#view.revision + 1, providers);
    this.#rebuildIndexes();
    const event = Object.freeze({ revision: this.#view.revision, reason });
    for (const listener of this.#listeners) listener(event);
  }

  onDidChange(listener: (event: ProviderRegistryChangedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #rebuildIndexes(): void {
    const providerById = new Map<ProviderId, ProviderDefinition>();
    const modelByProviderId = new Map<ProviderId, Map<ModelId, ProviderModelDefinition>>();
    for (const provider of this.#view.providers) {
      if (providerById.has(provider.providerId)) {
        throw new Error(`注册表中存在重复 Provider：${provider.providerId}`);
      }
      providerById.set(provider.providerId, provider);
      const models = new Map<ModelId, ProviderModelDefinition>();
      for (const model of provider.models) {
        if (models.has(model.modelId)) {
          throw new Error(`注册表中存在重复 Model：${provider.providerId}/${model.modelId}`);
        }
        models.set(model.modelId, model);
      }
      modelByProviderId.set(provider.providerId, models);
    }
    this.#providerById = providerById;
    this.#modelByProviderId = modelByProviderId;
  }
}

function freezeView(revision: number, providers: readonly ProviderDefinition[]): ProviderRegistryView {
  const frozenProviders = providers.map((provider) =>
    Object.freeze({
      providerId: provider.providerId,
      providerName: provider.providerName,
      protocol: provider.protocol,
      defaultBaseUrl: provider.defaultBaseUrl,
      defaultModel: provider.defaultModel,
      models: Object.freeze(
        provider.models.map((model) =>
          Object.freeze({
            modelId: model.modelId,
            ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
            optionSpecs: model.optionSpecs,
          }),
        ),
      ),
    }),
  );
  return Object.freeze({ revision, providers: Object.freeze(frozenProviders) });
}
