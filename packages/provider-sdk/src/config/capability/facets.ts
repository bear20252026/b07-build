// 一个文件=一种作用：把各能力面组合成一个 provider 的能力集合，并给出稳定的能力 id 词表（纯类型，零 IO）。

import type { ProviderAuthFacet } from './auth.js';
import type { ProviderForkFacet } from './fork.js';
import type { ProviderMcpFacet } from './mcp.js';
import type { ProviderModelCatalogFacet } from './models.js';
import type { ProviderRuntimeFacet } from './runtime.js';
import type { ProviderSessionsFacet } from './sessions.js';
import type { ProviderSkillsFacet } from './skills.js';
import type { ProviderSessionSynchronizerFacet } from './synchronizer.js';

/**
 * 一个 provider 的能力集合。
 *
 * 关键设计：可选能力用「可选字段」表达，而不是布尔开关。
 * 字段缺席本身就是「该能力不可用」——不存在 `supportsFork` 这类会与实现漂移的布尔量，
 * 也就没有「声明支持但实现没接上」的中间态。
 */
export interface ProviderCapabilityFacets {
  readonly models?: ProviderModelCatalogFacet;
  readonly auth?: ProviderAuthFacet;
  readonly sessions?: ProviderSessionsFacet;
  readonly mcp?: ProviderMcpFacet;
  readonly skills?: ProviderSkillsFacet;
  readonly runtime?: ProviderRuntimeFacet;
  readonly fork?: ProviderForkFacet;
  readonly synchronizer?: ProviderSessionSynchronizerFacet;
}

/**
 * 能力 id 词表（稳定、kebab-case）。
 *
 * 前八项与八个能力面一一对应；后两项是「面内可选方法」导出的细粒度能力，
 * 它们不可用时对应的能力面本身仍可能可用。
 * 数组顺序即能力清单的稳定输出顺序。
 */
export const PROVIDER_CAPABILITY_IDS = [
  'model-catalog',
  'auth',
  'sessions',
  'mcp',
  'skills',
  'runtime',
  'fork',
  'synchronizer',
  'runtime-background-work',
  'session-edit-anchor',
] as const;

export type ProviderCapabilityId = (typeof PROVIDER_CAPABILITY_IDS)[number];

/** 能力面字段名 → 能力 id 的映射（面级能力）。 */
export const PROVIDER_CAPABILITY_FACET_KEYS = [
  'models',
  'auth',
  'sessions',
  'mcp',
  'skills',
  'runtime',
  'fork',
  'synchronizer',
] as const;

export type ProviderCapabilityFacetKey = (typeof PROVIDER_CAPABILITY_FACET_KEYS)[number];
