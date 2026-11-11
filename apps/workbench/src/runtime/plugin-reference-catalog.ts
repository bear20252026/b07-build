// 已安装插件目录（应用侧只读）。
//
// 数据来自 Tauri 命令 `plugin_reference_catalog`，它直接读插件市场的 SQLite
// （`$AWO_PLUGIN_MARKETPLACE_HOME` 或 `~/.awo/plugin-marketplace`）。
//
// ## 为什么走 Tauri 命令而不是 Node
//
// 插件账本是**文件**（两张表，每行一个 id + 一个 JSON blob）。读它不需要那 18k 行的
// Node 运行时，也不需要起子进程。这就是"能落到 Tauri 命令上就能用"那条分界线。
//
// ## 一个必须说清的语义
//
// `requestedToolNames` 与 `mcpServerId` 是插件**声明**的能力，**不代表已连接或可用**。
// 界面与后续的 `@` 引用都必须按这个语义展示 —— 把声明当成可用，会让模型去调
// 一个根本不存在的工具。

import { invoke } from '@tauri-apps/api/core';

/** 一条已安装插件。 */
export interface InstalledPluginCatalogEntry {
  readonly pluginId: string;
  readonly name: string;
  readonly marketplace: string;
  readonly version: string;
  /** 插件声明的 MCP App id。 */
  readonly appId: string | null;
  /** 该 App 声明的 MCP server id。 */
  readonly mcpServerId: string | null;
  /** 该 App 请求的工具名（声明值）。 */
  readonly requestedToolNames: readonly string[];
}

/**
 * 校验并归一化一条原生返回的记录。
 *
 * 跨进程边界的数据不受类型系统保护。形状不对就丢弃 —— 少显示一条是"看不到"，
 * 显示一条假的会让人以为某个插件提供了它并没有的能力。
 */
export function toInstalledPluginCatalogEntry(value: unknown): InstalledPluginCatalogEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as {
    pluginId?: unknown;
    name?: unknown;
    marketplace?: unknown;
    version?: unknown;
    appId?: unknown;
    mcpServerId?: unknown;
    requestedToolNames?: unknown;
  };
  if (typeof input.pluginId !== 'string' || !input.pluginId.trim()) return undefined;
  if (typeof input.name !== 'string' || !input.name.trim()) return undefined;
  if (typeof input.marketplace !== 'string' || typeof input.version !== 'string') return undefined;
  if (input.appId !== null && typeof input.appId !== 'string') return undefined;
  if (input.mcpServerId !== null && typeof input.mcpServerId !== 'string') return undefined;
  const tools = Array.isArray(input.requestedToolNames)
    ? input.requestedToolNames.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  return {
    pluginId: input.pluginId,
    name: input.name,
    marketplace: input.marketplace,
    version: input.version,
    appId: input.appId as string | null,
    mcpServerId: input.mcpServerId as string | null,
    requestedToolNames: tools,
  };
}

/**
 * 读取已安装插件目录。
 *
 * 没装过插件时原生侧返回空数组（不是错误），所以这里不需要区分"没有"和"失败" ——
 * 真正的失败（拿不到 home 目录、查询出错）会以异常形式冒上来。
 */
export async function loadInstalledPluginCatalog(): Promise<readonly InstalledPluginCatalogEntry[]> {
  const payload = await invoke<unknown>('plugin_reference_catalog');
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item) => toInstalledPluginCatalogEntry(item))
    .filter((item): item is InstalledPluginCatalogEntry => item !== undefined);
}
