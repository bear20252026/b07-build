// 会话内**冻结**的插件身份目录。
//
// ## 为什么"冻结"
//
// 目录在会话开始时构建一次，之后不随市场配置热更新。理由是**可回放**：同一轮对话重试
// 或换 provider 重放时，模型看到的插件清单必须与第一次完全一致，否则"上次说有、这次说没有"
// 会让重试的结果不可解释。配置变化应当在**下一轮**生效，而不是在同一条消息里悄悄改变。
//
// ## 为什么要有冲突判定
//
// b07 的插件 id 是 `${name}@${marketplace}`：**不同市场可以发布同名插件**。两个都已启用时，
// 用户说"用 @foo"，到底指哪个？这一层不做 last-write-wins（那会让结果取决于加载顺序），
// 也不按 display name 猜。做法是把两个都标成冲突，由 reminder 侧 fail closed 跳过 ——
// 宁可这一轮不注入能力提示，也不要注入错的。
//
// ## 与 ZCode 的关系
//
// 形态照搬 `plugin-reference/catalog.ts`：同样的 `conflictingPluginIds` 语义（只算 enabled，
// 互指，排序）。差别在**能力面**：ZCode 的插件声明 skills / mcp servers / subagents 三类；
// b07 的插件包只声明一个宿主 MCP App（`PluginManifest.mcpApp`），所以目录里只有
// `mcpServerIds` 一类。少一类不是简化，是 b07 的插件模型本来就没有另外两类 ——
// 编出空的 skills/subagents 字段只会让下游以为"以后会有"。

import { isValidPluginStableId } from './references.js';

/**
 * 构建目录所需的插件记录。
 *
 * 刻意用**结构化入参**而不是 import `agent-runtime` 的 `InstalledPluginRecord`：
 * 本包因此保持零内部依赖（`requires: []`），适配由调用方做。副作用是这里必须
 * 自己写清楚每个字段的语义，而不是靠类型名暗示。
 */
export interface PluginCatalogSource {
  /** 稳定 id：`name@marketplace`（与 `InstalledPluginRecord.id` 同格式）。 */
  readonly id: string;
  /** 清单里的插件名（同名即可能冲突）。 */
  readonly name: string;
  readonly marketplace: string;
  /** 是否在本次会话中启用。**已发现但未启用**的也进目录，用于给出 `disabled_in_session`。 */
  readonly enabled: boolean;
  /**
   * 该插件声明且**已在宿主登记并启用**的 MCP server id。
   *
   * b07 的 `InstalledPluginRecord` 目前只持久化 `appId`，没有 server id ——
   * 适配时需要清单（安装时手上就有）。这里留成可选，缺失即视为"没有可用能力"，
   * 于是该插件会被 `no_live_capabilities` 跳过，而不是被编造出一项能力。
   */
  readonly mcpServerIds?: readonly string[];
}

/** 目录里的一条。 */
export interface PluginCatalogEntry {
  readonly pluginId: string;
  readonly name: string;
  readonly marketplace: string;
  readonly enabled: boolean;
  /** 与本条**同名且都已启用**的其它插件 id（互指、已排序）。空数组表示无冲突。 */
  readonly conflictingPluginIds: readonly string[];
  /** 已排序的 MCP server id。 */
  readonly mcpServerIds: readonly string[];
}

/** 会话内冻结的目录。 */
export interface PluginReferenceCatalog {
  readonly plugins: readonly PluginCatalogEntry[];
}

/** 构建结果。 */
export interface BuildPluginReferenceCatalogResult {
  readonly catalog: PluginReferenceCatalog;
  /**
   * id 不合法、被挡在目录外的记录。
   *
   * 单独报出来而不是静默丢弃：插件存储里出现非法 id 说明上游有 bug，
   * 而"目录里少了一个插件"是很难被注意到的现象。
   */
  readonly invalidPluginIds: readonly string[];
}

/** 构建会话目录。 */
export function buildPluginReferenceCatalog(
  plugins: readonly PluginCatalogSource[],
): BuildPluginReferenceCatalogResult {
  const invalidPluginIds: string[] = [];
  const valid = plugins.filter((plugin) => {
    if (isValidPluginStableId(plugin.id)) return true;
    invalidPluginIds.push(plugin.id);
    return false;
  });

  // 同名且都启用的才互相冲突：未启用的插件在运行时名字空间里不存在，不参与冲突。
  const enabledIdsByName = new Map<string, string[]>();
  for (const plugin of valid) {
    if (!plugin.enabled) continue;
    const ids = enabledIdsByName.get(plugin.name) ?? [];
    ids.push(plugin.id);
    enabledIdsByName.set(plugin.name, ids);
  }

  const entries: PluginCatalogEntry[] = valid.map((plugin) => {
    const sameNameEnabled = plugin.enabled ? (enabledIdsByName.get(plugin.name) ?? []) : [];
    return {
      pluginId: plugin.id,
      name: plugin.name,
      marketplace: plugin.marketplace,
      enabled: plugin.enabled,
      conflictingPluginIds: sameNameEnabled.filter((id) => id !== plugin.id).sort(),
      mcpServerIds: [...(plugin.mcpServerIds ?? [])].sort(),
    };
  });

  return { catalog: { plugins: entries }, invalidPluginIds };
}

/** 按 id 查一条；查不到返回 `undefined`（调用方据此报 `unknown`）。 */
export function findPluginCatalogEntry(
  catalog: PluginReferenceCatalog | undefined,
  pluginId: string,
): PluginCatalogEntry | undefined {
  return catalog?.plugins.find((entry) => entry.pluginId === pluginId);
}
