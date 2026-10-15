import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryMcpAppStore,
  InMemoryMcpManifestStore,
  InMemoryPluginMarketplaceStore,
  McpAppRegistry,
  McpRegistry,
  parsePluginMarketplaceArgv,
  PluginMarketplace,
  PluginMarketplaceUsageError,
  runPluginMarketplaceCli,
  type PluginMarketplaceCliDependencies,
} from '../src/index.js';

interface CapturedIo {
  io: { stdout(text: string): void; stderr(text: string): void };
  out: string[];
  err: string[];
}

function createIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, out, err };
}

function writeMarketplaceFixture(root: string): string {
  const marketplaceRoot = join(root, 'marketplace');
  mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({ name: 'local-market', plugins: [{ name: 'hello-plugin', version: '1.2.3' }] })}\n`,
    'utf8',
  );
  const pluginRoot = join(marketplaceRoot, 'hello-plugin', '.claude-plugin');
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    `${JSON.stringify({
      name: 'hello-plugin',
      version: '1.2.3',
      mcpApp: { serverId: 'awo.demo', htmlResourceUri: 'ui://hello/index.html', requestedToolNames: ['echo'] },
    })}\n`,
    'utf8',
  );
  return marketplaceRoot;
}

function createDependencies(): PluginMarketplaceCliDependencies {
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
  return {
    marketplace: new PluginMarketplace({
      store: new InMemoryPluginMarketplaceStore(),
      appRegistry: new McpAppRegistry(new InMemoryMcpAppStore(), serverStore),
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-01-01T00:00:00.000Z',
      reviewedBy: 'local-admin',
    }),
  };
}

test('CLI argv 解析：子命令、--json 开关、位置参数与未知选项', () => {
  assert.deepEqual(parsePluginMarketplaceArgv(['list', '--json']), { action: 'list', positionals: [], json: true });
  assert.deepEqual(parsePluginMarketplaceArgv(['add', './market', '--json']), { action: 'add', positionals: ['./market'], json: true });
  assert.deepEqual(parsePluginMarketplaceArgv(['install', 'hello-plugin@local-market']), {
    action: 'install',
    positionals: ['hello-plugin@local-market'],
    json: false,
  });
  assert.throws(() => parsePluginMarketplaceArgv([]), PluginMarketplaceUsageError);
  assert.throws(() => parsePluginMarketplaceArgv(['list', '--verbose']), /未知选项/);
});

test('CLI add/list：--json 输出市场记录，人类输出可读', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-cli-add-'));
  try {
    const marketplaceRoot = writeMarketplaceFixture(root);
    const deps = createDependencies();

    const addJson = createIo();
    assert.equal(await runPluginMarketplaceCli(['add', marketplaceRoot, '--json'], addJson.io, deps), 0);
    const added = JSON.parse(addJson.out.join('')) as { ok: boolean; marketplace: { id: string; pluginCount: number; source: { source: string } } };
    assert.equal(added.ok, true);
    assert.equal(added.marketplace.id, 'local-market');
    assert.equal(added.marketplace.pluginCount, 1);
    assert.equal(added.marketplace.source.source, 'directory');

    const listJson = createIo();
    assert.equal(await runPluginMarketplaceCli(['list', '--json'], listJson.io, deps), 0);
    const listed = JSON.parse(listJson.out.join('')) as { ok: boolean; marketplaces: unknown[]; installed: unknown[]; apps: unknown[] };
    assert.equal(listed.ok, true);
    assert.equal(listed.marketplaces.length, 1);
    assert.equal(listed.installed.length, 0);
    assert.equal(listed.apps.length, 0);

    const listHuman = createIo();
    assert.equal(await runPluginMarketplaceCli(['list'], listHuman.io, deps), 0);
    assert.match(listHuman.out.join(''), /市场 1 个/);
    assert.match(listHuman.out.join(''), /市场 local-market（1 个插件）/);

    const addHuman = createIo();
    assert.equal(await runPluginMarketplaceCli(['add', marketplaceRoot], addHuman.io, deps), 0);
    assert.match(addHuman.out.join(''), /已添加市场 local-market（1 个插件）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI install/enable：install 落 McpAppRegistry，enable 复用注册表', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-cli-install-'));
  try {
    const marketplaceRoot = writeMarketplaceFixture(root);
    const deps = createDependencies();
    const add = createIo();
    await runPluginMarketplaceCli(['add', marketplaceRoot, '--json'], add.io, deps);

    const install = createIo();
    assert.equal(await runPluginMarketplaceCli(['install', 'hello-plugin@local-market', '--json'], install.io, deps), 0);
    const installed = JSON.parse(install.out.join('')) as {
      ok: boolean;
      plugin: { id: string; appId: string; version: string };
      app: { id: string; status: string; revision: number };
      diagnostics: unknown[];
    };
    assert.equal(installed.ok, true);
    assert.equal(installed.plugin.id, 'hello-plugin@local-market');
    assert.equal(installed.plugin.appId, 'mcpapp-hello-plugin');
    assert.equal(installed.plugin.version, '1.2.3');
    assert.equal(installed.app.id, 'mcpapp-hello-plugin');
    assert.equal(installed.app.status, 'registered');
    assert.deepEqual(installed.diagnostics, []);

    const enable = createIo();
    assert.equal(await runPluginMarketplaceCli(['enable', 'mcpapp-hello-plugin', '--json'], enable.io, deps), 0);
    const enabled = JSON.parse(enable.out.join('')) as { ok: boolean; app: { id: string; status: string } };
    assert.equal(enabled.ok, true);
    assert.equal(enabled.app.status, 'enabled');

    const list = createIo();
    await runPluginMarketplaceCli(['list', '--json'], list.io, deps);
    const listed = JSON.parse(list.out.join('')) as { installed: { id: string }[]; apps: { status: string }[] };
    assert.deepEqual(listed.installed.map((record) => record.id), ['hello-plugin@local-market']);
    assert.deepEqual(listed.apps.map((app) => app.status), ['enabled']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 失败路径：未登记市场、缺失插件、未知子命令、缺参都返回 1 并给出诊断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-cli-fail-'));
  try {
    const marketplaceRoot = writeMarketplaceFixture(root);
    const deps = createDependencies();

    const notRegistered = createIo();
    assert.equal(await runPluginMarketplaceCli(['install', 'hello-plugin@local-market', '--json'], notRegistered.io, deps), 1);
    const notRegisteredBody = JSON.parse(notRegistered.err.join('')) as { ok: boolean; diagnostics: { code: string }[] };
    assert.equal(notRegisteredBody.ok, false);
    assert.equal(notRegisteredBody.diagnostics[0]?.code, 'plugin_marketplace_invalid');

    const add = createIo();
    await runPluginMarketplaceCli(['add', marketplaceRoot, '--json'], add.io, deps);

    const missing = createIo();
    assert.equal(await runPluginMarketplaceCli(['install', 'ghost-plugin@local-market', '--json'], missing.io, deps), 1);
    const missingBody = JSON.parse(missing.err.join('')) as { diagnostics: { code: string }[] };
    assert.equal(missingBody.diagnostics[0]?.code, 'plugin_not_found');

    const unknown = createIo();
    assert.equal(await runPluginMarketplaceCli(['publish'], unknown.io, deps), 1);
    assert.match(unknown.err.join(''), /未知子命令/);

    const noArgs = createIo();
    assert.equal(await runPluginMarketplaceCli([], noArgs.io, deps), 1);
    assert.match(noArgs.err.join(''), /缺少子命令/);

    const listWithArg = createIo();
    assert.equal(await runPluginMarketplaceCli(['list', 'extra'], listWithArg.io, deps), 1);
    assert.match(listWithArg.err.join(''), /list 不接受位置参数/);

    const addWithoutSource = createIo();
    assert.equal(await runPluginMarketplaceCli(['add'], addWithoutSource.io, deps), 1);
    assert.match(addWithoutSource.err.join(''), /需要且仅需要一个参数/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
