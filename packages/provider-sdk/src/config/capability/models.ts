// 一个文件=一种作用：provider「模型目录查询」能力面契约（纯类型，零 IO）。
// 设计：能力面按「能力」而非「层」切分，每个面是一个独立的小接口；provider 把需要的面组合起来。

import type { ModelId } from '../types.js';

/** 一条 provider 自述的模型条目。 */
export interface ProviderModelDescriptor {
  readonly modelId: ModelId;
  /** 展示名；缺席时调用方回退到 modelId。 */
  readonly displayName?: string;
  /** provider 自述的默认模型标记；缺席表示该 provider 不区分默认模型。 */
  readonly isDefault?: boolean;
}

/**
 * 模型目录查询能力面：声明「这个 provider 能被问及它有哪些模型」，
 * 不声明这些模型从哪来（内置目录 / 远端目录皆可）。
 */
export interface ProviderModelCatalogFacet {
  /** 列出该 provider 当前可用的模型。 */
  listModels(): Promise<readonly ProviderModelDescriptor[]>;
}
