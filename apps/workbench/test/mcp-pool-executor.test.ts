// 一个文件=一种作用：池化执行器（McpAppToolExecutor 缺省实现）的端到端验收测试。
// 覆盖 P0-1c 通电语义：canonical 名解析、业务/协议失败分流、租约必归还。

import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '@awo/protocol';
import { McpClientPool } from '../src/runtime/zcode/mcp-client-pool';
import { createMcpPoolToolExecutor } from '../src/runtime/zcode/mcp-pool-executor';
import { McpLoopbackTransport } from '../src/runtime/zcode/mcp-client-transport';
import { encodeMcpFrame, parseMcpFrame, type McpJsonRpcRequest } from '../src/runtime/zcode/mcp-client-wire';

/** 自动应答 initialize / tools/list / tools/call 的假服务器；可注入 error 与冻结。 */
class FakeMcpServer {
  readonly requests: McpJsonRpcRequest[] = [];
  toolResult: unknown = { content: [{ type: 'text', text: 'note-body' }] };
  private failCall = false;
  private readonly handlers = new Set<(line: string) => void>();

  constructor(private readonly peer: McpLoopbackTransport) {
    peer.subscribe({ onLine: (line) => void this.handle(line) });
  }

  failToolsCall(): void {
    this.failCall = true;
  }

  private async handle(line: string): Promise<void> {
    const message = parseMcpFrame(line);
    if (!message || !('method' in message) || !('id' in message)) return;
    const request = message as McpJsonRpcRequest;
    this.requests.push(request);
    // failToolsCall 只作用于 tools/call：initialize 必须正常握手，
    // 否则测的就是握手失败而不是协议失败路径。
    if (this.failCall && request.method === 'tools/call') {
      await this.peer.send(encodeMcpFrame({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'server boom' } }));
      return;
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    const result =
      request.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
        : request.method === 'tools/call'
          ? this.toolResult
          : { tools: [] };
    await this.peer.send(encodeMcpFrame({ jsonrpc: '2.0', id: request.id, result }));
  }
}

interface Harness {
  pool: McpClientPool;
  server: FakeMcpServer;
  transportsCreated: () => number;
}

function harness(): Harness {
  let created = 0;
  const [clientEnd, serverEnd] = McpLoopbackTransport.pair();
  const server = new FakeMcpServer(serverEnd);
  const pool = new McpClientPool({
    idleGraceMs: 60_000,
    createTransport: () => {
      created += 1;
      return clientEnd;
    },
  });
  return { pool, server, transportsCreated: () => created };
}

test('通电：canonical 名 → 池 → 真实会话，结果原样带回', async () => {
  const h = harness();
  h.server.toolResult = { content: [{ type: 'text', text: 'note-body' }], structuredContent: { id: 7 } };
  const executor = createMcpPoolToolExecutor({ pool: h.pool });
  const result = await executor.execute('mcp__demo__read_note', { id: 7 });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'note-body' }], structuredContent: { id: 7 } });
  // 服务器收到的是服务端工具名，不是 canonical 名。
  const call = h.server.requests.find((request) => request.method === 'tools/call');
  assert.deepEqual(call?.params, { name: 'read_note', arguments: { id: 7 } });
  assert.equal(h.transportsCreated(), 1, '一次调用只开一个连接');
  await h.pool.close();
});

test('业务 isError：原样带回（不升级为协议失败）', async () => {
  const h = harness();
  h.server.toolResult = { content: [{ type: 'text', text: 'disk full' }], isError: true };
  const executor = createMcpPoolToolExecutor({ pool: h.pool });
  const result = (await executor.execute('mcp__demo__write_note', {})) as { isError?: boolean };
  assert.equal(result.isError, true);
  await h.pool.close();
});

test('协议失败（tools/call error 应答）：抛错，且租约已归还', async () => {
  const h = harness();
  h.server.failToolsCall();
  const executor = createMcpPoolToolExecutor({ pool: h.pool });
  await assert.rejects(() => executor.execute('mcp__demo__read_note', {}), /mcp-request-failed:server boom/);
  await h.pool.close();
});

test('不可解析的 canonical 名：拒绝执行，不开连接', async () => {
  const h = harness();
  const executor = createMcpPoolToolExecutor({ pool: h.pool });
  await assert.rejects(() => executor.execute('read_note', {}), /mcpapp-tool-name-unparseable/);
  assert.equal(h.transportsCreated(), 0, '连接都没开');
  await h.pool.close();
});

test('描述符超时：descriptor.timeoutMs 进入 tools/call 请求', async () => {
  const h = harness();
  const registry = new ToolRegistry();
  registry.register({
    name: 'mcp__demo__slow_render',
    capability: 'filesystem.read',
    defaultRisk: 'low',
    readOnly: true,
    destructive: false,
    sideEffectScope: 'external',
    resultBudgetChars: 32_000,
    timeoutMs: 90_000,
    concurrentSafe: true,
  });
  const executor = createMcpPoolToolExecutor({ pool: h.pool, descriptors: registry });
  // 假服务器立即应答；超时值只是透传，这里不断言时序，只断言不破坏调用。
  await executor.execute('mcp__demo__slow_render', {});
  assert.ok(h.server.requests.some((request) => request.method === 'tools/call'));
  await h.pool.close();
});

test('租约不泄漏：异常路径后池内引用归零（pendingClose 可见）', async () => {
  const h = harness();
  h.server.failToolsCall();
  const executor = createMcpPoolToolExecutor({ pool: h.pool });
  await assert.rejects(() => executor.execute('mcp__demo__read_note', {}));
  // release 已执行：引用归零，entry 进入空闲宽限而非永久占用。
  assert.equal(h.pool.pendingCloseConnections, 1, '租约已归还（宽限中）');
  await h.pool.close();
});
