// `@` 引用的候选项构建：把「已安装插件」「用户配置的 MCP server」「实时连接状态」
// 合成一份**本轮可插入**的清单。
//
// ## 为什么不是"列出所有已安装插件"
//
// 引用的效果取决于三件事的交集：插件**声明**了某个 server、用户**配置**了同名 server、
// 那个 server 此刻**真的连着且有可见工具**。少了任何一环，reminder 都会把它跳过
// （`no_live_capabilities`）。
//
// 若 picker 列出全部已安装插件，用户插进来的引用会有相当一部分**什么也不产生** ——
// 那不是"多一个选项"，是让用户以为 `@` 生效了。所以默认只列**可用**的，
// 其余按原因归入"未就绪"，并写清楚要做什么才能用。
//
// ## 身份形态
//
// 插入文本是 `[label](plugin://stableId)`，其中 **stableId 是唯一身份**，label 只是显示名。
// 这条与 `@awo/plugin-reference` 的解析契约一致：label 永不参与判定，
// 否则 `[可信名字](plugin://evil@attacker)` 这种写法就能骗过模型。

import { isValidPluginStableId } from '@awo/plugin-reference';

import type { InstalledPluginCatalogEntry } from './plugin-reference-catalog';
import type { McpServerStatus } from './mcp-servers-store';

/** 一条候选的三态。 */
export type PluginMentionReadiness =
  /** 声明 ∩ 配置 ∩ 已连接：插入后本轮真的会带出能力。 */
  | 'available'
  /** 装了、也配了 server，但此刻没连上或没有可见工具。 */
  | 'not_connected'
  /** 装了，但没有可用能力的任何前提（没声明 server / 没配置 server / 标识符非法）。 */
  | 'unconfigured';

/** 一条候选为什么不是 available。 */
export type PluginMentionBlockReason =
  | 'no_declared_server'
  | 'server_not_configured'
  | 'not_connected'
  | 'no_visible_tools'
  | 'invalid_identifier';

export interface PluginMentionCandidate {
  /** 插入用的 stable id（`name@marketplace`）。 */
  readonly stableId: string;
  /** 显示名。只用于渲染，不参与任何判定。 */
  readonly label: string;
  readonly marketplace: string;
  readonly version: string;
  readonly readiness: PluginMentionReadiness;
  /** `available` 时为 `undefined`；否则说明差在哪一步。 */
  readonly reason?: PluginMentionBlockReason;
  /** 该插件声明、且此刻已连接的 MCP server 名（`available` 时非空）。 */
  readonly liveServerNames: readonly string[];
  /** 该插件声明、但还没连上的 MCP server 名。 */
  readonly pendingServerNames: readonly string[];
}

export interface PluginMentionCatalogInput {
  readonly installed: readonly InstalledPluginCatalogEntry[];
  readonly servers: readonly McpServerStatus[];
}

export interface PluginMentionCatalog {
  /** 可插入的候选，按 stable id 排序（列表稳定，不随连接状态抖动）。 */
  readonly candidates: readonly PluginMentionCandidate[];
  /** 没有任何可用候选时为 `true`：picker 应当给出"去设置里登记 server"的指引，而不是空列表。 */
  readonly empty: boolean;
}

/** 判定一个插件的可用性。纯函数 —— 输入给什么用什么，因此可以完整测出"为什么这条不可用"。 */
export function resolvePluginMentionCandidate(
  plugin: InstalledPluginCatalogEntry,
  servers: readonly McpServerStatus[],
): PluginMentionCandidate {
  const base = {
    stableId: plugin.pluginId,
    label: plugin.name,
    marketplace: plugin.marketplace,
    version: plugin.version,
  };

  // 身份不合法的插件**根本不能进候选**：它的 stable id 过不了 reminder 的输出侧复验，
  // 插进去只会被当成 `invalid_identifier` 跳过，而用户看到的是"引用了一个插件"。
  if (!isValidPluginStableId(plugin.pluginId)) {
    return {
      ...base,
      readiness: 'unconfigured',
      reason: 'invalid_identifier',
      liveServerNames: [],
      pendingServerNames: [],
    };
  }

  if (!plugin.mcpServerId) {
    return {
      ...base,
      readiness: 'unconfigured',
      reason: 'no_declared_server',
      liveServerNames: [],
      pendingServerNames: [],
    };
  }

  const configured = servers.find((server) => server.serverName === plugin.mcpServerId);
  if (!configured) {
    return {
      ...base,
      readiness: 'unconfigured',
      reason: 'server_not_configured',
      liveServerNames: [],
      pendingServerNames: [],
    };
  }

  if (!configured.connected) {
    return {
      ...base,
      readiness: 'not_connected',
      reason: 'not_connected',
      liveServerNames: [],
      pendingServerNames: [plugin.mcpServerId],
    };
  }

  if (configured.providerVisibleToolCount <= 0) {
    // "连着但没东西可用"与"没连上"是两件事：前者要去查 allow/deny 过滤或 server 本身，
    // 后者只要点一次连接。合成一条会让排查走错方向。
    return {
      ...base,
      readiness: 'not_connected',
      reason: 'no_visible_tools',
      liveServerNames: [],
      pendingServerNames: [plugin.mcpServerId],
    };
  }

  return {
    ...base,
    readiness: 'available',
    liveServerNames: [plugin.mcpServerId],
    pendingServerNames: [],
  };
}

export function buildPluginMentionCatalog(input: PluginMentionCatalogInput): PluginMentionCatalog {
  const candidates = input.installed
    .map((plugin) => resolvePluginMentionCandidate(plugin, input.servers))
    .sort((left, right) => left.stableId.localeCompare(right.stableId));
  return { candidates, empty: candidates.length === 0 };
}

/** 插入文本。**label 只做显示**，身份全在 destination 里。 */
export function pluginMentionMarkup(candidate: PluginMentionCandidate): string {
  return `[${candidate.label}](plugin://${candidate.stableId})`;
}
