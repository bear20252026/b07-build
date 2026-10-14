// 一个文件=一种作用：MCP App 工具授权网关的验收测试（R1 审计 R4-04）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { McpAppToolGateway } from '../src/runtime/zcode/mcp-app-tool-gateway';

function gateway(overrides: Partial<ConstructorParameters<typeof McpAppToolGateway>[0]> = {}): McpAppToolGateway {
  return new McpAppToolGateway({
    admittedToolNames: ['read_note', 'write_note'],
    appInstanceId: 'mcpapp-demo.notes-ui',
    riskFor: (toolName) => (toolName.startsWith('write') ? 'high' : 'low'),
    execute: async () => ({ content: 'ok' }),
    ...overrides,
  });
}

test('准入复查：白名单外的工具在网关再被拦一道', async () => {
  const record = gateway();
  const result = await record.call('call-1', 'exec_shell', {});
  assert.deepEqual(result, { ok: false, reason: 'mcpapp-tool-not-admitted' });
  assert.match(record.audit[0]!.detail ?? '', /not-admitted/);
});

test('low 风险免审批直接执行并留下审计', async () => {
  const record = gateway();
  const result = await record.call('call-1', 'read_note', { id: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(record.audit[0], { at: record.audit[0]!.at, appInstanceId: 'mcpapp-demo.notes-ui', toolName: 'read_note', outcome: 'executed' });
});

test('高风险必须人工裁决：无裁决入口 fail-closed，拒绝也留审计', async () => {
  const withoutApprover = gateway();
  const denied = await withoutApprover.call('call-1', 'write_note', { path: 'x' });
  assert.deepEqual(denied, { ok: false, reason: 'mcpapp-approval-required' });

  let asked: unknown;
  const withApprover = gateway({
    approve: async (request) => {
      asked = request;
      return false;
    },
  });
  const rejected = await withApprover.call('call-1', 'write_note', { path: 'x' });
  assert.deepEqual(rejected, { ok: false, reason: 'mcpapp-approval-denied' });
  const request = asked as { toolName: string; risk: string; inputPreview: string };
  assert.equal(request.toolName, 'write_note');
  assert.equal(request.risk, 'high');
  assert.match(request.inputPreview, /path/);
  assert.match(withApprover.audit[0]!.detail ?? '', /approval-denied/);
});

test('未知风险的工具按 high 处理（fail-closed）', async () => {
  const record = gateway({ admittedToolNames: ['mystery_tool'], riskFor: () => 'unknown' as never });
  const result = await record.call('call-1', 'mystery_tool', {});
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : '', 'mcpapp-approval-required');
});

test('并发上限：超出即拒绝，不排队堆积', async () => {
  let release: (() => void) | undefined;
  const record = gateway({
    maxConcurrent: 1,
    execute: () => new Promise((resolve) => { release = () => resolve('done'); }),
  });
  const first = record.call('call-1', 'read_note', {});
  const second = await record.call('call-2', 'read_note', {});
  assert.deepEqual(second, { ok: false, reason: 'mcpapp-concurrency-limit' });
  release?.();
  assert.equal((await first).ok, true);
});

test('超时：底层调用不取消但结果丢弃，返回 timeout', async () => {
  const record = gateway({ timeoutMs: 20, execute: () => new Promise(() => undefined) });
  const result = await record.call('call-1', 'read_note', {});
  assert.deepEqual(result, { ok: false, reason: 'mcpapp-tool-timeout' });
  assert.equal(record.audit[0]!.outcome, 'timeout');
});

test('执行器抛错：错误透传为 mcpapp-tool-error 并记录摘要', async () => {
  const record = gateway({ execute: async () => { throw new Error('服务器 500'); } });
  const result = await record.call('call-1', 'read_note', {});
  assert.deepEqual(result, { ok: false, reason: 'mcpapp-tool-error', message: '服务器 500' });
  assert.match(record.audit[0]!.detail ?? '', /服务器 500/);
});

test('审计轨迹有界（256 条）', async () => {
  const record = gateway();
  for (let index = 0; index < 300; index += 1) {
    await record.call(`call-${index}`, 'read_note', {});
  }
  assert.equal(record.audit.length, 256);
});
