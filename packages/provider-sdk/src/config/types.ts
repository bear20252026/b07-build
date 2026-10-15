// 一个文件=一种作用：provider 配置层的基础类型（纯数据，无 IO、无网络）。

/**
 * Provider 连接协议。
 * 取值与桌面端 Rust 传输实现（`apps/desktop-shell/src-tauri/src/direct_provider.rs`）一一对应：
 * 配置层只负责「这个连接用哪种线协议」，不负责怎么发请求。
 */
export type ProviderProtocol = 'openai-compatible' | 'anthropic-compatible';

export type ProviderId = string;
export type ModelId = string;

/**
 * 单个模型选项的映射声明。
 * `map` 是一段 JSON 模板文本：叶子字符串若以 `$` 开头，则引用同一次调用的选项值；
 * 其余叶子按字面量写入。模板是数据，不是代码，因此本层可以零 IO 地编译它。
 */
export interface ModelOptionSpec {
  /** JSON 模板文本；顶层必须是对象。 */
  readonly map: string;
  /** 合法取值闭集；声明后编译前会先校验。 */
  readonly values?: readonly string[];
  /** 调用方未提供该选项时使用的默认值。 */
  readonly defaultValue?: string;
}

export type ModelOptionSpecs = Readonly<Record<string, ModelOptionSpec>>;

export interface ProviderModelDefinition {
  readonly modelId: ModelId;
  readonly displayName?: string;
  readonly optionSpecs: ModelOptionSpecs;
}

export interface ProviderDefinition {
  readonly providerId: ProviderId;
  readonly providerName: string;
  readonly protocol: ProviderProtocol;
  readonly defaultBaseUrl: string;
  readonly defaultModel: ModelId;
  readonly models: readonly ProviderModelDefinition[];
}

/** 一次模型选择：provider + model + 选项值。 */
export interface ModelSelection {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly options?: Readonly<Record<string, string>>;
}

export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = [
  'openai-compatible',
  'anthropic-compatible',
];

/** 运行时判定：远端目录里的协议字段必须落在这个闭集里，否则整条记录作废。 */
export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === 'string' && (PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}
