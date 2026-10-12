// 一个文件=一种作用：MCP Apps 准入与隔离策略的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMcpAppSandbox,
  gateMcpAppMessage,
  validateMcpAppManifest,
  type McpAppResourceManifest,
} from '../src/mcp-app-admission';
import type { McpServerManifest } from '../src/mcp-registry';

const server = {
  id: 'demo-mcp',
  declaredTools: [
    { name: 'read_note', description: '读笔记', capability: 'knowledge.read' as const, risk: 'low' as const },
    { name: 'write_note', description: '写笔记', capability: 'knowledge.write' as const, risk: 'medium' as const },
  ],
} as unknown as Pick<McpServerManifest, 'id' | 'declaredTools'>;

function manifest(overrides: Partial<McpAppResourceManifest> = {}): McpAppResourceManifest {
  return {
    schemaVersion: 1,
    id: 'mcpapp-demo-mcp.notes-ui',
    serverId: 'demo-mcp',
    displayName: '笔记面板',
    htmlResourceUri: 'ui://demo-mcp/notes-app',
    requestedToolNames: ['read_note'],
    ...overrides,
  };
}

test('准入：声明合法且工具已注册时通过，白名单 = 请求 ∩ 注册', () => {
  const result = validateMcpAppManifest(manifest({ requestedToolNames: ['read_note', 'write_note'] }), server);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.admission.admittedToolNames, ['read_note', 'write_note']);
});

test('准入：跨服务器声明、未注册工具、坏 id、坏资源 URI 全部拒绝', () => {
  assert.equal(validateMcpAppManifest(manifest({ serverId: 'other-mcp' }), server).ok, false);
  assert.equal(validateMcpAppManifest(manifest({ requestedToolNames: ['read_note', 'exec_shell'] }), server).ok, false);
  assert.equal(validateMcpAppManifest(manifest({ id: 'not-a-mcpapp-id' }), server).ok, false);
  assert.equal(validateMcpAppManifest(manifest({ htmlResourceUri: 'https://evil.example/app.html' }), server).ok, false);
  assert.equal(validateMcpAppManifest(manifest({ apiOrigins: ['http://insecure.example'] }), server).ok, false);
  assert.equal(validateMcpAppManifest('not-an-object', server).ok, false);
});

test('沙箱：不给 allow-same-origin / top-navigation / popups，网络默认全禁', () => {
  const policy = buildMcpAppSandbox(manifest());
  assert.deepEqual([...policy.sandboxAttributes].sort(), ['allow-forms', 'allow-scripts']);
  assert.equal(policy.sandboxAttributes.includes('allow-same-origin'), false);
  assert.equal(policy.sandboxAttributes.includes('allow-top-navigation'), false);
  assert.equal(policy.sandboxAttributes.includes('allow-popups'), false);
  assert.match(policy.contentSecurityPolicy, /default-src 'none'/);
  assert.doesNotMatch(policy.contentSecurityPolicy, /connect-src/);
  assert.match(policy.contentSecurityPolicy, /frame-ancestors 'none'/);
});

test('沙箱：声明了 apiOrigins 才进 connect-src，且只接受 https 源', () => {
  const policy = buildMcpAppSandbox(manifest({ apiOrigins: ['https://api.example.com'] }));
  assert.match(policy.contentSecurityPolicy, /connect-src https:\/\/api\.example\.com/);
});

test('消息门：白名单类型 + 大小限制 + 工具调用二次校验', () => {
  const admission = { admittedToolNames: ['read_note'] };
  assert.deepEqual(gateMcpAppMessage({ type: 'ready', payload: null }, admission), { ok: true, type: 'ready', payload: null });
  assert.equal(gateMcpAppMessage({ type: 'eval', payload: '2+2' }, admission).ok, false, '白名单外的类型直接拒绝');
  assert.equal(gateMcpAppMessage({ type: 'toolCallRequest', payload: { toolName: 'write_note' } }, admission).ok, false, '未准入的工具调用被拦下');
  assert.equal(gateMcpAppMessage({ type: 'toolCallRequest', payload: { toolName: 'read_note', arguments: { id: 1 } } }, admission).ok, true);
  const huge = { type: 'ready', payload: 'x'.repeat(70_000) };
  assert.equal(gateMcpAppMessage(huge, admission).ok, false, '超过载荷上限的消息被拒绝');
});
