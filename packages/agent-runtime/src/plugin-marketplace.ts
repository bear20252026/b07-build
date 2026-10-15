// 一个文件=一种作用：插件市场领域逻辑（源解析 / 清单加载 / 包清单校验 / add-install-enable-list）。
//
// 移植自 ZCode（Apache-2.0）：apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts
// 的 parseMarketplaceSourceInput / loadMarketplaceManifestSync / findPluginManifestPath /
// readPluginManifestFromRoot / validatePluginRoot / toManifestDisplayMetadata 语义。
//
// b07 差异：
//   - 远端来源（url/git/github/npm）与真实 zip 下载/解包、official marketplace CDN 不落地；
//     来源加载收敛为可注入的 MarketplaceSourceResolver，默认只实现本地目录与 marketplace.json 文件。
//   - 插件包清单识别沿用上游三路径（.zcode-plugin / .claude-plugin / .codex-plugin），
//     本批次硬性要求兼容的 .claude-plugin/plugin.json 位于第二位，与上游顺序一致。
//   - 市场清单文件优先 `.claude-plugin/marketplace.json`（上游常量），回退根目录 `marketplace.json`。
//   - install 在通过校验后落 McpAppRegistry；插件通过 plugin.json 的 mcpApp 字段桥接宿主应用。
//   - 依赖闭包解析（resolveDependencyClosure）未移植：b07 插件市场不承载跨插件依赖。
//
// 设计借鉴（非源码移植）：市场条目声明路径（path/directory）的越界拒绝，借鉴自一个
// AGPL-3.0-or-later 的第三方项目（项目名与许可见 THIRD-PARTY-NOTICES.md「语义借用（非源码移植）」）；
// 本文件为 b07 独立实现，未复制任何上游代码。

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { McpAppManifest } from './mcp-app-registry.js';
import { McpAppRegistry } from './mcp-app-registry.js';
import type { PluginMarketplaceStore } from './plugin-marketplace-store.js';
import type {
  InstalledPluginRecord,
  KnownMarketplaceRecord,
  MarketplaceSource,
  PluginDiagnosticCode,
  PluginManifest,
  PluginManifestDisplayMetadata,
  PluginMarketplaceEntry,
  PluginMarketplaceManifest,
  PluginMcpAppDeclaration,
  PluginSourceProvenance,
  PluginValidationDiagnostic,
} from './plugin-marketplace-types.js';

/** 市场清单文件（上游 CLAUDE_MARKETPLACE_FILE 常量）。 */
export const MARKETPLACE_MANIFEST_PATH = join('.claude-plugin', 'marketplace.json');
/** 回退的市场清单文件（市场根目录直接放 marketplace.json）。 */
export const LEGACY_MARKETPLACE_MANIFEST_PATH = 'marketplace.json';

/** 插件包清单候选路径；顺序与上游 findPluginManifestPath 一致。 */
export const PLUGIN_MANIFEST_PATHS: readonly string[] = [
  join('.zcode-plugin', 'plugin.json'),
  join('.claude-plugin', 'plugin.json'),
  join('.codex-plugin', 'plugin.json'),
];

const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DEFAULT_PLUGIN_VERSION = '0.0.0';

/** 领域错误：携带诊断码，便于在结果里原样外显可读诊断。 */
export class PluginMarketplaceError extends Error {
  constructor(
    readonly code: PluginDiagnosticCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'PluginMarketplaceError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** 把任意错误归一为诊断；未知错误按市场清单非法处理。 */
export function toPluginDiagnostic(error: unknown, pluginId?: string): PluginValidationDiagnostic {
  if (error instanceof PluginMarketplaceError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.path ? { path: error.path } : {}),
      ...(pluginId ? { pluginId } : {}),
      severity: 'error',
    };
  }
  return {
    code: 'plugin_marketplace_invalid',
    message: error instanceof Error ? error.message : String(error),
    ...(pluginId ? { pluginId } : {}),
    severity: 'error',
  };
}

function splitRef(value: string): { url: string; ref?: string } {
  const at = value.lastIndexOf('@');
  // 仅当 `@` 出现在 scheme 之后且不在路径首段时才视为 ref，避免把 `git@host:repo` 拆坏。
  const hash = value.indexOf('#');
  if (hash >= 0) {
    const url = value.slice(0, hash);
    const ref = value.slice(hash + 1).trim();
    return ref ? { url, ref } : { url };
  }
  const scheme = value.indexOf('://');
  if (at > scheme + 3 && !value.slice(scheme + 3, at).includes('/')) {
    const url = value.slice(0, at);
    const ref = value.slice(at + 1).trim();
    return ref ? { url, ref } : { url };
  }
  return { url: value };
}

