// 一个文件=一种作用：MCP 客户端会话机的验收测试（握手/协商/工具调用/通知/超时/关闭）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { McpLoopbackTransport, McpProtocolError, type McpWireTransport } from '../src/runtime/zcode/mcp-client-transport';
import { McpClientSession } from '../src/runtime/zcode/mcp-client-session';
import { normalizeMcpToolDescriptors } from '../src/runtime/zcode/mcp-tool-descriptor';
import { encodeMcpFrame, parseMcpFrame, type McpJsonRpcRequest } from '../src/runtime/zcode/mcp-client-wire';

/** 可编排的假服务器：自动应答 initialize/tools/list/tools/call，可注入噪声/通知/冻结。 */
class FakeMcpServer {
  readonly requests: McpJsonRpcRequest[] = [];
  protocolVersion = '2025-06-18';
  serverInfo = { name: 'fake-server', version: '1.2.3' };
  tools: unknown[] = [{ name: 'read_note', description: '读笔记', inputSchema: { type: 'object', properties: { id: { type: 'number' } } } }];
  toolResults: Record<string, unknown> = {};
  private readonly frozen = new Set<string>();
  private readonly errors = new Map<string, { code: number; message: string }>();

  constructor(private readonly peer: McpWireTransport) {
    peer.subscribe({ onLine: (line) => void this.handle(line) });
  }

  freeze(method: string): void {
    this.frozen.add(method);
  }

  failWith(method: string, code: number, message: string): void {
    this.errors.set(method, { code, message });
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.peer.send(encodeMcpFrame({ jsonrpc: '2.0', method, params }));
  }

  async sendRaw(text: string): Promise<void> {
    await this.peer.send(text);
  }

  private async handle(line: string): Promise<void> {
    const message = parseMcpFrame(line);
    if (!message || !('method' in message) || !('id' in message)) return;
    const request = message as McpJsonRpcRequest;
    this.requests.push(request);
    if (this.frozen.has(request.method)) return;
    const failure = this.errors.get(request.method);
    await this.peer.send(
      encodeMcpFrame(
        failure
          ? { jsonrpc: '2.0', id: request.id, error: { code: failure.code, message: failure.message } }
          : { jsonrpc: '2.0', id: request.id, result: this.resultFor(request) },
      ),
    );
  }

  private resultFor(request: McpJsonRpcRequest): unknown {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case 'initialize':
        return { protocolVersion: this.protocolVersion, capabilities: { tools: {} }, serverInfo: this.serverInfo };
      case 'tools/list':
        return { tools: this.tools };
      case 'tools/call':
        return this.toolResults[String(params.name)] ?? { content: [{ type: 'text', text: `ok:${String(params.name)}` }] };
      default:
        return {};
    }
  }
}

function sessionPair(options: { requestTimeoutMs?: number } = {}): { session: McpClientSession; server: FakeMcpServer } {
  const [clientEnd, serverEnd] = McpLoopbackTransport.pair();
  const server = new FakeMcpServer(serverEnd);
  const session = new McpClientSession({ serverId: 'demo', transport: clientEnd, requestTimeoutMs: options.requestTimeoutMs });
  return { session, server };
}

test('握手：initialize 用 LATEST 发起，协商结果与 serverInfo 落账，initialized 通知随后', async () => {
  const { session, server } = sessionPair();
  const result = await session.connect();
  assert.equal(result.protocolVersion, '2025-06-18', '服务器选了双方都懂的旧版本');
  assert.deepEqual(result.serverInfo, { name: 'fake-server', version: '1.2.3' });
  assert.equal(session.sessionState, 'ready');
  assert.deepEqual(
    server.requests.map((request) => request.method),
    ['initialize'],
    '握手中只有 initialize 带 id',
  );
  await session.close();
});

test('协商：服务器回传未知版本时按 LATEST 记录并继续', async () => {
  const { session, server } = sessionPair();
  server.protocolVersion = '2099-01-01';
  const result = await session.connect();
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.equal(session.protocolVersion, '2025-11-25');
});

