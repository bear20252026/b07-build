import assert from 'node:assert/strict';
import test from 'node:test';

import type { InstalledPluginCatalogEntry } from '../src/runtime/plugin-reference-catalog';
import { buildPluginReferenceContext, pluginReminderBlock } from '../src/runtime/plugin-reference-context';
import type { McpServerStatus } from '../src/runtime/mcp-servers-store';

// ---------------------------------------------------------------------------
// 「插件声明 ∩ 用户配置 ∩ 已连接」——三者缺一就不该给模型任何能力提示。
// ---------------------------------------------------------------------------

function plugin(overrides: Partial<InstalledPluginCatalogEntry> = {}): InstalledPluginCatalogEntry {
  return {
    pluginId: 'hello@official',
    name: 'hello',
    marketplace: 'official',
    version: '1.0.0',
    appId: 'hello-app',
    mcpServerId: 'hello-server',
    requestedToolNames: ['greet'],
    ...overrides,
  };
}

function server(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return { serverName: 'hello-server', connected: true, providerVisibleToolCount: 2, ...overrides };
}

const REF = '[hello](plugin://hello@official)';

test('没有引用时不产生提示', () => {
  const context = buildPluginReferenceContext({ text: '普通消息', installed: [plugin()], servers: [server()] });
  assert.equal(context.reminderBody, null);
  assert.deepEqual(context.references, []);
});

test('声明 + 已配置已连接 → 产生提示', () => {
  const context = buildPluginReferenceContext({ text: `看看 ${REF}`, installed: [plugin()], servers: [server()] });
  assert.deepEqual(context.references, ['hello@official']);
  assert.ok(context.reminderBody, '应当有提示体');
  assert.match(context.reminderBody, /hello/);
  assert.equal(context.diagnostics.skipped.length, 0);
});

test('插件没声明 server → no_live_capabilities（装了但用不了）', () => {
  const context = buildPluginReferenceContext({
    text: REF,
    installed: [plugin({ mcpServerId: null })],
    servers: [server()],
  });
  assert.equal(context.reminderBody, null);
  assert.equal(context.diagnostics.skipped[0]?.reason, 'no_live_capabilities');
});

test('声明了但用户没配/没连 → no_live_capabilities', () => {
  // 这是"插件说它有，但用户没允许"的情形：必须什么都不提示。
  const context = buildPluginReferenceContext({
    text: REF,
    installed: [plugin()],
    servers: [server({ connected: false, providerVisibleToolCount: 0 })],
  });
  assert.equal(context.reminderBody, null);
  assert.equal(context.diagnostics.skipped[0]?.reason, 'no_live_capabilities');
});

test('连上了但没有任何可见工具 → 同样不提示', () => {
  // 列一个工具数为 0 的 server，模型会去调不存在的工具。
  const context = buildPluginReferenceContext({
    text: REF,
    installed: [plugin()],
    servers: [server({ providerVisibleToolCount: 0 })],
  });
  assert.equal(context.reminderBody, null);
  assert.equal(context.diagnostics.skipped[0]?.reason, 'no_live_capabilities');
});

test('引用不存在的插件 → unknown', () => {
  const context = buildPluginReferenceContext({ text: '[x](plugin://ghost@nowhere)', installed: [plugin()], servers: [server()] });
  assert.equal(context.reminderBody, null);
  assert.equal(context.diagnostics.skipped[0]?.reason, 'unknown');
});

test('身份只取 destination：label 写成可信名也没用', () => {
  // `[hello](plugin://evil@attacker)`：人眼看到 hello，机器必须只认 evil@attacker。
  const context = buildPluginReferenceContext({
    text: '[hello@official](plugin://evil@attacker)',
    installed: [plugin()],
    servers: [server()],
  });
  assert.deepEqual(context.references, ['evil@attacker'], '不得把 label 当成身份');
  assert.equal(context.reminderBody, null, '不存在的插件不该产生能力提示');
  assert.equal(context.diagnostics.skipped[0]?.reason, 'unknown');
});

test('大写协议前缀不被接受', () => {
  const context = buildPluginReferenceContext({ text: '[hello](Plugin://hello@official)', installed: [plugin()], servers: [server()] });
  assert.deepEqual(context.references, [], '只接受小写 plugin://');
});

test('pluginReminderBlock：null 给空串，有内容才包块', () => {
  assert.equal(pluginReminderBlock(null), '');
  const block = pluginReminderBlock('- hello');
  assert.match(block, /- hello/);
  assert.match(block, /不代表你已经调用过/, '必须写明"声明 ≠ 已调用"');
});