/**
 * 解析市场来源字符串为 MarketplaceSource。
 * 支持：http(s) URL（.git / github.com 归一为 git）、本地目录、本地 .json 文件、
 * `owner/repo` GitHub 简写。与上游 parseMarketplaceSourceInput 的判别顺序一致。
 */
export function parseMarketplaceSourceInput(input: string): MarketplaceSource {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new PluginMarketplaceError('plugin_marketplace_source_unsupported', '市场来源为空');

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const { url, ref } = splitRef(trimmed);
    if (url.endsWith('.git') || url.includes('/_git/')) return ref ? { source: 'git', url, ref } : { source: 'git', url };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PluginMarketplaceError('plugin_marketplace_source_unsupported', `市场来源 URL 无效：${input}`);
    }
    if (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') {
      const gitUrl = url.endsWith('.git') ? url : `${url}.git`;
      return ref ? { source: 'git', url: gitUrl, ref } : { source: 'git', url: gitUrl };
    }
    return { source: 'url', url };
  }

  // 本地路径：绝对路径或显式相对路径（含 . / .. / 盘符）。存在性交由来源解析器判定。
  if (trimmed.startsWith('.') || trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(trimmed)) {
    const resolved = resolve(trimmed);
    return trimmed.endsWith('.json') ? { source: 'file', path: resolved } : { source: 'directory', path: resolved };
  }

  if (trimmed.includes('/') && !trimmed.includes(':')) {
    const { url: repo, ref } = splitRef(trimmed);
    return ref ? { source: 'github', repo, ref } : { source: 'github', repo };
  }

  throw new PluginMarketplaceError('plugin_marketplace_source_unsupported', `不支持的市场来源：${input}`);
}

/** 市场清单文件定位：优先 `.claude-plugin/marketplace.json`，回退根目录 `marketplace.json`。 */
export function resolveMarketplaceManifestPath(rootPath: string): string | undefined {
  for (const candidate of [MARKETPLACE_MANIFEST_PATH, LEGACY_MARKETPLACE_MANIFEST_PATH]) {
    const path = join(rootPath, candidate);
    try {
      readFileSync(path);
      return path;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  return undefined;
}

/** 解析并校验市场清单对象；非法时抛 PluginMarketplaceError（plugin_marketplace_invalid）。 */
export function parseMarketplaceManifest(value: unknown, path?: string): PluginMarketplaceManifest {
  if (!isRecord(value)) throw new PluginMarketplaceError('plugin_marketplace_invalid', '市场清单必须是 JSON 对象', path);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!MARKETPLACE_NAME_PATTERN.test(name)) {
    throw new PluginMarketplaceError('plugin_marketplace_invalid', `市场名非法（需 ^[a-z0-9][a-z0-9._-]{0,127}$）：${name}`, path);
  }
  const rawPlugins = value.plugins;
  const entries: unknown[] = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) => (isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName }))
      : [];
  const plugins: PluginMarketplaceEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const entryName = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!PLUGIN_NAME_PATTERN.test(entryName)) {
      throw new PluginMarketplaceError('plugin_marketplace_invalid', `市场条目插件名非法：${entryName || '<空>'}`, path);
    }
    plugins.push({
      name: entryName,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
      raw: entry,
    });
  }
  return {
    name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    plugins,
    raw: value,
  };
}

/** 从文件加载市场清单。 */
export function loadMarketplaceManifest(manifestPath: string): PluginMarketplaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new PluginMarketplaceError(
      'plugin_marketplace_invalid',
      `市场清单不可读：${error instanceof Error ? error.message : String(error)}`,
      manifestPath,
    );
  }
  return parseMarketplaceManifest(parsed, manifestPath);
}

/** 从市场根目录加载清单（`.claude-plugin/marketplace.json` 优先）。 */
export function loadMarketplaceManifestFromDirectory(rootPath: string): PluginMarketplaceManifest {
  const manifestPath = resolveMarketplaceManifestPath(rootPath);
  if (!manifestPath) {
    throw new PluginMarketplaceError(
      'plugin_marketplace_invalid',
      `市场目录缺少 ${MARKETPLACE_MANIFEST_PATH}（或 ${LEGACY_MARKETPLACE_MANIFEST_PATH}）：${rootPath}`,
      rootPath,
    );
  }
  return loadMarketplaceManifest(manifestPath);
}

