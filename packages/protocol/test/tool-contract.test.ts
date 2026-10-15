// 一个文件=一种作用：工具声明契约与注册表的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, ToolContractError, mcpToolName, parseMcpToolName, type ToolDescriptor } from '../src/tool-contract';

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: 'read_note',
    capability: 'filesystem.read',
    defaultRisk: 'low',
    readOnly: true,
    destructive: false,
    sideEffectScope: 'workspace',
    resultBudgetChars: 32_000,
    timeoutMs: 10_000,
    concurrentSafe: true,
    ...overrides,
  };
}

test('注册与解析：canonical / alias 都能拿到同一份描述符', () => {
  const registry = new ToolRegistry();
  registry.register(descriptor(), ['notes.read', 'legacy_read']);
  assert.equal(registry.has('read_note'), true);
  assert.equal(registry.resolve('notes.read')?.name, 'read_note');
  assert.equal(registry.resolve('legacy_read')?.capability, 'filesystem.read');
  assert.equal(registry.resolve('ghost'), undefined);
  assert.throws(() => registry.require('ghost'), (error: unknown) => error instanceof ToolContractError && error.code === 'tool-not-registered');
});

test('重名与 alias 占用：注册即拒，绝不让调用路由到另一个工具', () => {
  const registry = new ToolRegistry();
  registry.register(descriptor({ name: 'read_note' }), ['alias_a']);
  assert.throws(() => registry.register(descriptor({ name: 'read_note' })), /已被注册/);
  assert.throws(() => registry.register(descriptor({ name: 'other' }), ['alias_a']), /alias 已被占用/);
});

test('MCP 工具命名：mcp__<server>__<tool>', () => {
  assert.equal(mcpToolName('demo', 'read_note'), 'mcp__demo__read_note');
  const registry = new ToolRegistry();
  registry.register(descriptor({ name: mcpToolName('demo', 'read_note') }));
  assert.equal(registry.resolve('mcp__demo__read_note')?.defaultRisk, 'low');
});

test('MCP 工具命名与反向解析：round-trip，畸形名拒绝', () => {
  assert.equal(mcpToolName('demo', 'read_note'), 'mcp__demo__read_note');
  assert.deepEqual(parseMcpToolName('mcp__demo__read_note'), { serverId: 'demo', toolName: 'read_note' });
  // server 段按第一个 __ 切分：工具名里的下划线不破坏 round-trip。
  assert.deepEqual(parseMcpToolName('mcp__demo__read_note_v2'), { serverId: 'demo', toolName: 'read_note_v2' });
  assert.equal(parseMcpToolName('read_note'), undefined, '非 MCP 形态不猜');
  assert.equal(parseMcpToolName('mcp__demo'), undefined);
  assert.equal(parseMcpToolName('mcp____x'), undefined, '空 server 段拒绝');
  assert.equal(parseMcpToolName('mcp__demo__'), undefined, '空 tool 段拒绝');
});

test('非法工具名被拒绝', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register(descriptor({ name: 'has space' })), /无效/);
});

test('注册表清单：只含 canonical，不含 alias 重复', () => {
  const registry = new ToolRegistry();
  registry.register(descriptor({ name: 'a' }), ['b']);
  registry.register(descriptor({ name: 'c' }));
  assert.deepEqual(registry.descriptors().map((item) => item.name), ['a', 'c']);
});
