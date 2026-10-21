import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { SdkMcpSession } from '../src/runtime/zcode/mcp-sdk-session.js';
import type { McpWireTransport, McpWireTransportHandlers } from '../src/runtime/zcode/mcp-client-transport.js';

// ---------------------------------------------------------------------------
// 对着**真实 stdio 进程**跑一遍完整链路：spawn → 逐行帧 → 握手 → 列工具 → 调工具 → 关闭。
//
// loopback 测试只证明了适配器形状；这条测试证明的是真实管道上的行为，
// 也就是 `McpStdioTransport` 在原生侧负责的那一段（这里是它的 Node 版替身）。
// ---------------------------------------------------------------------------

const SERVER_PATH = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url));

/** 测试用的 stdio 传输：把子进程的 stdin/stdout 包成按行收发的 `McpWireTransport`。 */
class NodeStdioTransport implements McpWireTransport {
  private readonly handlers = new Set<McpWireTransportHandlers>();
  private closed = false;

  constructor(private readonly child: ReturnType<typeof spawn>) {
    // @types/node 26 里 stream.Readable 与 NodeJS.ReadableStream 的 asyncIterator 签名
    // 互不兼容（本仓 TS 锁在 5.5.4，读不到更宽松的配对）：运行时正确，类型层在这里收敛一次。
    const reader = createInterface({ input: child.stdout! as unknown as NodeJS.ReadableStream });
    reader.on('line', (line) => {
      for (const handler of [...this.handlers]) handler.onLine(line);
    });
    child.on('exit', () => {
      this.closed = true;
      for (const handler of [...this.handlers]) handler.onClose?.('process-exit');
      this.handlers.clear();
    });
  }

  async send(payload: string): Promise<void> {
    if (this.closed) throw new Error('stdio-closed');
    this.child.stdin!.write(`${payload}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 先关 stdin：夹具在 stdin 关闭时自行 exit(0)。
    // 500ms 内没退再强杀 —— 强杀会让 exit code 变成 null，掩盖"优雅退出"这件事。
    this.child.stdin?.end();
    const fallback = setTimeout(() => this.child.kill(), 500);
    fallback.unref?.();
  }

  subscribe(handlers: McpWireTransportHandlers): () => void {
    this.handlers.add(handlers);
    return () => this.handlers.delete(handlers);
  }
}

function startSession(): { session: SdkMcpSession; transport: NodeStdioTransport; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const transport = new NodeStdioTransport(child);
  return { session: new SdkMcpSession({ serverId: 'fixture', transport, requestTimeoutMs: 5_000 }), transport, exited };
}

test('真实 stdio 服务器：握手 + 列工具', async () => {
  const { session, exited } = startSession();
  await session.connect();
  const tools = await session.listTools();
  assert.deepEqual(tools.map((tool) => (tool as { name: string }).name), ['greet', 'fail_on_purpose']);
  await session.close();
  assert.equal(await exited, 0, '关闭后进程应干净退出');
});

test('真实 stdio 服务器：调工具成功', async () => {
  const { session } = startSession();
  await session.connect();
  const outcome = await session.callTool('greet', { name: 'b07' });
  assert.equal(outcome.ok, true);
  const result = outcome.result as { content?: readonly { text?: string }[] };
  assert.equal(result.content?.[0]?.text, '你好，b07');
  await session.close();
});

test('真实 stdio 服务器：工具自身失败保持业务语义（ok=true + isError）', async () => {
  // isError 是工具的业务结果，不该被升级成协议失败 —— 否则上层会把它当成连接问题。
  const { session } = startSession();
  await session.connect();
  const outcome = await session.callTool('fail_on_purpose', {});
  assert.equal(outcome.ok, true);
  assert.equal((outcome.result as { isError?: boolean }).isError, true);
  await session.close();
});

test('真实 stdio 服务器：未知工具是协议失败', async () => {
  const { session } = startSession();
  await session.connect();
  const outcome = await session.callTool('does_not_exist', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'mcp-request-failed');
  assert.match(outcome.message ?? '', /未知工具/);
  await session.close();
});

test('真实 stdio 服务器：服务器不应答时由 requestTimeoutMs 掐断', async () => {
  // 这条守的是"不能永久挂住"。用 requestTimeoutMs 极小的会话，且服务器故意不应答 —— 
  // 这里用 kill 掉 stdin 的方式模拟不应答：写不进去自然就超时/失败。
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const transport = new NodeStdioTransport(child);
  const session = new SdkMcpSession({ serverId: 'silent', transport, requestTimeoutMs: 80 });
  await assert.rejects(() => session.connect());
  await session.close();
});
