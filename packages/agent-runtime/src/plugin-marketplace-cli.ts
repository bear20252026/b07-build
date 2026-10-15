// 一个文件=一种作用：插件市场 CLI（argv 解析 + 输出注入 + 默认依赖装配）。
//
// 移植自 ZCode（Apache-2.0）：apps/zcode-cli/packages/cli/src/plugins-marketplace-command.ts
// 与 plugins-command.ts 的子命令分发与 --json 输出形态。
//
// b07 差异：上游把 runMarketplaceCommand 与 runPluginsCommand 分开（marketplace 只管市场，
// plugins 管安装/启用）；本批次按方案原文合并为 `plugin-marketplace add|install|enable|list`，
// 四个子命令统一支持 --json。核心函数不读 process.argv、不直接写 console，
// argv 与输出通道全部注入，便于单测。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpAppRegistry, SqliteMcpAppStore } from './mcp-app-registry.js';
import { SqliteMcpManifestStore } from './mcp-registry.js';
import type { InstallPluginResult, PluginMarketplaceListing } from './plugin-marketplace.js';
import { PluginMarketplace } from './plugin-marketplace.js';
import { SqlitePluginMarketplaceStore } from './plugin-marketplace-store.js';
import type { KnownMarketplaceRecord, PluginValidationDiagnostic } from './plugin-marketplace-types.js';

/** 输出通道注入点。 */
export interface PluginMarketplaceCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** CLI 依赖注入点。 */
export interface PluginMarketplaceCliDependencies {
  marketplace: PluginMarketplace;
}

/** 用法错误：缺少/多余参数、未知选项。 */
export class PluginMarketplaceUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginMarketplaceUsageError';
  }
}

const USAGE =
  '用法：plugin-marketplace <add <source> | install <name@marketplace> | enable <mcpapp-id> | list> [--json]';

interface ParsedArgv {
  action: string;
  positionals: string[];
  json: boolean;
}

/** 解析 argv：首个 token 为子命令，`--json` 为输出开关，其余为位置参数。 */
export function parsePluginMarketplaceArgv(argv: readonly string[]): ParsedArgv {
  const [action, ...rest] = argv;
  if (!action) throw new PluginMarketplaceUsageError(`缺少子命令；${USAGE}`);
  const positionals: string[] = [];
  let json = false;
  for (const token of rest) {
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token.startsWith('--')) throw new PluginMarketplaceUsageError(`未知选项：${token}`);
    positionals.push(token);
  }
  return { action, positionals, json };
}

function requireExactlyOne(positionals: readonly string[], action: string): string {
  if (positionals.length !== 1) throw new PluginMarketplaceUsageError(`${action} 需要且仅需要一个参数；${USAGE}`);
  return positionals[0] as string;
}

function formatMarketplaceJson(record: KnownMarketplaceRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    pluginCount: record.pluginCount,
    source: record.source,
    addedAt: record.addedAt,
    ...(record.description ? { description: record.description } : {}),
    ...(record.lastUpdated ? { lastUpdated: record.lastUpdated } : {}),
  };
}

function formatDiagnosticJson(diagnostic: PluginValidationDiagnostic): Record<string, unknown> {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
  };
}

function formatListingJson(listing: PluginMarketplaceListing): Record<string, unknown> {
  return {
    ok: true,
    marketplaces: listing.marketplaces.map(formatMarketplaceJson),
    installed: listing.installed.map((record) => ({
      id: record.id,
      name: record.name,
      marketplace: record.marketplace,
      version: record.version,
      rootPath: record.rootPath,
      installedAt: record.installedAt,
      ...(record.appId ? { appId: record.appId } : {}),
    })),
    apps: listing.apps.map((app) => ({ id: app.id, displayName: app.displayName, status: app.status, revision: app.revision })),
  };
}

function formatInstallJson(result: InstallPluginResult): Record<string, unknown> {
  return {
    ok: result.ok,
    ...(result.installed
      ? {
          plugin: {
            id: result.installed.id,
            name: result.installed.name,
            marketplace: result.installed.marketplace,
            version: result.installed.version,
            rootPath: result.installed.rootPath,
            installedAt: result.installed.installedAt,
            ...(result.installed.appId ? { appId: result.installed.appId } : {}),
          },
        }
      : {}),
    ...(result.app ? { app: { id: result.app.id, displayName: result.app.displayName, status: result.app.status, revision: result.app.revision } } : {}),
    diagnostics: result.diagnostics.map(formatDiagnosticJson),
  };
}

