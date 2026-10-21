import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/client';

import { McpLoopbackTransport } from '../src/runtime/zcode/mcp-client-transport.js';
import { McpWireSdkTransport } from '../src/runtime/zcode/mcp-sdk-transport.js';

// ---------------------------------------------------------------------------
// 官方 SDK + 本仓传输适配器的最小闭环。
//
// 这个测试存在的理由：在删掉 460 行手写协议层之前，必须先证明官方 SDK 能
// 在我们这条「按行收发」的传输上跑通握手与 tools/list。跑不通就不该删。
//
// 假服务器跑在 loopback 的另一端，只实现握手与列工具两条语义。
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

/** 另一端：一个只懂 initialize / tools/list 的最小 MCP 服务器。 */
function attachFakeServer(server: McpLoopbackTransport): { methods: string[] } {
  const methods: string[] = [];
  server.subscribe({
    onLine: (line) => {
      const request = JSON.parse(line) as JsonRpcRequest;
      methods.push(request.method);
      // 通知没有 id，不回。
      if (request.id === undefined) return;
      const reply = (result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
      if (request.method === 'initialize') {
        void server.send(reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-server', version: '1.0.0' },
        }));
        return;
      }
      if (request.method === 'tools/list') {
        void server.send(reply({
          tools: [
            { name: 'greet', description: '打招呼', inputSchema: { type: 'object', properties: {} } },
            { name: 'wave', description: '挥手', inputSchema: { type: 'object', properties: {} } },
          ],
        }));
        return;
      }
      void server.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } }));
    },
  });
  return { methods };
}

test('官方 SDK 能在本仓传输上完成握手并列出工具', async () => {
  const [clientSide, serverSide] = McpLoopbackTransport.pair();
  const server = attachFakeServer(serverSide);

  const client = new Client({ name: 'b07-workbench', version: '0.0.0' }, { capabilities: {} });
  const transport = new McpWireSdkTransport(clientSide);
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['greet', 'wave']);
  // 握手一定在列工具之前，且 notification(initialized) 也会经过传输。
  assert.equal(server.methods[0], 'initialize');
  assert.ok(server.methods.includes('tools/list'));

  await client.close();
});

test('入站坏帧转成 onerror，而不是静默丢弃', async () => {
  // 静默丢弃会让 SDK 表现为"请求超时"，排查方向完全错。
  const [clientSide, serverSide] = McpLoopbackTransport.pair();
  const transport = new McpWireSdkTransport(clientSide);
  const errors: string[] = [];
  transport.onerror = (error) => errors.push(error.message);
  await transport.start();

  await serverSide.send('这不是 JSON');
  await serverSide.send('null');

  assert.equal(errors.length, 2);
  assert.match(errors[0], /不是合法 JSON/);
  assert.match(errors[1], /不是对象/);
});

test('关闭后解绑，不再转发入站帧', async () => {
  const [clientSide, serverSide] = McpLoopbackTransport.pair();
  const transport = new McpWireSdkTransport(clientSide);
  const received: unknown[] = [];
  transport.onmessage = (message) => received.push(message);
  await transport.start();
  await serverSide.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
  assert.equal(received.length, 1);

  await transport.close();
  // loopback 是成对的：一端 close 会连带关闭对端，所以对端再发会抛。
  // 这里要验证的是"适配器不再转发"，所以吞掉这个异常。
  await serverSide.send(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} })).catch(() => undefined);
  assert.equal(received.length, 1, '关闭后不得再收到帧');
});
