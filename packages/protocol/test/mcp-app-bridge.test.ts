// 一个文件=一种作用：MCP Apps 官方 postMessage 桥（ext-apps JSON-RPC）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMcpAppBridgeError,
  buildMcpAppBridgeNotification,
  buildMcpAppBridgeResponse,
  buildMcpAppInitializeResult,
  mapToolResultToCallToolResult,
  negotiateMcpAppProtocolVersion,
  parseMcpAppBridgeMessage,
  MCP_APP_BRIDGE_ERROR_CODES,
  MCP_APP_BRIDGE_PROTOCOL_VERSION,
} from '../src/mcp-app-bridge';

const admission = { admittedToolNames: ['read_note'] };

function initialize(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'ui/initialize',
    params: {
      appInfo: { name: 'notes-app', version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: MCP_APP_BRIDGE_PROTOCOL_VERSION,
      ...overrides,
    },
  };
}

function toolCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'call-1',
    method: 'tools/call',
    params: { name: 'read_note', arguments: { id: 7 }, ...overrides },
  };
}

test('握手：ui/initialize 解析出应用身份、能力与协议版本', () => {
  const incoming = parseMcpAppBridgeMessage(initialize(), admission);
  assert.equal(incoming.ok, true);
  if (!incoming.ok || incoming.kind !== 'initialize') return;
  assert.equal(incoming.id, 1);
  assert.deepEqual(incoming.appInfo, { name: 'notes-app', version: '1.0.0' });
  assert.equal(incoming.protocolVersion, MCP_APP_BRIDGE_PROTOCOL_VERSION);
});

test('握手：封闭 params——未知键、坏 appInfo、缺字段一律 invalidParams', () => {
  const cases: unknown[] = [
    initialize({ extra: 1 }),
    initialize({ appInfo: { name: 'x' } }),
    initialize({ appInfo: 'nope' }),
    initialize({ protocolVersion: '' }),
    initialize({ appCapabilities: [] }),
  ];
  for (const raw of cases) {
    const incoming = parseMcpAppBridgeMessage(raw, admission);
    assert.equal(incoming.ok, false);
    if (incoming.ok) return;
    assert.equal(incoming.reason, 'mcpapp-bridge-params-invalid');
    assert.equal(incoming.code, MCP_APP_BRIDGE_ERROR_CODES.invalidParams);
    assert.equal(incoming.id, 1, '拒绝时保留可提取的请求 id，宿主可回 error');
  }
});

test('通知：initialized 与 size-changed 无需 id；带 id 的通知判 invalidRequest', () => {
  assert.deepEqual(parseMcpAppBridgeMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, admission), { ok: true, kind: 'initialized' });
  const sized = parseMcpAppBridgeMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 320, height: 200 } }, admission);
  assert.deepEqual(sized, { ok: true, kind: 'sizeChanged', width: 320, height: 200 });
  const withId = parseMcpAppBridgeMessage({ jsonrpc: '2.0', id: 9, method: 'ui/notifications/initialized' }, admission);
  assert.equal(withId.ok, false);
  if (!withId.ok) assert.equal(withId.code, MCP_APP_BRIDGE_ERROR_CODES.invalidRequest);
});

test('ping：应答 {}；params 脏数据被拒', () => {
  const incoming = parseMcpAppBridgeMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, admission);
  assert.deepEqual(incoming, { ok: true, kind: 'ping', id: 2 });
  const dirty = parseMcpAppBridgeMessage({ jsonrpc: '2.0', id: 2, method: 'ping', params: { junk: true } }, admission);
  assert.equal(dirty.ok, false);
});

test('tools/call：白名单内工具带参数通过；未准入工具 invalidParams 且保留 id', () => {
  const ok = parseMcpAppBridgeMessage(toolCall(), admission);
  assert.equal(ok.ok, true);
  if (ok.ok && ok.kind === 'toolCall') {
    assert.equal(ok.id, 'call-1');
    assert.equal(ok.toolName, 'read_note');
    assert.deepEqual(ok.args, { id: 7 });
  }
  const forged = parseMcpAppBridgeMessage(toolCall({ name: 'write_note' }), admission);
  assert.equal(forged.ok, false);
  if (!forged.ok) {
    assert.equal(forged.reason, 'mcpapp-tool-not-admitted');
    assert.equal(forged.code, MCP_APP_BRIDGE_ERROR_CODES.invalidParams);
    assert.equal(forged.id, 'call-1');
  }
  for (const bad of [toolCall({ arguments: [1] }), toolCall({ arguments: 'x' }), toolCall({ name: '' }), toolCall({ _meta: 1 })]) {
    assert.equal(parseMcpAppBridgeMessage(bad, admission).ok, false);
  }
});

