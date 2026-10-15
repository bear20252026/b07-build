import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findPluginManifestPath,
  InMemoryMcpAppStore,
  InMemoryMcpManifestStore,
  InMemoryPluginMarketplaceStore,
  inspectPluginPackage,
  loadMarketplaceManifestFromDirectory,
  McpAppRegistry,
  McpRegistry,
  parseMarketplaceSourceInput,
  parsePluginId,
  pluginAppId,
  PluginMarketplace,
  PluginMarketplaceError,
  resolveMarketplaceManifestPath,
  SqlitePluginMarketplaceStore,
  toManifestDisplayMetadata,
} from '../src/index.js';

/** 写一个最小市场：`.claude-plugin/marketplace.json` + 一个 `.claude-plugin/plugin.json` 插件包。 */
function writeMarketplaceFixture(root: string, options: { pluginName?: string; mcpApp?: boolean } = {}): string {
  const marketplaceRoot = join(root, 'marketplace');
  const pluginName = options.pluginName ?? 'hello-plugin';
  mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({ name: 'local-market', description: '本地测试市场', plugins: [{ name: pluginName, version: '1.2.3' }] }, null, 2)}\n`,
    'utf8',
  );
  const pluginRoot = join(marketplaceRoot, pluginName, '.claude-plugin');
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    `${JSON.stringify(
      {
        name: pluginName,
        version: '1.2.3',
        author: { name: 'AWO', url: 'https://example.com/awo' },
        homepage: 'https://example.com/hello',
        ...(options.mcpApp === false
          ? {}
          : { mcpApp: { serverId: 'awo.demo', htmlResourceUri: 'ui://hello/index.html', requestedToolNames: ['echo'] } }),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return marketplaceRoot;
}

function createAppRegistry(): McpAppRegistry {
  const serverStore = new InMemoryMcpManifestStore();
  const servers = new McpRegistry(serverStore);
  servers.register({
    id: 'awo.demo',
    displayName: 'Demo MCP server',
    connection: { transport: 'stdio', executable: 'node', args: [] },
    declaredTools: [{ name: 'echo', description: '回显', capability: 'model.chat', risk: 'low' }],
    sourceDigest: 'a'.repeat(64),
    reviewedBy: 'local-admin',
    at: 1,
  });
  servers.enable('awo.demo', 'local-admin', 2);
  return new McpAppRegistry(new InMemoryMcpAppStore(), serverStore);
}

test('市场来源解析：本地目录/文件、GitHub 简写、远端 git 与非法输入', () => {
  assert.deepEqual(parseMarketplaceSourceInput('./fixtures/market'), { source: 'directory', path: join(process.cwd(), 'fixtures', 'market') });
  assert.equal(parseMarketplaceSourceInput('./market.json').source, 'file');
  assert.deepEqual(parseMarketplaceSourceInput('awo-org/plugins'), { source: 'github', repo: 'awo-org/plugins' });
  assert.deepEqual(parseMarketplaceSourceInput('awo-org/plugins#v1.2.3'), { source: 'github', repo: 'awo-org/plugins', ref: 'v1.2.3' });
  assert.deepEqual(parseMarketplaceSourceInput('https://example.com/market.git'), { source: 'git', url: 'https://example.com/market.git' });
  assert.deepEqual(parseMarketplaceSourceInput('https://example.com/catalog.json'), { source: 'url', url: 'https://example.com/catalog.json' });
  assert.throws(() => parseMarketplaceSourceInput('   '), PluginMarketplaceError);
  assert.throws(() => parseMarketplaceSourceInput('not-a-source'), /不支持的市场来源/);
});

test('市场清单加载：优先 .claude-plugin/marketplace.json，回退根目录 marketplace.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-market-'));
  try {
    const marketplaceRoot = writeMarketplaceFixture(root);
    assert.equal(resolveMarketplaceManifestPath(marketplaceRoot), join(marketplaceRoot, '.claude-plugin', 'marketplace.json'));
    const manifest = loadMarketplaceManifestFromDirectory(marketplaceRoot);
    assert.equal(manifest.name, 'local-market');
    assert.deepEqual(manifest.plugins.map((entry) => entry.name), ['hello-plugin']);
    assert.equal(manifest.plugins[0]?.version, '1.2.3');

    // 回退路径：删掉 .claude-plugin/marketplace.json，只留根目录 marketplace.json。
    rmSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'));
    writeFileSync(join(marketplaceRoot, 'marketplace.json'), `${JSON.stringify({ name: 'legacy-market', plugins: [] })}\n`, 'utf8');
    assert.equal(resolveMarketplaceManifestPath(marketplaceRoot), join(marketplaceRoot, 'marketplace.json'));
    assert.equal(loadMarketplaceManifestFromDirectory(marketplaceRoot).name, 'legacy-market');

    rmSync(join(marketplaceRoot, 'marketplace.json'));
    assert.throws(() => loadMarketplaceManifestFromDirectory(marketplaceRoot), /缺少/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('插件包清单识别：兼容 .claude-plugin/plugin.json，且 .zcode-plugin 优先', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-plugin-'));
  try {
    const marketplaceRoot = writeMarketplaceFixture(root);
    const pluginRoot = join(marketplaceRoot, 'hello-plugin');
    assert.equal(findPluginManifestPath(pluginRoot), join(pluginRoot, '.claude-plugin', 'plugin.json'));

    const inspected = inspectPluginPackage({ rootPath: pluginRoot, expectedName: 'hello-plugin', pluginId: 'hello-plugin@local-market' });
    assert.deepEqual(inspected.diagnostics, []);
    assert.equal(inspected.manifest?.name, 'hello-plugin');
    assert.equal(inspected.manifestPath, join(pluginRoot, '.claude-plugin', 'plugin.json'));
    assert.deepEqual(inspected.manifest?.mcpApp, {
      serverId: 'awo.demo',
      htmlResourceUri: 'ui://hello/index.html',
      requestedToolNames: ['echo'],
    });
    assert.deepEqual(toManifestDisplayMetadata(inspected.manifest!), {
      author: 'AWO',
      authorUrl: 'https://example.com/awo',
      homepage: 'https://example.com/hello',
      version: '1.2.3',
    });

    // .zcode-plugin 存在时优先于 .claude-plugin（对齐上游 findPluginManifestPath 顺序）。
    mkdirSync(join(pluginRoot, '.zcode-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, '.zcode-plugin', 'plugin.json'), `${JSON.stringify({ name: 'hello-plugin' })}\n`, 'utf8');
    assert.equal(findPluginManifestPath(pluginRoot), join(pluginRoot, '.zcode-plugin', 'plugin.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('插件包校验诊断：缺清单 / 名称不一致 / JSON 非法各有可读诊断', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-diag-'));
  try {
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    const missing = inspectPluginPackage({ rootPath: empty, expectedName: 'hello-plugin', pluginId: 'hello-plugin@local-market' });
    assert.equal(missing.diagnostics[0]?.code, 'plugin_manifest_not_found');
    assert.equal(missing.diagnostics[0]?.severity, 'error');
    assert.equal(missing.diagnostics[0]?.pluginId, 'hello-plugin@local-market');

    const mismatch = join(root, 'mismatch');
    mkdirSync(join(mismatch, '.claude-plugin'), { recursive: true });
    writeFileSync(join(mismatch, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'other-plugin' })}\n`, 'utf8');
    const mismatched = inspectPluginPackage({ rootPath: mismatch, expectedName: 'hello-plugin', pluginId: 'hello-plugin@local-market' });
    assert.equal(mismatched.diagnostics[0]?.code, 'plugin_manifest_invalid');
    assert.match(mismatched.diagnostics[0]?.message ?? '', /不一致/);

    const broken = join(root, 'broken');
    mkdirSync(join(broken, '.claude-plugin'), { recursive: true });
    writeFileSync(join(broken, '.claude-plugin', 'plugin.json'), '{ not json', 'utf8');
    const invalid = inspectPluginPackage({ rootPath: broken, expectedName: 'hello-plugin', pluginId: 'hello-plugin@local-market' });
    assert.equal(invalid.diagnostics[0]?.code, 'plugin_manifest_invalid');
    assert.equal(invalid.diagnostics[0]?.path, join(broken, '.claude-plugin', 'plugin.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('插件 id 与宿主应用 id 映射', () => {
  assert.deepEqual(parsePluginId('hello-plugin@local-market'), { name: 'hello-plugin', marketplace: 'local-market' });
  assert.equal(parsePluginId('local-market'), undefined);
  assert.equal(parsePluginId('@local-market'), undefined);
  assert.equal(pluginAppId('hello-plugin'), 'mcpapp-hello-plugin');
});

test('store：内存与 SQLite 都按 id 覆盖并可按序读回', () => {
  const memory = new InMemoryPluginMarketplaceStore();
  memory.saveMarketplaces([
    { id: 'b', name: 'b', source: { source: 'directory', path: '/b' }, addedAt: 't', pluginCount: 1 },
    { id: 'a', name: 'a', source: { source: 'directory', path: '/a' }, addedAt: 't', pluginCount: 2 },
  ]);
  assert.deepEqual(memory.listMarketplaces().map((record) => record.id), ['a', 'b']);
  memory.saveMarketplaces([{ id: 'a', name: 'a', source: { source: 'directory', path: '/a' }, addedAt: 't2', pluginCount: 3 }]);
  assert.equal(memory.listMarketplaces().length, 1);
  assert.equal(memory.listMarketplaces()[0]?.pluginCount, 3);

  const root = mkdtempSync(join(tmpdir(), 'awo-store-'));
  const sqlite = new SqlitePluginMarketplaceStore(join(root, 'market.sqlite'));
  try {
    sqlite.saveMarketplaces([{ id: 'a', name: 'a', source: { source: 'directory', path: '/a' }, addedAt: 't', pluginCount: 1 }]);
    sqlite.saveInstalled([{ id: 'p@a', name: 'p', marketplace: 'a', version: '1.0.0', rootPath: '/p', appId: 'mcpapp-p', installedAt: 't' }]);
    assert.deepEqual(sqlite.listMarketplaces().map((record) => record.id), ['a']);
    assert.equal(sqlite.listInstalled()[0]?.appId, 'mcpapp-p');
    sqlite.saveInstalled([]);
    assert.equal(sqlite.listInstalled().length, 0);
  } finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('PluginMarketplace：add → install 落 McpAppRegistry → enable 复用注册表', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-market-flow-'));
  try {
    const marketplaceRoot = writeMarketplaceFixture(root);
    const marketplace = new PluginMarketplace({
      store: new InMemoryPluginMarketplaceStore(),
      appRegistry: createAppRegistry(),
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-01-01T00:00:00.000Z',
      reviewedBy: 'local-admin',
    });

    const added = await marketplace.addMarketplace({ source: marketplaceRoot });
    assert.equal(added.ok, true);
    assert.equal(added.record?.id, 'local-market');
    assert.equal(added.record?.pluginCount, 1);
    assert.deepEqual(added.record?.source, { source: 'directory', path: marketplaceRoot });

    const installed = await marketplace.installPlugin({ pluginId: 'hello-plugin@local-market' });
    assert.equal(installed.ok, true, JSON.stringify(installed.diagnostics));
    assert.equal(installed.installed?.appId, 'mcpapp-hello-plugin');
    assert.equal(installed.app?.status, 'registered');
    assert.deepEqual(installed.app?.admittedToolNames, ['echo']);
    assert.deepEqual(installed.diagnostics, []);

    // 幂等：重复 install 返回既有记录，不重复登记。
    const again = await marketplace.installPlugin({ pluginId: 'hello-plugin@local-market' });
    assert.equal(again.ok, true);
    assert.equal(again.installed?.id, 'hello-plugin@local-market');

    const enabled = marketplace.enableApp({ appId: 'mcpapp-hello-plugin' });
    assert.equal(enabled.status, 'enabled');
    const listing = marketplace.list();
    assert.equal(listing.marketplaces.length, 1);
    assert.equal(listing.installed.length, 1);
    assert.deepEqual(listing.apps.map((app) => app.status), ['enabled']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PluginMarketplace：未登记市场、缺失插件、未声明 mcpApp 的诊断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-market-negative-'));
  try {
    const marketplaceRoot = writeMarketplaceFixture(root);
    const store = new InMemoryPluginMarketplaceStore();
    const marketplace = new PluginMarketplace({ store, appRegistry: createAppRegistry(), nowIso: () => '2026-01-01T00:00:00.000Z' });

    const unknownMarket = await marketplace.installPlugin({ pluginId: 'hello-plugin@nope' });
    assert.equal(unknownMarket.ok, false);
    assert.equal(unknownMarket.diagnostics[0]?.code, 'plugin_marketplace_invalid');

    await marketplace.addMarketplace({ source: marketplaceRoot });
    const missing = await marketplace.installPlugin({ pluginId: 'ghost-plugin@local-market' });
    assert.equal(missing.ok, false);
    assert.equal(missing.diagnostics[0]?.code, 'plugin_not_found');

    // 未声明 mcpApp：安装成功但只登记元数据，并给出 warning 诊断。
    const bare = writeMarketplaceFixture(join(root, 'bare'), { pluginName: 'bare-plugin', mcpApp: false });
    await marketplace.addMarketplace({ source: bare });
    const bareInstall = await marketplace.installPlugin({ pluginId: 'bare-plugin@local-market' });
    assert.equal(bareInstall.ok, true);
    assert.equal(bareInstall.installed?.appId, undefined);
    assert.equal(bareInstall.diagnostics[0]?.code, 'plugin_app_declaration_missing');
    assert.equal(bareInstall.diagnostics[0]?.severity, 'warning');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PluginMarketplace：远端来源默认解析器显式拒绝（本批次不落地网络下载）', async () => {
  const marketplace = new PluginMarketplace({ store: new InMemoryPluginMarketplaceStore(), appRegistry: createAppRegistry() });
  const result = await marketplace.addMarketplace({ source: 'https://example.com/catalog.json' });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, 'plugin_marketplace_source_unsupported');
});

/** 写一个「市场根目录 + 清单声明 path」的夹具，用于越界校验用例。 */
function writeMarketplaceWithDeclaredPath(root: string, declaredPath: string, pluginName: string): string {
  const marketplaceRoot = join(root, 'marketplace');
  mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({ name: 'local-market', plugins: [{ name: pluginName, path: declaredPath }] }, null, 2)}\n`,
    'utf8',
  );
  return marketplaceRoot;
}

test('清单路径越界：`..` 与绝对路径被拒绝（fail closed），合法相对路径继续可用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-escape-'));
  try {
    // 市场之外放一个「看起来合法」的插件包，恶意清单试图用路径指到它。
    const outsideRoot = join(root, 'outside');
    mkdirSync(join(outsideRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(outsideRoot, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'escapee' })}\n`, 'utf8');

    const store = new InMemoryPluginMarketplaceStore();
    const marketplace = new PluginMarketplace({ store, appRegistry: createAppRegistry(), nowIso: () => '2026-01-01T00:00:00.000Z' });

    // 1) 相对路径含 `..`：越界拒绝。
    const dotDot = writeMarketplaceWithDeclaredPath(root, '../../outside', 'escapee');
    await marketplace.addMarketplace({ source: dotDot });
    const relativeEscape = await marketplace.installPlugin({ pluginId: 'escapee@local-market' });
    assert.equal(relativeEscape.ok, false);
    assert.equal(relativeEscape.diagnostics[0]?.code, 'plugin_marketplace_entry_escaped');
    assert.equal(relativeEscape.diagnostics[0]?.severity, 'error');
    assert.equal(relativeEscape.diagnostics[0]?.pluginId, 'escapee@local-market');
    assert.equal(relativeEscape.installed, undefined);
    // 市场之外的那个包不得被登记。
    assert.equal(marketplace.list().installed.length, 0);

    // 2) 绝对路径：同样越界拒绝。
    const absolute = writeMarketplaceWithDeclaredPath(root, outsideRoot, 'escapee');
    await marketplace.addMarketplace({ source: absolute });
    const absoluteEscape = await marketplace.installPlugin({ pluginId: 'escapee@local-market' });
    assert.equal(absoluteEscape.ok, false);
    assert.equal(absoluteEscape.diagnostics[0]?.code, 'plugin_marketplace_entry_escaped');
    assert.equal(marketplace.list().installed.length, 0);

    // 3) 合法相对路径：声明 path 指向市场内的嵌套目录，安装继续成功且 rootPath 被采用。
    const legalRoot = join(root, 'legal');
    mkdirSync(join(legalRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(legalRoot, '.claude-plugin', 'marketplace.json'),
      `${JSON.stringify({ name: 'legal-market', plugins: [{ name: 'inner-plugin', path: 'nested/inner-plugin' }] }, null, 2)}\n`,
      'utf8',
    );
    mkdirSync(join(legalRoot, 'nested', 'inner-plugin', '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(legalRoot, 'nested', 'inner-plugin', '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'inner-plugin', version: '1.0.0' })}\n`,
      'utf8',
    );
    await marketplace.addMarketplace({ source: legalRoot });
    const legal = await marketplace.installPlugin({ pluginId: 'inner-plugin@legal-market' });
    assert.equal(legal.ok, true, JSON.stringify(legal.diagnostics));
    assert.equal(legal.installed?.rootPath, join(legalRoot, 'nested', 'inner-plugin'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