/** 插件包清单定位；返回首个存在的候选路径。 */
export function findPluginManifestPath(rootPath: string): string | undefined {
  for (const candidate of PLUGIN_MANIFEST_PATHS) {
    const path = join(rootPath, candidate);
    try {
      readFileSync(path);
      return path;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  return undefined;
}

function parsePluginMcpApp(value: unknown, pluginName: string): PluginMcpAppDeclaration | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`插件「${pluginName}」的 mcpApp 声明必须是对象`);
  const serverId = typeof value.serverId === 'string' ? value.serverId.trim() : '';
  const htmlResourceUri = typeof value.htmlResourceUri === 'string' ? value.htmlResourceUri.trim() : '';
  const requestedToolNames = Array.isArray(value.requestedToolNames) ? value.requestedToolNames.filter(isString) : [];
  if (!serverId || !htmlResourceUri || requestedToolNames.length === 0) {
    throw new Error(`插件「${pluginName}」的 mcpApp 声明缺少 serverId / htmlResourceUri / requestedToolNames`);
  }
  const apiOrigins = Array.isArray(value.apiOrigins) ? value.apiOrigins.filter(isString) : undefined;
  return {
    serverId,
    htmlResourceUri,
    requestedToolNames,
    ...(apiOrigins && apiOrigins.length > 0 ? { apiOrigins } : {}),
  };
}

