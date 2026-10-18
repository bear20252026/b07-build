// 一个文件=一种作用：MCP 工具描述符归一化与连接池的验收测试。
//
// 会话协议已交给官方 SDK，所以这里的假服务器必须**真的会说 MCP**
// （应答 `initialize`，可选应答 `tools/list`）——否则握手不会成功。
// 这比原先"只要能解析 JSON-RPC 就行"的桩更严格，也更接近真实服务器。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_TOOL_TIMEOUT_MAX_MS,
  MCP_TOOL_TIMEOUT_MIN_MS,
  normalizeMcpToolDescriptor,
  normalizeMcpToolDescriptors,
  sanitizeMcpName,
} from '../src/runtime/zcode/mcp-tool-descriptor';
import { McpClientPool, type McpPoolEntryKey } from '../src/runtime/zcode/mcp-client-pool';
import { McpLoopbackTransport, type McpWireTransport } from '../src/runtime/zcode/mcp-client-transport';

test('sanitizeMcpName：非法字符折叠单下划，空串兜底 unknown', () => {
  assert.equal(sanitizeMcpName('read_note'), 'read_note');
  assert.equal(sanitizeMcpName('a b!!c'), 'a_b_c');
  assert.equal(sanitizeMcpName('!!!'), 'unknown');
});

test('normalizeMcpToolDescriptor：canonical 名 = mcp__server__tool，畸形项不抛', () => {
  const descriptor = normalizeMcpToolDescriptor('demo srv', { name: 'Read Note!', description: '读', inputSchema: { type: 'object', properties: { id: { type: 'number' } } }, annotations: { readOnlyHint: true, destructiveHint: false } });
  assert.equal(descriptor.name, 'mcp__demo_srv__Read_Note_');
  assert.equal(descriptor.toolName, 'Read Note!');
  assert.deepEqual(descriptor.annotations, { readOnlyHint: true, destructiveHint: false });
  const malformed = normalizeMcpToolDescriptor('demo', null);
  assert.equal(malformed.toolName, 'unknown');
  assert.equal(malformed.inputSchema, undefined);
});

test('归一化超时：工具级 _meta.timeoutMs 覆盖缺省，钳在 [1s, 30min]，越界忽略', () => {
  const below = normalizeMcpToolDescriptor('demo', { name: 't', _meta: { timeoutMs: 500 } }, 5_000);
  assert.equal(below.timeoutMs, 5_000, '低于下限的工具级值忽略，回落缺省');
  const above = normalizeMcpToolDescriptor('demo', { name: 't', _meta: { timeoutMs: 999_999_999 } });
  assert.equal(above.timeoutMs, MCP_TOOL_TIMEOUT_MAX_MS, '高于上限钳到 30 分钟');
  const exact = normalizeMcpToolDescriptor('demo', { name: 't', _meta: { timeoutMs: MCP_TOOL_TIMEOUT_MIN_MS } });
  assert.equal(exact.timeoutMs, MCP_TOOL_TIMEOUT_MIN_MS);
});

test('normalizeMcpToolDescriptors：批量归一化', () => {
  const descriptors = normalizeMcpToolDescriptors('demo', [{ name: 'a' }, { name: 'b', _meta: { timeoutMs: 2_000 } }], 9_000);
  assert.deepEqual(descriptors.map((item) => item.timeoutMs), [9_000, 2_000]);
});

// ---- 连接池 ----

interface JsonRpcRequest {
  id?: string | number;
  method: string;
}

/** 会说 MCP 的最小服务器：应答 initialize / tools/list，其余回 method not found。 */
class HandshakeServer {
  readonly methods: string[] = [];

  constructor(private readonly peer: McpWireTransport) {
    peer.subscribe({ onLine: (line) => void this.handle(line) });
  }

