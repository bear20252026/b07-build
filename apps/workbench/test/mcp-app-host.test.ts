// 一个文件=一种作用：MCP Apps 宿主侧纯函数的验收测试（官方 ext-apps 信封 + 握手链路）。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMcpAppBridgeError,
  buildMcpAppBridgeResponse,
  buildMcpAppInitializeResult,
  mapToolResultToCallToolResult,
  negotiateMcpAppProtocolVersion,
  parseMcpAppBridgeMessage,
  MCP_APP_BRIDGE_PROTOCOL_VERSION,
} from '@awo/protocol';

const admission = { admittedToolNames: ['read_note'] };

test('握手链路：ui/initialize → 版本协商 → 应答信封（缺省宿主身份补齐）', () => {
  const incoming = parseMcpAppBridgeMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: { appInfo: { name: 'notes-app', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '1999-01-01' },
    },
    admission,
  );
  assert.equal(incoming.ok, true);
  if (!incoming.ok || incoming.kind !== 'initialize') return;
  const protocolVersion = negotiateMcpAppProtocolVersion(incoming.protocolVersion);
  assert.equal(protocolVersion, MCP_APP_BRIDGE_PROTOCOL_VERSION, '未知版本回落到 LATEST');
  const response = buildMcpAppBridgeResponse(
    incoming.id,
    buildMcpAppInitializeResult({ hostInfo: { name: 'AI Work OS', version: '0.19.0' } }, protocolVersion),
  );
  assert.deepEqual(response, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: MCP_APP_BRIDGE_PROTOCOL_VERSION,
      hostInfo: { name: 'AI Work OS', version: '0.19.0' },
      hostCapabilities: { serverTools: {} },
      hostContext: { platform: 'desktop' },
    },
  });
});

test('工具链路：tools/call 白名单内 → 执行 → CallToolResult 应答', () => {
  const incoming = parseMcpAppBridgeMessage(
    { jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'read_note', arguments: { id: 7 } } },
    admission,
  );
  assert.equal(incoming.ok, true);
  if (!incoming.ok || incoming.kind !== 'toolCall') return;
  // 宿主执行器的结果（此处覆盖 MCP 原生 CallToolResult 与裸值两条路径）。
  assert.deepEqual(buildMcpAppBridgeResponse(incoming.id, mapToolResultToCallToolResult({ content: [{ type: 'text', text: '笔记' }] })), {
    jsonrpc: '2.0',
    id: 'call-1',
    result: { content: [{ type: 'text', text: '笔记' }] },
  });
  assert.deepEqual(mapToolResultToCallToolResult('raw'), { content: [{ type: 'text', text: 'raw' }] });
});

test('伪造调用在桥上被拦下，宿主回 invalidParams 而不执行', () => {
  const forged = parseMcpAppBridgeMessage(
    { jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: { name: 'write_note' } },
    admission,
  );
  assert.equal(forged.ok, false);
  if (forged.ok) return;
  const error = buildMcpAppBridgeError(forged.id ?? 'call-2', forged.code ?? -32602, forged.reason);
  assert.deepEqual(error, { jsonrpc: '2.0', id: 'call-2', error: { code: -32602, message: 'mcpapp-tool-not-admitted' } });
});

test('未知方法回 method-not-found（真实 SDK 应用依靠 error 应答感知失败）', () => {
  const incoming = parseMcpAppBridgeMessage({ jsonrpc: '2.0', id: 5, method: 'ui/teleport' }, admission);
  assert.equal(incoming.ok, false);
  if (incoming.ok) return;
  assert.equal(incoming.code, -32601);
  assert.equal(incoming.id, 5);
});
