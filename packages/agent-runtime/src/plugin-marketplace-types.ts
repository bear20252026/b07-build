// 一个文件=一种作用：插件市场契约类型（市场源 / 市场清单 / 已知市场记录 / 安装记录 / 校验诊断）。
//
// 移植自 ZCode（Apache-2.0）：apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts
// 与 apps/zcode-cli/packages/contracts/src/plugins/index.ts 的插件市场类型闭集。
// 本仓库按 b07 语义收敛字段：保留上游的 MarketplaceSource 判别式联合、市场/插件清单形态
// 与 PluginValidationDiagnostic（code/message/path/pluginId/severity）语义；
// 新增 b07 专有的 mcpApp 声明桥（插件 → McpAppRegistry）与对应的诊断码。

/** 市场来源判别式联合；与上游一致，仅保留 b07 会真实落地的分支。 */
export type MarketplaceSource =
  | { source: 'url'; url: string }
  | { source: 'git'; url: string; ref?: string }
  | { source: 'github'; repo: string; ref?: string }
  | { source: 'file'; path: string }
  | { source: 'directory'; path: string }
  | { source: 'npm'; package: string };

/** 市场清单里的单个插件条目；`raw` 保留原始对象供展示性回退与扩展字段读取。 */
export interface PluginMarketplaceEntry {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  raw: Record<string, unknown>;
}

/** 市场清单（`.claude-plugin/marketplace.json` 或 `marketplace.json`）。 */
export interface PluginMarketplaceManifest {
  name: string;
  description?: string;
  plugins: PluginMarketplaceEntry[];
  raw: Record<string, unknown>;
}

/** 已登记市场记录；持久化到 PluginMarketplaceStore。 */
export interface KnownMarketplaceRecord {
  id: string;
  name: string;
  source: MarketplaceSource;
  description?: string;
  addedAt: string;
  lastUpdated?: string;
  pluginCount: number;
}

/** 已安装插件记录；`appId` 指向由 install 注册到 McpAppRegistry 的宿主应用。 */
export interface InstalledPluginRecord {
  /** 稳定插件 id：`${name}@${marketplace}`。 */
  id: string;
  name: string;
  marketplace: string;
  version: string;
  /** 插件包根目录（本地/缓存路径）。 */
  rootPath: string;
  /** 安装时登记的 McpApp id；纯元数据插件（未声明 mcpApp）为空。 */
  appId?: string;
  installedAt: string;
}

/**
 * 插件市场诊断码。前六个沿用上游 PluginDiagnosticCode 的语义；
 * 后两个是 b07 新增：插件包内 plugin.json 声明宿主 MCP App 时的桥接结果。
 */
export type PluginDiagnosticCode =
  | 'plugin_manifest_not_found'
  | 'plugin_manifest_invalid'
  | 'plugin_marketplace_invalid'
  | 'plugin_marketplace_source_unsupported'
  | 'plugin_not_found'
  | 'plugin_app_declaration_missing'
  | 'plugin_app_registration_failed';

export type PluginDiagnosticSeverity = 'warning' | 'error';

/** 与上游 PluginValidationDiagnostic 同形：可读诊断 + 定位信息 + 严重级别。 */
export interface PluginValidationDiagnostic {
  code: PluginDiagnosticCode;
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnosticSeverity;
}

/** 插件包内 plugin.json 的展示性回退字段（作者/主页/版本）；商店信息缺失时兜底。 */
export interface PluginManifestDisplayMetadata {
  author?: string;
  authorUrl?: string;
  homepage?: string;
  version?: string;
}

/**
 * b07 专有桥：插件包在 plugin.json 里声明其宿主 MCP App。
 * 缺省表示纯元数据插件，安装时不注册应用（只登记元数据 + 警告诊断）。
 */
export interface PluginMcpAppDeclaration {
  /** 已登记且已启用（enabled）的 MCP server id。 */
  serverId: string;
  htmlResourceUri: string;
  requestedToolNames: string[];
  apiOrigins?: string[];
}

/** 插件包清单（`.zcode-plugin/plugin.json` / `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`）。 */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: unknown;
  homepage?: string;
  mcpApp?: PluginMcpAppDeclaration;
  raw: Record<string, unknown>;
}