  private async handle(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return;
    }
    this.methods.push(request.method);
    // 通知没有 id，不回。
    if (request.id === undefined) return;
    const reply = (payload: unknown): Promise<void> => this.peer.send(JSON.stringify(payload));
    if (request.method === 'initialize') {
      await reply({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'srv', version: '1' } } });
      return;
    }
    if (request.method === 'tools/list') {
      // SDK 会按 schema 校验响应：`inputSchema` 是必填的。
      // （手写版没有这层校验，所以老桩能糊过去。）
      await reply({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'greet', inputSchema: { type: 'object', properties: {} } }] } });
      return;
    }
    await reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } });
  }
}

function poolPair(): { pool: McpClientPool; peers: McpLoopbackTransport[] } {
  const peers: McpLoopbackTransport[] = [];
  const pool = new McpClientPool({
    createTransport: () => {
      const [clientEnd, serverEnd] = McpLoopbackTransport.pair();
      new HandshakeServer(serverEnd);
      peers.push(serverEnd);
      return clientEnd;
    },
    idleGraceMs: 30,
  });
  return { pool, peers };
}

const spec: McpPoolEntryKey = { serverId: 'demo', isolation: 'workspace' };

test('池：acquire 完成握手，且拿到可用会话', async () => {
  const { pool } = poolPair();
  const first = await pool.acquire(spec);
  // 不再断言内部状态机（那是 SDK 的事），而是断言"真的能列工具"。
  const tools = await first.session.listTools();
  assert.deepEqual(tools.map((tool) => (tool as { name: string }).name), ['greet']);
  const second = await pool.acquire(spec);
  assert.equal(second.session, first.session, '复用同一会话');
  assert.equal(pool.activeConnections, 1);
  first.release();
  second.release();
  await pool.close();
});

test('池：并发 acquire 共享同一次握手（只开一个传输）', async () => {
  const { pool, peers } = poolPair();
  const [left, right] = await Promise.all([pool.acquire(spec), pool.acquire(spec)]);
  assert.equal(left.session, right.session);
  assert.equal(peers.length, 1, '只有一个传输被创建');
  left.release();
  right.release();
  await pool.close();
});

test('池：引用归零进宽限，宽限内再 acquire 直接复用；到点才关', async () => {
  const { pool, peers } = poolPair();
  const lease = await pool.acquire(spec);
  lease.release();
  assert.equal(pool.pendingCloseConnections, 1, '宽限中');
  const again = await pool.acquire(spec);
  assert.equal(again.session, lease.session, '宽限内复用，无新握手');
  assert.equal(pool.pendingCloseConnections, 0);
  assert.equal(peers.length, 1);
  again.release();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(pool.activeConnections, 0, '宽限到点会话被回收');
  await pool.close();
});

test('池：隔离键不同 → 不同会话', async () => {
  const { pool } = poolPair();
  const workspace = await pool.acquire({ serverId: 'demo', isolation: 'workspace' });
  const sessionScoped = await pool.acquire({ serverId: 'demo', isolation: 'session', scopeId: 's1' });
  assert.notEqual(workspace.session, sessionScoped.session);
  assert.equal(pool.activeConnections, 2);
  workspace.release();
  sessionScoped.release();
  await pool.close();
});

test('池：握手无应答 → acquire 在超时后拒绝且不留半死 entry', async () => {
  // 这条守的是"服务器不应答时不能永久挂住"。SDK 的 connect 会一直等，
  // 所以必须由 requestTimeoutMs 掐断。
  const pool = new McpClientPool({
    createTransport: () => McpLoopbackTransport.pair()[0], // 对端不应答
    idleGraceMs: 30,
    requestTimeoutMs: 60,
  });
  await assert.rejects(() => pool.acquire(spec));
  assert.equal(pool.activeConnections, 0, '半死 entry 被清除');
  await pool.close();
});

test('池：close 后拒绝新 acquire', async () => {
  const { pool } = poolPair();
  await pool.close();
  await assert.rejects(() => pool.acquire(spec), /mcp-pool-closed/);
});
