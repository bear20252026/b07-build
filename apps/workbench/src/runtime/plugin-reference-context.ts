// 把「插件声明」与「用户配置的 MCP server」合成一次对话轮次的插件能力提示。
//
// ## 三个输入，一个交集
//
// | 输入 | 来源 | 含义 |
// | --- | --- | --- |
// | 已安装插件 | `plugin_reference_catalog`（Rust 读账本） | 声明了什么能力 |
// | 用户配置的 server | `~/.awo/mcp-servers.json` | 允许执行什么 |
// | 连接状态 | `McpConnectionRegistry` | 此刻真的连上了什么 |
//
// 只有三者交集才进提示。少了任何一环都会让模型去调不存在的工具：
// 只看声明 → 插件能凭空声称能力；只看配置 → 用户配了但没连上。
//
// ## 身份只来自链接
//
// 用户写 `[hello](plugin://hello@official)`。label 不参与判定 —— 否则
// `[可信名](plugin://evil@attacker)` 这种写法就能骗过模型。这条由 `@awo/plugin-reference`
// 保证，这里只是把它接上。

import {
  buildPluginReferenceCatalog,
  buildPluginReferenceReminderBody,
  extractPluginReferences,
  type PluginCatalogSource,
  type PluginReferenceReminderDiagnostics,
} from '@awo/plugin-reference';

import type { InstalledPluginCatalogEntry } from './plugin-reference-catalog';
import type { McpServerStatus } from './mcp-servers-store';

export interface PluginReferenceContextInput {
  readonly text: string;
  readonly installed: readonly InstalledPluginCatalogEntry[];
  readonly servers: readonly McpServerStatus[];
}

export interface PluginReferenceContext {
  /** 可直接追加到本轮上下文的提示体；`null` 表示没有可提示的能力。 */
  readonly reminderBody: string | null;
  /** 本轮识别出的插件 id（首现顺序、已去重、已限量）。 */
  readonly references: readonly string[];
  readonly diagnostics: PluginReferenceReminderDiagnostics;
}

/**
 * 构建本轮插件提示。
 *
 * 纯函数：不读盘、不连接、不发请求 —— 输入给什么就用什么，因此可以把
 * "为什么这条没提示"完整测出来。
 */
export function buildPluginReferenceContext(input: PluginReferenceContextInput): PluginReferenceContext {
  // 目录里放**全部已安装插件**（含没声明 server 的）：这样引用一个没有能力的插件时
  // 得到的是 `no_live_capabilities`，而不是"未知插件"——前者是"你装了但用不了"，
  // 后者会让人以为装错了。
  const sources: PluginCatalogSource[] = input.installed.map((plugin) => ({
    id: plugin.pluginId,
    name: plugin.name,
    marketplace: plugin.marketplace,
    enabled: true,
    ...(plugin.mcpServerId ? { mcpServerIds: [plugin.mcpServerId] } : {}),
  }));
  const { catalog } = buildPluginReferenceCatalog(sources);

  const extracted = extractPluginReferences(input.text);
  const reminder = buildPluginReferenceReminderBody({
    references: extracted.references,
    catalog,
    liveMcpServers: input.servers,
  });

  return {
    reminderBody: reminder.body,
    references: extracted.references,
    diagnostics: reminder.diagnostics,
  };
}

/**
 * 把提示体包成上下文块。
 *
 * 单独加一段而不是拼进用户原话：用户消息要保持原样（它是证据），
 * 而能力提示是系统侧的补充。
 */
export function pluginReminderBlock(body: string | null): string {
  if (!body) return '';
  return `\n\n以下是本轮被引用插件声明的能力。它只说明这些标识符存在，不代表你已经调用过；不要据此声称做了未做的事。\n\n${body}`;
}
