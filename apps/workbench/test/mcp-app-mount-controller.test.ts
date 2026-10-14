// 一个文件=一种作用：MCP Apps 挂载控制器的验收测试（准入、网关接线、审计、换代/卸载）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { McpAppMountController, createUnavailableMcpAppToolExecutor, defaultMcpAppRisk } from '../src/runtime/zcode/mcp-app-mount-controller';

const server = { id: 'demo', declaredTools: [{ name: 'read_note' }, { name: 'write_note' }] };

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'mcpapp-demo-notes',
    serverId: 'demo',
    displayName: '笔记',
    htmlResourceUri: 'ui://demo/notes',
    requestedToolNames: ['read_note'],
    ...overrides,
  };
}

test('准入失败：坏 manifest 不挂载，控制器保持空态', () => {
  const controller = new McpAppMountController();
  const result = controller.mount({ server, manifest: { ...manifest(), schemaVersion: 2 } });
  assert.equal(result.ok, false);
  assert.equal(controller.mounted, false);
  assert.equal(controller.admission, undefined);
  assert.equal(controller.appInstanceId, undefined);
});

test('准入失败保留旧挂载：坏 manifest 不能把好挂载踢掉', () => {
  const controller = new McpAppMountController();
  assert.equal(controller.mount({ server, manifest: manifest() }).ok, true);
  const firstInstance = controller.appInstanceId;
  assert.equal(controller.mount({ server, manifest: manifest({ id: 'mcpapp-other' }) }).ok, true);
  assert.notEqual(controller.appInstanceId, firstInstance, '重挂换代实例标识');
  assert.equal(controller.mount({ server, manifest: manifest({ id: 'x' }) }).ok, false, '坏 manifest 被拒');
  assert.equal(controller.mounted, true, '旧挂载仍在');
  assert.equal(controller.admission?.manifest.id, 'mcpapp-other');
});

test('准入成功：白名单取 declaredTools ∩ requestedToolNames', () => {
  const controller = new McpAppMountController();
  const result = controller.mount({ server, manifest: manifest({ requestedToolNames: ['read_note', 'ghost_tool'] }) });
  assert.equal(result.ok, false, '未注册的工具引用整单拒绝');
  const ok = controller.mount({ server, manifest: manifest({ requestedToolNames: ['read_note', 'write_note'] }) });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.admission.admittedToolNames, ['read_note', 'write_note']);
});

test('未挂载时调用工具：明确拒绝而不是未定义错误', async () => {
  const controller = new McpAppMountController();
  const result = await controller.callTool('read_note', {});
  assert.deepEqual(result, { ok: false, reason: 'mcpapp-tool-error', message: 'mcpapp-not-mounted' });
});

test('白名单外工具：网关按纵深防御拒绝并留审计', async () => {
  const controller = new McpAppMountController();
  controller.mount({ server, manifest: manifest(), executor: { execute: async () => 'should-not-run' } });
  const result = await controller.callTool('write_note', { text: 'x' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'mcpapp-tool-not-admitted');
  const last = controller.audit.at(-1);
  assert.equal(last?.outcome, 'rejected');
  assert.equal(last?.detail, 'mcpapp-tool-not-admitted');
});

test('medium/high 未提供裁决入口：fail-closed 拒绝', async () => {
  const controller = new McpAppMountController();
  controller.mount({ server, manifest: manifest(), executor: { execute: async () => 'v' } });
  const result = await controller.callTool('read_note', {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'mcpapp-approval-required', '缺省全部按 high，无人即拒');
});

test('人工裁决：拒绝 → 不执行；允许 → 执行并把结果交给调用方', async () => {
  const controller = new McpAppMountController();
  const seen: unknown[] = [];
  controller.mount({
    server,
    manifest: manifest(),
    executor: { execute: async (toolName, args) => { seen.push([toolName, args]); return `ran:${toolName}`; } },
    approve: async () => false,
  });
  const denied = await controller.callTool('read_note', { id: 1 });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.reason, 'mcpapp-approval-denied');
  assert.deepEqual(seen, [], '拒绝后不触达执行器');

  const approving = new McpAppMountController();
  approving.mount({
    server,
    manifest: manifest(),
    executor: { execute: async (toolName, args) => { seen.push([toolName, args]); return `ran:${toolName}`; } },
    approve: async () => true,
  });
  const allowed = await approving.callTool('read_note', { id: 2 });
  assert.deepEqual(allowed, { ok: true, result: 'ran:read_note' });
  assert.deepEqual(seen, [['read_note', { id: 2 }]]);
  assert.equal(approving.audit.at(-1)?.outcome, 'executed');
});

test('执行器抛错：结果按 mcpapp-tool-error + 摘要返回', async () => {
  const controller = new McpAppMountController();
  controller.mount({
    server,
    manifest: manifest(),
    riskTable: { read_note: 'low' },
    executor: { execute: async () => { throw new Error('mcp server exploded'); } },
  });
  const result = await controller.callTool('read_note', {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'mcpapp-tool-error');
  assert.equal(result.message, 'mcp server exploded');
});

test('缺省执行器 fail-closed：未注入真实连接时调用以 unavailable 失败', async () => {
  const controller = new McpAppMountController();
  controller.mount({ server, manifest: manifest(), approve: async () => true });
  const result = await controller.callTool('read_note', {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.message, 'mcpapp-executor-unavailable');
});

test('缺省风险分级：未登记工具一律 high', () => {
  assert.equal(defaultMcpAppRisk('anything'), 'high');
  assert.equal(defaultMcpAppRisk('read_note', { read_note: 'low' }), 'low');
});

test('缺省执行器工厂：自身以传入原因拒绝', async () => {
  const executor = createUnavailableMcpAppToolExecutor('boom');
  await assert.rejects(() => executor.execute('read_note', {}), /boom/);
});

test('卸载：网关与准入态释放，调用回到未挂载语义', async () => {
  const controller = new McpAppMountController();
  controller.mount({ server, manifest: manifest() });
  controller.unmount();
  assert.equal(controller.mounted, false);
  assert.equal(controller.audit.length, 0, '审计轨迹随网关释放');
  const result = await controller.callTool('read_note', {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.message, 'mcpapp-not-mounted');
});
