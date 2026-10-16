// 一个文件=一种作用：工具声明契约与注册表的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, ToolContractError, mcpToolName, parseMcpToolName, isToolReadOnlyWith, type ToolDescriptor } from '../src/tool-contract';

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

// ─────────────── 逐入参只读判定（isReadOnly） ───────────────

test('未提供 isReadOnly 时退化为静态 readOnly 字段', () => {
  // 既有描述符无需改动：静态声明仍然生效。
  assert.equal(isToolReadOnlyWith({ readOnly: true }, {}), true);
  assert.equal(isToolReadOnlyWith({ readOnly: false }, {}), false);
});

test('提供 isReadOnly 时按入参判定，静态字段不再参与', () => {
  const shell: Pick<ToolDescriptor, 'readOnly' | 'isReadOnly'> = {
    // 静态声明当作写入，但实际要按命令判定——这正是静态布尔表达不了的。
    readOnly: false,
    isReadOnly: (input) => String(input.command).startsWith('ls'),
  };

  assert.equal(isToolReadOnlyWith(shell, { command: 'ls -la' }), true);
  assert.equal(isToolReadOnlyWith(shell, { command: 'rm -rf /' }), false);
});

test('真正的逐命令只读判定：ls 只读、rm 写入', () => {
  // 对应基线 1 原文「逐命令 / 逐标志只读判定」。
  const READ_ONLY_COMMANDS = new Set(['ls', 'cat', 'git status', 'git diff']);
  const shell: Pick<ToolDescriptor, 'readOnly' | 'isReadOnly'> = {
    readOnly: false,
    isReadOnly: (input) => READ_ONLY_COMMANDS.has(String(input.command).trim()),
  };

  assert.equal(isToolReadOnlyWith(shell, { command: 'ls' }), true);
  assert.equal(isToolReadOnlyWith(shell, { command: 'git status' }), true);
  assert.equal(isToolReadOnlyWith(shell, { command: 'rm -rf /' }), false);
  assert.equal(isToolReadOnlyWith(shell, { command: 'git push' }), false);
});

test('isReadOnly 返回非布尔真值时不算只读（严格等于 true）', () => {
  const loose = { readOnly: false, isReadOnly: () => 'true' as unknown as boolean };
  assert.equal(isToolReadOnlyWith(loose, {}), false);

  const undefinedish = { readOnly: false, isReadOnly: () => undefined as unknown as boolean };
  assert.equal(isToolReadOnlyWith(undefinedish, {}), false);
});

test('isReadOnly 抛异常时视为写入，不向上传播', () => {
  // 策略层故障绝不能被当作"只读放行"——宁可多要一次审批。
  const broken = {
    readOnly: true,
    isReadOnly: () => {
      throw new Error('策略表加载失败');
    },
  };
  assert.equal(isToolReadOnlyWith(broken, {}), false);
});

test('描述符缺失时视为写入（fail-closed）', () => {
  assert.equal(isToolReadOnlyWith(undefined, {}), false);
});

test('isReadOnly 收到的是调用点给的入参本身', () => {
  let seen: Readonly<Record<string, unknown>> | undefined;
  const spy = {
    readOnly: false,
    isReadOnly: (input: Readonly<Record<string, unknown>>) => {
      seen = input;
      return true;
    },
  };
  const input = { command: 'ls', cwd: '/tmp' };
  assert.equal(isToolReadOnlyWith(spy, input), true);
  assert.equal(seen, input, '应原样传入，不复制也不改写');
});

test('判定是纯函数：同样入参重复调用得到同样结果', () => {
  const shell: Pick<ToolDescriptor, 'readOnly' | 'isReadOnly'> = {
    readOnly: false,
    isReadOnly: (input) => String(input.command) === 'ls',
  };
  const input = { command: 'ls' };
  const first = isToolReadOnlyWith(shell, input);
  const second = isToolReadOnlyWith(shell, input);
  assert.equal(first, second);
  assert.equal(first, true);
});
