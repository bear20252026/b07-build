// 一个文件=一种作用：MCP Apps 准入与隔离策略的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMcpAppSandbox,
  injectContentSecurityPolicy,
  validateMcpAppManifest,
  type McpAppResourceManifest,
} from '../src/mcp-app-admission';
import type { McpAppHostingServer } from '../src/mcp-app-admission';

const server = {
  id: 'demo-mcp',
  declaredTools: [{ name: 'read_note' }, { name: 'write_note' }],
} satisfies McpAppHostingServer;

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
  // frame-ancestors 在 meta CSP 中被浏览器忽略，生成器刻意不产出（由 sandbox 属性承担隔离）。
  assert.equal(policy.contentSecurityPolicy.includes('frame-ancestors'), false);
});

test('沙箱：声明了 apiOrigins 才进 connect-src，且只接受 https 源', () => {
  const policy = buildMcpAppSandbox(manifest({ apiOrigins: ['https://api.example.com'] }));
  assert.match(policy.contentSecurityPolicy, /connect-src https:\/\/api\.example\.com/);
});

test('CSP 注入：head 前移注入、无 head 时补建、引号转义、不含 frame-ancestors', () => {
  const policy = buildMcpAppSandbox(manifest());
  // frame-ancestors 只在 HTTP 响应头生效，meta 中会被忽略——生成器必须不产出它。
  assert.equal(policy.contentSecurityPolicy.includes('frame-ancestors'), false);

  const withHead = injectContentSecurityPolicy('<html><head><title>t</title></head><body></body></html>', policy.contentSecurityPolicy);
  assert.match(withHead, /<head><meta http-equiv="Content-Security-Policy"/);
  assert.match(withHead, /<title>t<\/title><\/head>/);

  const withoutHead = injectContentSecurityPolicy('<html><body>x</body></html>', policy.contentSecurityPolicy);
  assert.match(withoutHead, /<html><head><meta http-equiv="Content-Security-Policy"/);

  const plain = injectContentSecurityPolicy('<div>x</div>', policy.contentSecurityPolicy);
  assert.match(plain, /^<meta http-equiv="Content-Security-Policy"/);
});

test('CSP 注入：注释里的假 <head> 不会骗过定位', () => {
  const policy = buildMcpAppSandbox(manifest());
  const tricky = '<html><!-- <head> 假头 </head> --><head><title>real</title></head><body></body></html>';
  const injected = injectContentSecurityPolicy(tricky, policy.contentSecurityPolicy);
  // CSP 必须落在**真实** head 里（注释内的匹配被跳过）。
  assert.match(injected, /<head><meta http-equiv="Content-Security-Policy"/);
  assert.equal(injected.indexOf('Content-Security-Policy') < injected.indexOf('<!--'), false);
});
