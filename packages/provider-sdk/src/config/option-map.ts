// 一个文件=一种作用：模型选项映射的编译与校验（纯函数，零 IO）。
// 上游参考：ZCode `packages/model-option-map`（tokenizer/parser/compiler/evaluator）。
// 本实现只保留 b07 真正需要的一档：把「选项声明模板 + 选项值」编译成请求体补丁。

import type { ModelOptionSpec, ModelOptionSpecs } from './types.js';

/** 选项映射的稳定失败码；调用方据此决定是用户输入错误还是目录配置错误。 */
export type ModelOptionMapErrorCode =
  | 'map-not-object'
  | 'map-not-json'
  | 'value-not-supported'
  | 'unresolved-reference';

export class ModelOptionMapError extends Error {
  readonly code: ModelOptionMapErrorCode;
  readonly option: string;

  constructor(code: ModelOptionMapErrorCode, option: string, message: string) {
    super(message);
    this.name = 'ModelOptionMapError';
    this.code = code;
    this.option = option;
  }
}

/** 先按 `values` 闭集与 `defaultValue` 归一，再交给编译器。 */
export function resolveModelOptionValues(
  specs: ModelOptionSpecs,
  values: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = values?.[name] ?? spec.defaultValue;
    if (value === undefined) continue;
    if (spec.values && !spec.values.includes(value)) {
      throw new ModelOptionMapError(
        'value-not-supported',
        name,
        `选项 ${name} 不支持取值 ${value}；合法取值：${spec.values.join('、')}`,
      );
    }
    resolved[name] = value;
  }
  return Object.freeze(resolved);
}

/**
 * 把模型选项值按声明模板编译成请求体补丁。
 * 补丁按 `specs` 的键序合并，后者覆盖前者；未提供值且无默认值的选项整支跳过。
 */
export function compileModelOptionMap(
  specs: ModelOptionSpecs,
  values: Readonly<Record<string, string>> | undefined,
): Record<string, unknown> {
  const resolved = resolveModelOptionValues(specs, values);
  let patch: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (!(name in resolved)) continue;
    patch = mergeOptionPatches(patch, compileSingleOption(name, spec, resolved));
  }
  return patch;
}

/** 深合并两份补丁：对象递归合并，数组与标量整体替换。 */
export function mergeOptionPatches(
  base: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    merged[key] =
      isPlainRecord(existing) && isPlainRecord(value)
        ? mergeOptionPatches(existing, value)
        : cloneJsonValue(value);
  }
  return merged;
}

function compileSingleOption(
  name: string,
  spec: ModelOptionSpec,
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec.map);
  } catch {
    throw new ModelOptionMapError('map-not-json', name, `选项 ${name} 的映射模板不是合法 JSON`);
  }
  if (!isPlainRecord(parsed)) {
    throw new ModelOptionMapError('map-not-object', name, `选项 ${name} 的映射模板顶层必须是对象`);
  }
  return resolveTemplate(name, parsed, values);
}

function resolveTemplate(
  option: string,
  template: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (isPlainRecord(value)) {
      resolved[key] = resolveTemplate(option, value, values);
      continue;
    }
    if (typeof value === 'string' && value.startsWith('$')) {
      const reference = value.slice(1);
      if (!(reference in values)) {
        throw new ModelOptionMapError(
          'unresolved-reference',
          option,
          `选项 ${option} 的映射模板引用了未提供的值 $${reference}`,
        );
      }
      resolved[key] = values[reference];
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (isPlainRecord(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) cloned[key] = cloneJsonValue(child);
    return cloned;
  }
  return value;
}