function writeJson(io: PluginMarketplaceCliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function writeFailure(io: PluginMarketplaceCliIo, json: boolean, message: string, diagnostics: readonly PluginValidationDiagnostic[] = []): number {
  if (json) {
    io.stderr(`${JSON.stringify({ ok: false, error: { message }, diagnostics: diagnostics.map(formatDiagnosticJson) }, null, 2)}\n`);
  } else {
    io.stderr(`${message}\n`);
    for (const diagnostic of diagnostics) io.stderr(`- [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}\n`);
  }
  return 1;
}

/**
 * 可单测的 CLI 入口：argv 与输出通道全部注入。
 * 返回进程退出码（0 成功 / 1 失败），由薄 shim 落到 process.exitCode。
 */
export async function runPluginMarketplaceCli(
  argv: readonly string[],
  io: PluginMarketplaceCliIo,
  dependencies: PluginMarketplaceCliDependencies,
): Promise<number> {
  let parsed: ParsedArgv;
  try {
    parsed = parsePluginMarketplaceArgv(argv);
  } catch (error) {
    return writeFailure(io, false, error instanceof Error ? error.message : String(error));
  }
  const { action, positionals, json } = parsed;
  const { marketplace } = dependencies;

  try {
    switch (action) {
      case 'add': {
        const source = requireExactlyOne(positionals, 'add');
        const result = await marketplace.addMarketplace({ source });
        if (!result.ok || !result.record) {
          return writeFailure(io, json, '添加市场失败', result.diagnostics);
        }
        if (json) writeJson(io, { ok: true, marketplace: formatMarketplaceJson(result.record) });
        else io.stdout(`已添加市场 ${result.record.id}（${result.record.pluginCount} 个插件）\n`);
        return 0;
      }
      case 'install': {
        const pluginId = requireExactlyOne(positionals, 'install');
        const result = await marketplace.installPlugin({ pluginId });
        if (!result.ok) {
          return writeFailure(io, json, `安装插件失败：${pluginId}`, result.diagnostics);
        }
        if (json) writeJson(io, formatInstallJson(result));
        else {
          io.stdout(`已安装插件 ${result.installed?.id ?? pluginId}\n`);
          for (const diagnostic of result.diagnostics) io.stderr(`- [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}\n`);
        }
        return 0;
      }
      case 'enable': {
        const appId = requireExactlyOne(positionals, 'enable');
        const app = marketplace.enableApp({ appId });
        if (json) writeJson(io, { ok: true, app: { id: app.id, displayName: app.displayName, status: app.status, revision: app.revision } });
        else io.stdout(`已启用应用 ${app.id}（${app.status}）\n`);
        return 0;
      }
      case 'list': {
        if (positionals.length > 0) throw new PluginMarketplaceUsageError(`list 不接受位置参数；${USAGE}`);
        const listing = marketplace.list();
        if (json) writeJson(io, formatListingJson(listing));
        else {
          io.stdout(`市场 ${listing.marketplaces.length} 个、已安装插件 ${listing.installed.length} 个、宿主应用 ${listing.apps.length} 个\n`);
          for (const record of listing.marketplaces) io.stdout(`- 市场 ${record.id}（${record.pluginCount} 个插件）\n`);
          for (const record of listing.installed) io.stdout(`- 插件 ${record.id} v${record.version}\n`);
          for (const app of listing.apps) io.stdout(`- 应用 ${app.id} [${app.status}]\n`);
        }
        return 0;
      }
      default:
        throw new PluginMarketplaceUsageError(`未知子命令：${action}；${USAGE}`);
    }
  } catch (error) {
    if (error instanceof PluginMarketplaceUsageError) return writeFailure(io, json, error.message);
    return writeFailure(io, json, error instanceof Error ? error.message : String(error));
  }
}

export interface DefaultPluginMarketplaceCliOptions {
  /** 数据目录；默认取 AWO_PLUGIN_MARKETPLACE_HOME 或 ~/.awo/plugin-marketplace。 */
  home?: string;
  /** 审查者标识；默认 plugin-marketplace-cli。 */
  reviewedBy?: string;
}

/**
 * 装配默认 CLI 依赖：SQLite 持久化的市场 store + McpAppRegistry（含 MCP server store）。
 * 需要 `--experimental-sqlite`（与仓库测试一致）。
 */
export function createDefaultPluginMarketplaceCliDependencies(
  options: DefaultPluginMarketplaceCliOptions = {},
): PluginMarketplaceCliDependencies & { home: string; close(): void } {
  const home = options.home ?? process.env.AWO_PLUGIN_MARKETPLACE_HOME ?? join(homedir(), '.awo', 'plugin-marketplace');
  const store = new SqlitePluginMarketplaceStore(join(home, 'plugin-marketplace.sqlite'));
  const serverStore = new SqliteMcpManifestStore(join(home, 'mcp-servers.sqlite'));
  const appStore = new SqliteMcpAppStore(join(home, 'mcp-apps.sqlite'));
  const marketplace = new PluginMarketplace({
    store,
    appRegistry: new McpAppRegistry(appStore, serverStore),
    reviewedBy: options.reviewedBy ?? 'plugin-marketplace-cli',
  });
  return {
    home,
    marketplace,
    close(): void {
      store.close();
      serverStore.close();
      appStore.close();
    },
  };
}
