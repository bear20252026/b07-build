import assert from 'node:assert/strict';
import test from 'node:test';

import { loadInstalledPluginCatalog, toInstalledPluginCatalogEntry } from '../src/runtime/plugin-reference-catalog.js';

// ---------------------------------------------------------------------------
// 已安装插件目录：跨进程边界来的数据必须验形状。
// ---------------------------------------------------------------------------

const invokeCalls: string[] = [];
let invokePayload: unknown = [];
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string) => {
      invokeCalls.push(cmd);
      return invokePayload;
    },
  },
};

const VALID = {
  pluginId: 'hello@official',
  name: 'hello',
  marketplace: 'official',
  version: '1.2.0',
  appId: 'hello-app',
  mcpServerId: 'hello-server',
  requestedToolNames: ['greet', 'wave'],
};

test('合法条目原样通过', () => {
  assert.deepEqual(toInstalledPluginCatalogEntry(VALID), VALID);
});

test('未声明app的插件也能通过', () => {
  const entry = toInstalledPluginCatalogEntry({ ...VALID, appId: null, mcpServerId: null, requestedToolNames: [] });
  assert.equal(entry?.appId, null);
  assert.deepEqual(entry?.requestedToolNames, []);
});

test('形状不对的条目被丢弃', () => {
  for (const bad of [
    null,
    'x',
    {},
    { ...VALID, pluginId: '' },
    { ...VALID, name: '' },
    { ...VALID, version: 1 },
    { ...VALID, appId: 42 },
    { ...VALID, mcpServerId: 42 },
  ]) {
    assert.equal(toInstalledPluginCatalogEntry(bad), undefined, JSON.stringify(bad));
  }
});

test('工具名里的脏值被过滤但条目保留', () => {
  // 一个坏工具名不该让整个插件消失 —— 插件本身仍然是有用的信息。
  const entry = toInstalledPluginCatalogEntry({ ...VALID, requestedToolNames: ['a', 1, '', null, 'b'] });
  assert.deepEqual(entry?.requestedToolNames, ['a', 'b']);
});

test('工具名不是数组时按空处理', () => {
  const entry = toInstalledPluginCatalogEntry({ ...VALID, requestedToolNames: 'greet' });
  assert.deepEqual(entry?.requestedToolNames, []);
});

test('走plugin_reference_catalog命令', async () => {
  invokeCalls.length = 0;
  invokePayload = [VALID];
  const entries = await loadInstalledPluginCatalog();
  assert.deepEqual(invokeCalls, ['plugin_reference_catalog']);
  assert.equal(entries.length, 1);
});

test('原生返回不是数组时给空列表', async () => {
  invokePayload = { unexpected: true };
  assert.deepEqual(await loadInstalledPluginCatalog(), []);
});

test('混入的坏条目被过滤', async () => {
  invokePayload = [VALID, { pluginId: '' }, { ...VALID, pluginId: 'b@official' }];
  const entries = await loadInstalledPluginCatalog();
  assert.deepEqual(entries.map((entry) => entry.pluginId), ['hello@official', 'b@official']);
});