/** 解析插件包清单文本；非法时抛普通 Error（由调用方转成 plugin_manifest_invalid 诊断）。 */
export function parsePluginManifest(text: string, path?: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`插件清单 JSON 解析失败（${path ?? '<inline>'}）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('插件清单必须是 JSON 对象');
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`插件名非法（需 ^[a-z0-9][a-z0-9._-]{0,127}$）：${name || '<空>'}`);
  const mcpApp = parsePluginMcpApp(parsed.mcpApp, name);
  return {
    name,
    version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version : DEFAULT_PLUGIN_VERSION,
    ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
    ...(parsed.author !== undefined ? { author: parsed.author } : {}),
    ...(typeof parsed.homepage === 'string' ? { homepage: parsed.homepage } : {}),
    ...(mcpApp ? { mcpApp } : {}),
    raw: parsed,
  };
}

/**
 * 识别并校验插件包清单（兼容 `.claude-plugin/plugin.json`）。
 * 返回可读诊断：找不到清单 → plugin_manifest_not_found；解析/命名/名称不一致 → plugin_manifest_invalid。
 */
export function inspectPluginPackage(input: {
  rootPath: string;
  expectedName: string;
  pluginId: string;
}): { manifest?: PluginManifest; manifestPath?: string; diagnostics: PluginValidationDiagnostic[] } {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const manifestPath = findPluginManifestPath(input.rootPath);
  if (!manifestPath) {
    diagnostics.push({
      code: 'plugin_manifest_not_found',
      message: `未找到插件清单（${PLUGIN_MANIFEST_PATHS.join(' / ')}）：${input.rootPath}`,
      path: input.rootPath,
      pluginId: input.pluginId,
      severity: 'error',
    });
    return { diagnostics };
  }
  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(readFileSync(manifestPath, 'utf8'), manifestPath);
  } catch (error) {
    diagnostics.push({
      code: 'plugin_manifest_invalid',
      message: error instanceof Error ? error.message : String(error),
      path: manifestPath,
      pluginId: input.pluginId,
      severity: 'error',
    });
    return { diagnostics };
  }
  if (manifest.name !== input.expectedName) {
    diagnostics.push({
      code: 'plugin_manifest_invalid',
      message: `插件清单 name「${manifest.name}」与市场条目「${input.expectedName}」不一致`,
      path: manifestPath,
      pluginId: input.pluginId,
      severity: 'error',
    });
  }
  return { manifest, manifestPath, diagnostics };
}

function normalizeAuthorValue(value: unknown): { name?: string; url?: string } | undefined {
  if (typeof value === 'string') {
    const name = value.trim();
    return name ? { name } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : undefined;
  const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : undefined;
  return name || url ? { ...(name ? { name } : {}), ...(url ? { url } : {}) } : undefined;
}

/** 抽取 plugin.json 里可展示的回退字段；一个都没有时返回 undefined（上游 toManifestDisplayMetadata）。 */
export function toManifestDisplayMetadata(manifest: PluginManifest): PluginManifestDisplayMetadata | undefined {
  const author = normalizeAuthorValue(manifest.author);
  const metadata: PluginManifestDisplayMetadata = {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    ...(manifest.version ? { version: manifest.version } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** 插件 id 解析：`name@marketplace`。 */
export function parsePluginId(pluginId: string): { name: string; marketplace: string } | undefined {
  const at = pluginId.lastIndexOf('@');
  if (at <= 0 || at === pluginId.length - 1) return undefined;
  const name = pluginId.slice(0, at).trim();
  const marketplace = pluginId.slice(at + 1).trim();
  return name && marketplace ? { name, marketplace } : undefined;
}

/** 插件 → 宿主 McpApp id 的稳定映射（McpAppRegistry 要求 mcpapp- 前缀）。 */
export function pluginAppId(pluginName: string): string {
  return `mcpapp-${pluginName}`;
}

/** 来源加载结果：市场清单 + 目录型来源的插件包根目录 + 可选的来源出处。 */
export interface LoadedMarketplace {
  manifest: PluginMarketplaceManifest;
  rootPath?: string;
  /** 来源出处；远端 git 来源的解析器会填充，本地目录/文件来源为空。 */
  provenance?: PluginSourceProvenance;
}

/** 市场来源加载器；远端来源可注入自定义实现，默认实现只处理本地目录与文件。 */
export interface MarketplaceSourceResolver {
  load(source: MarketplaceSource): Promise<LoadedMarketplace> | LoadedMarketplace;
}

/**
 * 默认来源解析器：目录 → 读 `.claude-plugin/marketplace.json`；file → 读指定 json。
 * 远端来源（url/git/github/npm）本批次不落地网络下载，显式抛出可读诊断。
 */
export function createLocalMarketplaceSourceResolver(): MarketplaceSourceResolver {
  return {
    load(source: MarketplaceSource): LoadedMarketplace {
      if (source.source === 'directory') {
        return { manifest: loadMarketplaceManifestFromDirectory(source.path), rootPath: source.path };
      }
      if (source.source === 'file') {
        return { manifest: loadMarketplaceManifest(source.path), rootPath: dirname(source.path) };
      }
      throw new PluginMarketplaceError(
        'plugin_marketplace_source_unsupported',
        `本批次不落地远端市场来源（${source.source}）；请使用本地目录或 marketplace.json 文件，或注入自定义 MarketplaceSourceResolver`,
      );
    },
  };
}

/**
 * 校验并解析市场条目声明的相对路径（`raw.path` / `raw.directory`）。
 * 清单是外部输入，路径字段一旦越界就能把宿主指向市场根目录之外，故：
 *   - 拒绝绝对路径；
 *   - 拒绝含 `..` 段的路径（即便解析后仍在根内，也按越界处理，避免歧义与符号链接绕过）；
 *   - 解析后必须仍落在市场根目录之内。
 * 任一条不满足即返回 undefined（调用方据此 fail closed 并产出诊断）。
 */
function resolveDeclaredPluginPath(marketplaceRoot: string, declared: string): string | undefined {
  if (isAbsolute(declared)) return undefined;
  const segments = declared.split(/[\\/]+/u);
  if (segments.includes('..')) return undefined;
  const resolved = resolve(marketplaceRoot, declared);
  const rel = relative(marketplaceRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return resolved;
}

/** 插件包根目录定位结果：根目录（可选）+ 越界诊断。 */
interface PluginRootResolution {
  rootPath?: string;
  diagnostics: PluginValidationDiagnostic[];
}

/**
 * 插件包根目录定位：优先用条目声明的路径，其次按插件名、最后回退市场根目录。
 * 声明路径越界时 fail closed——不尝试任何回退候选，避免恶意清单借回退「洗白」。
 */
function resolvePluginRoot(
  marketplaceRoot: string | undefined,
  entry: PluginMarketplaceEntry,
  pluginId?: string,
): PluginRootResolution {
  const diagnostics: PluginValidationDiagnostic[] = [];
  if (!marketplaceRoot) return { diagnostics };
  const rawDeclared =
    typeof entry.raw.path === 'string' ? entry.raw.path : typeof entry.raw.directory === 'string' ? entry.raw.directory : undefined;
  const declared = rawDeclared?.trim();
  const candidates: string[] = [];
  if (declared) {
    const declaredPath = resolveDeclaredPluginPath(marketplaceRoot, declared);
    if (!declaredPath) {
      diagnostics.push({
        code: 'plugin_marketplace_entry_escaped',
        message: `市场条目「${entry.name}」声明的路径越出市场根目录：${declared}`,
        path: declared,
        ...(pluginId ? { pluginId } : {}),
        severity: 'error',
      });
      return { diagnostics };
    }
    candidates.push(declaredPath);
  }
  candidates.push(join(marketplaceRoot, entry.name));
  candidates.push(marketplaceRoot);
  return { rootPath: candidates.find((candidate) => findPluginManifestPath(candidate) !== undefined), diagnostics };
}

export interface PluginMarketplaceOptions {
  store: PluginMarketplaceStore;
  appRegistry: McpAppRegistry;
  sourceResolver?: MarketplaceSourceResolver;
  /** 注入时钟，便于测试；默认 Date.now。 */
  now?: () => number;
  /** 注入 ISO 时间戳，便于测试；默认 new Date().toISOString()。 */
  nowIso?: () => string;
  /** 审查者标识，写入 McpAppRegistry 的 reviewedBy。 */
  reviewedBy?: string;
}

export interface AddMarketplaceResult {
  ok: boolean;
  record?: KnownMarketplaceRecord;
  diagnostics: PluginValidationDiagnostic[];
}

export interface InstallPluginResult {
  ok: boolean;
  installed?: InstalledPluginRecord;
  app?: McpAppManifest;
  diagnostics: PluginValidationDiagnostic[];
}

export interface PluginMarketplaceListing {
  marketplaces: readonly KnownMarketplaceRecord[];
  installed: readonly InstalledPluginRecord[];
  apps: readonly McpAppManifest[];
}

/**
 * 插件市场：add / install / enable / list 的唯一所有者。
 * 它只做元数据登记与准入编排；install 的落地动作是把插件声明的宿主应用注册进 McpAppRegistry。
 */
export class PluginMarketplace {
  private readonly store: PluginMarketplaceStore;
  private readonly appRegistry: McpAppRegistry;
  private readonly resolver: MarketplaceSourceResolver;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly reviewedBy: string;

  constructor(options: PluginMarketplaceOptions) {
    this.store = options.store;
    this.appRegistry = options.appRegistry;
    this.resolver = options.sourceResolver ?? createLocalMarketplaceSourceResolver();
    this.now = options.now ?? (() => Date.now());
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.reviewedBy = options.reviewedBy ?? 'plugin-marketplace';
  }

  /** 添加/刷新市场：解析来源、加载清单、按 id 覆盖写入已知市场记录。 */
  async addMarketplace(input: { source: string }): Promise<AddMarketplaceResult> {
    let source: MarketplaceSource;
    try {
      source = parseMarketplaceSourceInput(input.source);
    } catch (error) {
      return { ok: false, diagnostics: [toPluginDiagnostic(error)] };
    }
    let loaded: LoadedMarketplace;
    try {
      loaded = await this.resolver.load(source);
    } catch (error) {
      return { ok: false, diagnostics: [toPluginDiagnostic(error)] };
    }
    const timestamp = this.nowIso();
    const record: KnownMarketplaceRecord = {
      id: loaded.manifest.name,
      name: loaded.manifest.name,
      source,
      ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
      addedAt: timestamp,
      lastUpdated: timestamp,
      pluginCount: loaded.manifest.plugins.length,
    };
    this.store.saveMarketplaces([...this.store.listMarketplaces().filter((item) => item.id !== record.id), record]);
    return { ok: true, record, diagnostics: [] };
  }

  /**
   * 安装插件：定位市场与条目 → 校验插件包清单 → 登记安装记录 → 注册宿主 McpApp。
   * 插件未声明 mcpApp 时只登记元数据（警告）；声明了但注册失败则整单失败（fail closed）。
   */
  async installPlugin(input: { pluginId: string }): Promise<InstallPluginResult> {
    const diagnostics: PluginValidationDiagnostic[] = [];
    const parsed = parsePluginId(input.pluginId);
    if (!parsed) {
      return {
        ok: false,
        diagnostics: [{ code: 'plugin_not_found', message: `插件 id 必须是 name@marketplace 形式：${input.pluginId}`, pluginId: input.pluginId, severity: 'error' }],
      };
    }
    const record = this.store.listMarketplaces().find((item) => item.id === parsed.marketplace);
    if (!record) {
      return {
        ok: false,
        diagnostics: [{ code: 'plugin_marketplace_invalid', message: `市场未登记：${parsed.marketplace}（先执行 add）`, pluginId: input.pluginId, severity: 'error' }],
      };
    }
    let loaded: LoadedMarketplace;
    try {
      loaded = await this.resolver.load(record.source);
    } catch (error) {
      return { ok: false, diagnostics: [toPluginDiagnostic(error, input.pluginId)] };
    }
    const entry = loaded.manifest.plugins.find((plugin) => plugin.name === parsed.name);
    if (!entry) {
      return {
        ok: false,
        diagnostics: [{ code: 'plugin_not_found', message: `市场中不存在插件：${input.pluginId}`, pluginId: input.pluginId, severity: 'error' }],
      };
    }
    const resolved = resolvePluginRoot(loaded.rootPath, entry, input.pluginId);
    diagnostics.push(...resolved.diagnostics);
    if (!resolved.rootPath) {
      diagnostics.push({
        code: 'plugin_manifest_not_found',
        message: `未能定位插件包根目录：${input.pluginId}`,
        pluginId: input.pluginId,
        severity: 'error',
      });
      return { ok: false, diagnostics };
    }
    const rootPath = resolved.rootPath;
    const inspected = inspectPluginPackage({ rootPath, expectedName: parsed.name, pluginId: input.pluginId });
    diagnostics.push(...inspected.diagnostics);
    if (!inspected.manifest || diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return { ok: false, diagnostics };
    }
    const manifest = inspected.manifest;

    // 幂等：已安装则直接返回既有记录与已注册应用。
    const existing = this.store.listInstalled().find((item) => item.id === input.pluginId);
    if (existing) {
      const app = existing.appId ? this.appRegistry.list().find((item) => item.id === existing.appId) : undefined;
      return { ok: true, installed: existing, ...(app ? { app } : {}), diagnostics };
    }

    let app: McpAppManifest | undefined;
    let appId: string | undefined;
    if (manifest.mcpApp) {
      appId = pluginAppId(manifest.name);
      const alreadyRegistered = this.appRegistry.list().find((item) => item.id === appId);
      if (alreadyRegistered) {
        app = alreadyRegistered;
      } else {
        try {
          app = this.appRegistry.register({
            id: appId,
            serverId: manifest.mcpApp.serverId,
            displayName: manifest.name,
            htmlResourceUri: manifest.mcpApp.htmlResourceUri,
            requestedToolNames: manifest.mcpApp.requestedToolNames,
            ...(manifest.mcpApp.apiOrigins ? { apiOrigins: manifest.mcpApp.apiOrigins } : {}),
            reviewedBy: this.reviewedBy,
            at: this.now(),
            note: `由插件市场安装：${input.pluginId}`,
          });
        } catch (error) {
          diagnostics.push({
            code: 'plugin_app_registration_failed',
            message: error instanceof Error ? error.message : String(error),
            pluginId: input.pluginId,
            severity: 'error',
          });
          return { ok: false, diagnostics };
        }
      }
    } else {
      diagnostics.push({
        code: 'plugin_app_declaration_missing',
        message: `插件「${input.pluginId}」未声明 mcpApp，仅登记元数据，不注册宿主应用`,
        pluginId: input.pluginId,
        severity: 'warning',
      });
    }

    const installed: InstalledPluginRecord = {
      id: input.pluginId,
      name: parsed.name,
      marketplace: parsed.marketplace,
      version: manifest.version ?? entry.version ?? DEFAULT_PLUGIN_VERSION,
      rootPath,
      ...(appId ? { appId } : {}),
      ...(loaded.provenance ? { provenance: loaded.provenance } : {}),
      installedAt: this.nowIso(),
    };
    this.store.saveInstalled([...this.store.listInstalled().filter((item) => item.id !== installed.id), installed]);
    return { ok: true, installed, ...(app ? { app } : {}), diagnostics };
  }

  /** 启用宿主应用：复用 McpAppRegistry 的显式启用（revoked 会被注册表拒绝）。 */
  enableApp(input: { appId: string }): McpAppManifest {
    return this.appRegistry.enable(input.appId, this.reviewedBy, this.now(), '由插件市场 CLI 显式启用');
  }

  /** 市场 / 已安装插件 / 宿主应用总览。 */
  list(): PluginMarketplaceListing {
    return {
      marketplaces: this.store.listMarketplaces(),
      installed: this.store.listInstalled(),
      apps: this.appRegistry.list(),
    };
  }
}
