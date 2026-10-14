// 一个文件=一种作用：MCP 连接提供器（manifest → transport）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMcpStdioConnectionProvider,
  type McpServerConnection,
} from '../src/runtime/zcode/mcp-connection-provider';
import { McpStdioTransport, type McpStdioTransportDeps } from '../src/runtime/zcode/mcp-stdio-transport';

interface RecordedCall {
  readonly command: string;
  readonly args: Record<string, unknown>;
}

function fakeDeps(): { deps: McpStdioTransportDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    deps: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        return undefined;
      },
      listen: async () => () => undefined,
    },
    calls,
  };
}

const stdio: McpServerConnection = { transport: 'stdio', executable: 'server.exe', args: ['--transport', 'stdio'] };

test('stdio manifest → 已启动的 McpStdioTransport（runId/argv/env 透传命令面）', async () => {
  const { deps, calls } = fakeDeps();
  const provider = createMcpStdioConnectionProvider({
    deps,
    env: [['HTTPS_PROXY', 'http://127.0.0.1:57777']],
    runIdFor: (serverId) => `mcp-${serverId}-fixed`,
    loadConnection: () => stdio,
  });
  const transport = await provider.transportFor('demo');
  assert.ok(transport instanceof McpStdioTransport);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'mcp_start_process');
  assert.deepEqual(calls[0]?.args, {
    request: { runId: 'mcp-demo-fixed', executable: 'server.exe', args: ['--transport', 'stdio'], env: [['HTTPS_PROXY', 'http://127.0.0.1:57777']], workingDirectory: null },
  });
});

test('HTTP 服务器：传输未实现 → undefined（明确缺口，绝不假装能连）', async () => {
  const provider = createMcpStdioConnectionProvider({
    deps: fakeDeps().deps,
    loadConnection: (): McpServerConnection => ({ transport: 'streamable_http', endpoint: 'https://mcp.example.com/rpc' }),
  });
  assert.equal(await provider.transportFor('demo'), undefined);
});

test('加载失败/未注册/启动失败：一律 undefined（坏连接不进池）', async () => {
  const missing = createMcpStdioConnectionProvider({ deps: fakeDeps().deps, loadConnection: () => undefined });
  assert.equal(await missing.transportFor('nope'), undefined);
  const throwing = createMcpStdioConnectionProvider({
    deps: fakeDeps().deps,
    loadConnection: () => {
      throw new Error('db offline');
    },
  });
  assert.equal(await throwing.transportFor('demo'), undefined);
  const spawnFailed = createMcpStdioConnectionProvider({
    deps: {
      invoke: async () => {
        throw new Error('mcp-spawn-failed');
      },
      listen: async () => () => undefined,
    },
    loadConnection: () => stdio,
  });
  assert.equal(await spawnFailed.transportFor('demo'), undefined);
});

test('runId 唯一性：同服务器多次取连接不撞 SEC-005 预留', async () => {
  const { deps, calls } = fakeDeps();
  const provider = createMcpStdioConnectionProvider({ deps, loadConnection: () => stdio });
  await provider.transportFor('demo');
  await provider.transportFor('demo');
  const runIds = calls.map((call) => (call.args.request as { runId: string }).runId);
  assert.equal(new Set(runIds).size, 2, '两次取连接生成不同 runId');
  assert.ok(runIds[0]?.startsWith('mcp-demo-'));
});