test('信封纪律：非 JSON-RPC、未知方法、缺 id、循环引用、超限全部拒绝', () => {
  const notJsonrpc = parseMcpAppBridgeMessage({ type: 'toolCallRequest' }, admission);
  assert.equal(notJsonrpc.ok, false);
  if (!notJsonrpc.ok) {
    assert.equal(notJsonrpc.reason, 'mcpapp-bridge-not-jsonrpc');
    assert.equal(notJsonrpc.code, undefined, '非 JSON-RPC 噪声无错误码：宿主静默忽略');
    assert.equal(notJsonrpc.id, undefined);
  }
  const unknown = parseMcpAppBridgeMessage({ jsonrpc: '2.0', id: 5, method: 'ui/teleport' }, admission);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.reason, 'mcpapp-bridge-method-forbidden');
    assert.equal(unknown.code, MCP_APP_BRIDGE_ERROR_CODES.methodNotFound);
    assert.equal(unknown.id, 5, '未知方法也要回 method-not-found');
  }
  const noId = parseMcpAppBridgeMessage({ jsonrpc: '2.0', method: 'ping' }, admission);
  assert.equal(noId.ok, false);
  if (!noId.ok) assert.equal(noId.code, MCP_APP_BRIDGE_ERROR_CODES.invalidRequest);
  const cyclic: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method: 'ping' };
  cyclic.self = cyclic;
  const unserializable = parseMcpAppBridgeMessage(cyclic, admission);
  assert.equal(unserializable.ok, false);
  if (!unserializable.ok) assert.equal(unserializable.reason, 'mcpapp-message-unserializable');
  const huge = toolCall({ arguments: { blob: 'x'.repeat(70_000) } });
  const tooLarge = parseMcpAppBridgeMessage(huge, admission);
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.reason, 'mcpapp-message-too-large');
});

test('版本协商：命中即沿用，未命中回落 LATEST', () => {
  assert.equal(negotiateMcpAppProtocolVersion(MCP_APP_BRIDGE_PROTOCOL_VERSION), MCP_APP_BRIDGE_PROTOCOL_VERSION);
  assert.equal(negotiateMcpAppProtocolVersion('1999-01-01'), MCP_APP_BRIDGE_PROTOCOL_VERSION);
});

test('构建器：initialize 结果补齐缺省 capabilities/context', () => {
  const minimal = buildMcpAppInitializeResult({ hostInfo: { name: 'H', version: '1' } }, '2026-01-26') as Record<string, unknown>;
  assert.deepEqual(minimal, {
    protocolVersion: '2026-01-26',
    hostInfo: { name: 'H', version: '1' },
    hostCapabilities: { serverTools: {} },
    hostContext: { platform: 'desktop' },
  });
  const full = buildMcpAppInitializeResult(
    { hostInfo: { name: 'H', version: '1' }, hostCapabilities: { serverTools: { listChanged: true } }, hostContext: { theme: 'dark', platform: 'desktop' } },
    '2026-01-26',
  ) as Record<string, unknown>;
  assert.deepEqual(full.hostContext, { theme: 'dark', platform: 'desktop' });
  assert.deepEqual(full.hostCapabilities, { serverTools: { listChanged: true } });
});

test('构建器：应答/错误/通知信封形状符合 JSON-RPC 2.0', () => {
  assert.deepEqual(buildMcpAppBridgeResponse('call-1', { content: [] }), { jsonrpc: '2.0', id: 'call-1', result: { content: [] } });
  assert.deepEqual(buildMcpAppBridgeResponse(7, {}), { jsonrpc: '2.0', id: 7, result: {} });
  assert.deepEqual(buildMcpAppBridgeError(3, -32601, 'mcpapp-bridge-method-forbidden'), { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'mcpapp-bridge-method-forbidden' } });
  assert.deepEqual(buildMcpAppBridgeError(3, -32603, 'boom', { reason: 'x' }), { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'boom', data: { reason: 'x' } } });
  assert.deepEqual(buildMcpAppBridgeNotification('ui/notifications/host-context-changed', { theme: 'dark' }), { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } });
  assert.deepEqual(buildMcpAppBridgeNotification('ui/notifications/tool-cancelled'), { jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled' });
});

test('结果映射：CallToolResult 原样通过；其余值包 text 内容块；错误不冒充协议错误', () => {
  assert.deepEqual(mapToolResultToCallToolResult({ content: [{ type: 'text', text: 'hi' }] }), { content: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(mapToolResultToCallToolResult({ content: [], isError: true }), { content: [], isError: true });
  assert.deepEqual(mapToolResultToCallToolResult('done'), { content: [{ type: 'text', text: 'done' }] });
  assert.deepEqual(mapToolResultToCallToolResult({ temperature: 21 }), { content: [{ type: 'text', text: '{"temperature":21}' }] });
  assert.deepEqual(mapToolResultToCallToolResult(undefined), { content: [{ type: 'text', text: 'undefined' }] });
});
