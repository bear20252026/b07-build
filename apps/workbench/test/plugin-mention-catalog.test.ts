import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPluginMentionCatalog,
  pluginMentionMarkup,
  resolvePluginMentionCandidate,
  type PluginMentionCandidate,
} from '../src/runtime/plugin-mention-catalog';
import type { InstalledPluginCatalogEntry } from '../src/runtime/plugin-reference-catalog';
import type { McpServerStatus } from '../src/runtime/mcp-servers-store';

function plugin(overrides: Partial<InstalledPluginCatalogEntry> = {}): InstalledPluginCatalogEntry {
  return {
    pluginId: 'filesystem@official',
    name: 'Filesystem',
    marketplace: 'official',
    version: '1.0.0',
    appId: 'filesystem-app',
    mcpServerId: 'filesystem',
    requestedToolNames: ['read_file', 'write_file'],
    ...overrides,
  };
}

function server(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return { serverName: 'filesystem', connected: true, providerVisibleToolCount: 4, ...overrides };
}

describe('resolvePluginMentionCandidate', () => {
  it('声明 ∩ 配置 ∩ 已连接 → available', () => {
    const candidate = resolvePluginMentionCandidate(plugin(), [server()]);
    assert.equal(candidate.readiness, 'available');
    assert.equal(candidate.reason, undefined);
    assert.deepEqual(candidate.liveServerNames, ['filesystem']);
  });

  it('声明了 server 但用户没配置 → unconfigured / server_not_configured', () => {
    const candidate = resolvePluginMentionCandidate(plugin(), []);
    assert.equal(candidate.readiness, 'unconfigured');
    assert.equal(candidate.reason, 'server_not_configured');
    assert.deepEqual(candidate.liveServerNames, []);
  });

  it('配了但没连上 → not_connected / not_connected，并把 server 名放进 pending', () => {
    const candidate = resolvePluginMentionCandidate(plugin(), [server({ connected: false, providerVisibleToolCount: 0 })]);
    assert.equal(candidate.readiness, 'not_connected');
    assert.equal(candidate.reason, 'not_connected');
    assert.deepEqual(candidate.pendingServerNames, ['filesystem']);
  });

  it('连着但可见工具为 0 → not_connected / no_visible_tools（与"没连上"区分开）', () => {
    const candidate = resolvePluginMentionCandidate(plugin(), [server({ providerVisibleToolCount: 0 })]);
    assert.equal(candidate.readiness, 'not_connected');
    assert.equal(candidate.reason, 'no_visible_tools');
    assert.deepEqual(candidate.pendingServerNames, ['filesystem']);
  });

  it('插件没声明任何 server → unconfigured / no_declared_server', () => {
    const candidate = resolvePluginMentionCandidate(plugin({ mcpServerId: null }), [server()]);
    assert.equal(candidate.readiness, 'unconfigured');
    assert.equal(candidate.reason, 'no_declared_server');
  });

  it('stable id 非法 → unconfigured / invalid_identifier（不进候选）', () => {
    const candidate = resolvePluginMentionCandidate(plugin({ pluginId: 'bad@@id' }), [server()]);
    assert.equal(candidate.readiness, 'unconfigured');
    assert.equal(candidate.reason, 'invalid_identifier');
  });

  it('server 名对不上（声明 A、配置 B）→ server_not_configured', () => {
    const candidate = resolvePluginMentionCandidate(plugin(), [server({ serverName: 'other' })]);
    assert.equal(candidate.readiness, 'unconfigured');
    assert.equal(candidate.reason, 'server_not_configured');
  });
});

describe('buildPluginMentionCatalog', () => {
  it('按 stable id 排序，不随连接状态抖动', () => {
    const catalog = buildPluginMentionCatalog({
      installed: [plugin({ pluginId: 'zeta@official' }), plugin({ pluginId: 'alpha@official' })],
      servers: [],
    });
    assert.deepEqual(catalog.candidates.map((item) => item.stableId), ['alpha@official', 'zeta@official']);
  });

  it('没有任何插件时 empty 为 true', () => {
    assert.equal(buildPluginMentionCatalog({ installed: [], servers: [] }).empty, true);
  });

  it('装了插件就不 empty —— 未就绪也是信息，不是空列表', () => {
    const catalog = buildPluginMentionCatalog({ installed: [plugin()], servers: [] });
    assert.equal(catalog.empty, false);
    assert.equal(catalog.candidates[0].readiness, 'unconfigured');
  });
});

describe('pluginMentionMarkup', () => {
  it('身份只在 destination 里，label 只是显示名', () => {
    const candidate: PluginMentionCandidate = {
      stableId: 'filesystem@official',
      label: '任意显示名',
      marketplace: 'official',
      version: '1.0.0',
      readiness: 'available',
      liveServerNames: ['filesystem'],
      pendingServerNames: [],
    };
    const markup = pluginMentionMarkup(candidate);
    assert.equal(markup, '[任意显示名](plugin://filesystem@official)');
    // 解析侧契约：destination 必须是 `plugin://` + 合法 stable id。
    assert.match(markup, /\]\(plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*\)$/);
  });

  it('生成的标记能被 @awo/plugin-reference 解析回同一个 stable id', async () => {
    const { extractPluginReferences } = await import('@awo/plugin-reference');
    const candidate: PluginMentionCandidate = {
      stableId: 'filesystem@official',
      label: 'Filesystem',
      marketplace: 'official',
      version: '1.0.0',
      readiness: 'available',
      liveServerNames: ['filesystem'],
      pendingServerNames: [],
    };
    const extracted = extractPluginReferences(`帮我列目录 ${pluginMentionMarkup(candidate)}`);
    assert.deepEqual(extracted.references, ['filesystem@official']);
    assert.equal(extracted.invalidCount, 0);
  });
});
