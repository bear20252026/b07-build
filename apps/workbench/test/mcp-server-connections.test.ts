import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpServerConfigEntry } from '../src/runtime/mcp-server-config';
import { createMcpServerRegistry } from '../src/runtime/mcp-server-connections';
import { McpLoopbackTransport, type McpWireTransport } from '../src/runtime/zcode/mcp-client-transport';

// ---------------------------------------------------------------------------
// 「用户登记的配置 → 连接注册表」这条接缝。
//
// 核心语义：**未配置 = 未连接**，不是"可执行但没连"。这条决定了界面能不能诚实地说
// "这个插件声明的 server 你没配"。
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  id?: string | number;
  method: string;
}

/** 会说 MCP 的假服务器。 */
function attachServer(peer: McpWireTransport, tools: readonly string[]): void {
  peer.subscribe({
    onLine: (line) => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        return;
      }
      if (request.id === undefined) return;
      const reply = (payload: unknown): Promise<void> => peer.send(JSON.stringify(payload));
      if (request.method === 'initialize') {
        void reply({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
        return;
      }
      if (request.method === 'tools/list') {
        void reply({ jsonrpc: '2.0', id: request.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })) } });
      }
    },
  });
}

function config(overrides: Partial<McpServerConfigEntry> = {}): McpServerConfigEntry {
  return { id: 'demo', command: 'node', args: [], env: [], enabled: true, ...overrides };
}

/** 传输工厂：每次建一对 loopback，并在对端挂一个假服务器。 */
function transportFactory(tools: readonly string[], seen: string[]): (entry: McpServerConfigEntry) => McpWireTransport {
  return (entry) => {
    seen.push(entry.id);
    const [clientEnd, serverEnd] = McpLoopbackTransport.pair();
    attachServer(serverEnd, tools);
    return clientEnd;
  };
}

test('已配置且启用：连上并报出工具数', async () => {
  const seen: string[] = [];
  const registry = createMcpServerRegistry([config()], { createTransport: transportFactory(['greet', 'wave'], seen) });
  const snapshot = await registry.connect('demo');
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.toolNames.length, 2);
  assert.equal(registry.liveMcpServers().get('demo')?.providerVisibleToolCount, 2);
  assert.deepEqual(seen, ['demo']);
  await registry.closeAll();
});

test('未配置：failed + no-session-spec，且不建传输', async () => {
  // 不能编一个默认命令去跑 —— 那是"插件决定执行什么"的翻版。
  const seen: string[] = [];
  const registry = createMcpServerRegistry([], { createTransport: transportFactory(['greet'], seen) });
  const snapshot = await registry.connect('demo');
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.error, 'no-session-spec');
  assert.deepEqual(seen, [], '不得创建任何传输');
});

test('已停用：按未配置处理', async () => {
  const seen: string[] = [];
  const registry = createMcpServerRegistry([config({ enabled: false })], { createTransport: transportFactory(['greet'], seen) });
  const snapshot = await registry.connect('demo');
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.error, 'no-session-spec');
  assert.deepEqual(seen, []);
});

test('多个 server 各自独立：一个坏不影响另一个', async () => {
  const registry = createMcpServerRegistry(
    [config({ id: 'good' }), config({ id: 'bad' })],
    {
      createTransport: (entry) => {
        const [clientEnd, serverEnd] = McpLoopbackTransport.pair();
        // bad 的对端不应答，握手必然超时。
        if (entry.id === 'good') attachServer(serverEnd, ['greet']);
        return clientEnd;
      },
      requestTimeoutMs: 60,
    },
  );
  const good = await registry.connect('good');
  const bad = await registry.connect('bad');
  assert.equal(good.state, 'ready');
  assert.equal(bad.state, 'failed');
  const live = registry.liveMcpServers();
  assert.deepEqual([...live.keys()], ['good'], '坏的不得进 live 集合');
  await registry.closeAll();
});

test('配置里的 command/args/env 原样传给传输工厂', async () => {
  let captured: McpServerConfigEntry | undefined;
  const registry = createMcpServerRegistry(
    [config({ command: 'node', args: ['server.js'], env: [['TOKEN', 'x']], workingDirectory: 'C:/tmp' })],
    { createTransport: (entry) => { captured = entry; const [clientEnd, serverEnd] = McpLoopbackTransport.pair(); attachServer(serverEnd, []); return clientEnd; } },
  );
  await registry.connect('demo');
  assert.equal(captured?.command, 'node');
  assert.deepEqual(captured?.args, ['server.js']);
  assert.deepEqual(captured?.env, [['TOKEN', 'x']]);
  assert.equal(captured?.workingDirectory, 'C:/tmp');
  await registry.closeAll();
});
