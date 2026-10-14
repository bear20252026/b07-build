// 一个文件=一种作用：MCP stdio 传输（Tauri 面）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { McpStdioTransport, MCP_STDIO_LINE_EVENT, MCP_STDIO_EXIT_EVENT, type McpStdioTransportDeps } from '../src/runtime/zcode/mcp-stdio-transport';

interface RecordedCall {
  readonly command: string;
  readonly args: Record<string, unknown>;
}

function fakeDeps(): { deps: McpStdioTransportDeps; calls: RecordedCall[]; emit(event: string, payload: unknown): void } {
  const calls: RecordedCall[] = [];
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();
  const deps: McpStdioTransportDeps = {
    invoke: async (command, args) => {
      calls.push({ command, args });
      return undefined;
    },
    listen: async (event, handler) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(event, current.filter((entry) => entry !== handler));
      };
    },
  };
  return {
    deps,
    calls,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    },
  };
}

function transport(deps: McpStdioTransportDeps): McpStdioTransport {
  return new McpStdioTransport({ runId: 'mcp-demo-1', executable: 'server.exe', args: ['--transport', 'stdio'], deps });
}

test('start：mcp_start_process 携带 argv/env/工作目录', async () => {
  const { deps, calls } = fakeDeps();
  await transport(deps).start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'mcp_start_process');
  assert.deepEqual(calls[0]?.args, {
    request: { runId: 'mcp-demo-1', executable: 'server.exe', args: ['--transport', 'stdio'], env: [], workingDirectory: null },
  });
});

test('subscribe：仅当前 runId 的 stdout 行进入会话；stderr 与他人的帧被忽略', async () => {
  const { deps, emit } = fakeDeps();
  const client = transport(deps);
  await client.start();
  const lines: string[] = [];
  const closed: string[] = [];
  const unsubscribe = client.subscribe({ onLine: (line) => lines.push(line), onClose: (reason) => closed.push(reason ?? '') });
  await new Promise((resolve) => setTimeout(resolve, 5));
  emit(MCP_STDIO_LINE_EVENT, { runId: 'mcp-demo-1', stream: 'stdout', text: '{"jsonrpc":"2.0","id":1}' });
  emit(MCP_STDIO_LINE_EVENT, { runId: 'mcp-demo-1', stream: 'stderr', text: 'diagnostic noise' });
  emit(MCP_STDIO_LINE_EVENT, { runId: 'other-run', stream: 'stdout', text: '{"jsonrpc":"2.0","id":2}' });
  assert.deepEqual(lines, ['{"jsonrpc":"2.0","id":1}'], '只收本 run 的 stdout 帧');
  assert.deepEqual(closed, []);
  unsubscribe();
  emit(MCP_STDIO_LINE_EVENT, { runId: 'mcp-demo-1', stream: 'stdout', text: 'after-unsubscribe' });
  assert.equal(lines.length, 1, '退订后不再入会话');
});

test('exit 事件：本 run 退出触发 onClose，其后帧不再进会话', async () => {
  const { deps, emit } = fakeDeps();
  const client = transport(deps);
  await client.start();
  const lines: string[] = [];
  const closed: string[] = [];
  client.subscribe({ onLine: (line) => lines.push(line), onClose: (reason) => closed.push(reason ?? '') });
  await new Promise((resolve) => setTimeout(resolve, 5));
  emit(MCP_STDIO_EXIT_EVENT, { runId: 'mcp-demo-1' });
  assert.deepEqual(closed, ['mcp-process-exit']);
  emit(MCP_STDIO_LINE_EVENT, { runId: 'mcp-demo-1', stream: 'stdout', text: 'late-frame' });
  assert.deepEqual(lines, [], '退出后的迟到帧被传输层丢弃');
});

test('send：帧原样写入 stdin（换行由会话机编码、原生侧兜底校验）', async () => {
  const { deps, calls } = fakeDeps();
  const client = transport(deps);
  await client.start();
  await client.send('{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
  assert.equal(calls.at(-1)?.command, 'mcp_write_stdin');
  assert.deepEqual(calls.at(-1)?.args, { request: { runId: 'mcp-demo-1', line: '{"jsonrpc":"2.0","id":9,"method":"ping"}\n' } });
});

test('未启动时 send/close 的纪律', async () => {
  const { deps, calls } = fakeDeps();
  const client = transport(deps);
  await assert.rejects(() => client.send('frame'), /传输未启动或已关闭/);
  await client.close();
  await client.close();
  assert.equal(calls.filter((call) => call.command === 'mcp_stop_process').length, 0, '未启动则不发停止');
});

test('close：半关 + 停止命令只发一次', async () => {
  const { deps, calls } = fakeDeps();
  const client = transport(deps);
  await client.start();
  await client.close();
  await client.close();
  assert.equal(calls.filter((call) => call.command === 'mcp_stop_process').length, 1, '幂等停止');
});