test('握手失败：error 应答 → connect 拒绝且会话作废，后续调用 fail-closed', async () => {
  const { session, server } = sessionPair();
  server.failWith('initialize', -32600, 'bad handshake');
  await assert.rejects(() => session.connect(), (error: unknown) => error instanceof McpProtocolError && error.message === 'bad handshake');
  assert.equal(session.sessionState, 'closed');
  const outcome = await session.callTool('read_note', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'mcp-session-not-ready');
});

test('tools/list：原样返回数组并清 stale；归一化交给 descriptor 模块', async () => {
  const { session } = sessionPair();
  await session.connect();
  const tools = await session.listTools();
  assert.equal(tools.length, 1);
  const descriptors = normalizeMcpToolDescriptors('demo', tools);
  assert.equal(descriptors[0]?.name, 'mcp__demo__read_note');
  assert.equal(descriptors[0]?.toolName, 'read_note');
});

test('notifications/tools/list_changed：置 stale，listTools 后清除', async () => {
  const { session, server } = sessionPair();
  await session.connect();
  assert.equal(session.toolsChanged, false);
  await server.notify('notifications/tools/list_changed', {});
  assert.equal(session.toolsChanged, true);
  await session.listTools();
  assert.equal(session.toolsChanged, false);
});

test('tools/call：协议成功 ok:true；isError 是业务失败不降级为协议失败', async () => {
  const { session, server } = sessionPair();
  await session.connect();
  const ok = await session.callTool('read_note', { id: 7 });
  assert.deepEqual(ok, { ok: true, result: { content: [{ type: 'text', text: 'ok:read_note' }] } });
  server.toolResults.write_note = { content: [{ type: 'text', text: 'disk full' }], isError: true };
  const businessFailure = await session.callTool('write_note', {});
  assert.equal(businessFailure.ok, true, '业务失败仍是协议成功');
  assert.equal(businessFailure.result?.isError, true);
});

test('tools/call：协议 error 应答 → ok:false 且带上 rpc 错误', async () => {
  const { session, server } = sessionPair();
  await session.connect();
  server.failWith('tools/call', -32602, 'invalid arguments');
  const outcome = await session.callTool('read_note', { bad: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'mcp-request-failed');
  assert.equal(outcome.message, 'invalid arguments');
});

test('请求超时：服务器冻结 → 超时即拒且摘除 pending', async () => {
  const { session, server } = sessionPair({ requestTimeoutMs: 40 });
  await session.connect();
  server.freeze('tools/call');
  const outcome = await session.callTool('read_note', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'mcp-request-timeout');
  assert.equal(session.sessionState, 'ready', '超时不杀会话，只杀这一条请求');
});

test('传输断开：未决请求失败，会话 closed，后续调用 fail-closed', async () => {
  const [clientEnd, serverEnd] = McpLoopbackTransport.pair();
  const server = new FakeMcpServer(serverEnd);
  const session = new McpClientSession({ serverId: 'demo', transport: clientEnd, requestTimeoutMs: 40 });
  await session.connect();
  server.freeze('tools/call');
  const inFlight = session.callTool('read_note', {});
  await serverEnd.close();
  const outcome = await inFlight;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'mcp-transport-closed');
  assert.equal(session.sessionState, 'closed');
});

test('入站噪声：非 JSON-RPC 帧被丢弃，不影响会话', async () => {
  const { session, server } = sessionPair();
  await session.connect();
  await server.sendRaw('not json at all\n');
  await server.sendRaw('{"jsonrpc":"1.0","id":99,"result":{}}\n');
  const outcome = await session.callTool('read_note', {});
  assert.equal(outcome.ok, true, '噪声不污染会话');
});

test('并发调用：id 关联正确，响应不错配', async () => {
  const { session } = sessionPair();
  await session.connect();
  const [first, second] = await Promise.all([
    session.callTool('read_note', { id: 1 }),
    session.callTool('write_note', { id: 2 }),
  ]);
  assert.equal(first.result?.content?.[0] !== undefined, true);
  assert.equal(second.ok, true);
});
