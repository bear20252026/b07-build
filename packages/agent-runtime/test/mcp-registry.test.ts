import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  InMemoryMcpManifestStore,
  McpRegistry,
  RuleBasedCapabilityPolicy,
  SqliteMcpManifestStore,
} from '../src/index.js';

const digest = 'a'.repeat(64);

function register(registry: McpRegistry, id = 'mcp-local'): void {
  registry.register({
    id,
    displayName: 'Local reviewed MCP',
    connection: { transport: 'stdio', executable: 'npx', args: ['--yes', '@example/reviewed-mcp'] },
    declaredTools: [
      { name: 'read_docs', description: '读取本地文档。', capability: 'filesystem.read', risk: 'low' },
      { name: 'write_intent', description: '生成写入意图。', capability: 'filesystem.write', risk: 'high' },
    ],
    sourceDigest: digest,
    reviewedBy: 'local-admin',
    note: '已审查 manifest，不会在登记时启动命令。',
    at: 100,
  });
}

const permissiveBaseline = new RuleBasedCapabilityPolicy([
  { capability: 'filesystem.read', decision: 'allow', reason: '允许读取' },
  { capability: 'filesystem.write', decision: 'allow', reason: '基础策略允许，但 MCP 仍需审批' },
]);

test('MCP server 默认仅登记不启用，且只能解析 manifest 白名单内的已启用工具', () => {
  const registry = new McpRegistry(new InMemoryMcpManifestStore());
  register(registry);
  assert.equal(registry.list()[0]?.status, 'registered');
  assert.throws(() => registry.resolveTool('mcp-local', 'read_docs'), /尚未显式启用/);

  const enabled = registry.enable('mcp-local', 'local-admin', 110, '明确启用读取工具。');
  assert.equal(enabled.status, 'enabled');
  assert.equal(registry.enabled().length, 1);
  const resolved = registry.resolveTool('mcp-local', 'read_docs');
  assert.deepEqual(resolved, {
    serverId: 'mcp-local', serverRevision: 2, transport: 'stdio',
    tool: { name: 'read_docs', description: '读取本地文档。', capability: 'filesystem.read', risk: 'low' },
    sourceDigest: digest,
  });
  assert.throws(() => registry.resolveTool('mcp-local', 'unreviewed_tool'), /白名单/);
});

test('MCP manifest 无法放宽外部能力策略，高风险工具仍进入审批门控', () => {
  const registry = new McpRegistry(new InMemoryMcpManifestStore());
  register(registry);
  registry.enable('mcp-local', 'local-admin', 110);
  const read = registry.authorizeTool('mcp-local', 'read_docs', {
    taskId: 'task-001', runId: 'run-001', actionId: 'mcp-read-001',
  }, permissiveBaseline);
  assert.equal(read.decision, 'allow');
  assert.equal(read.canAuthorize, false);

  const highRisk = registry.authorizeTool('mcp-local', 'write_intent', {
    taskId: 'task-001', runId: 'run-001', actionId: 'mcp-write-001',
  }, permissiveBaseline);
  assert.equal(highRisk.decision, 'require_approval');
  const denied = registry.authorizeTool('mcp-local', 'read_docs', {
    taskId: 'task-001', runId: 'run-001', actionId: 'mcp-read-002',
  }, new RuleBasedCapabilityPolicy([{ capability: 'filesystem.read', decision: 'deny', reason: '父任务拒绝读取' }]));
  assert.equal(denied.decision, 'deny');
});

test('禁用与撤销均阻断运行时解析，撤销 manifest 不能被重新启用', () => {
  const registry = new McpRegistry(new InMemoryMcpManifestStore());
  register(registry);
  registry.enable('mcp-local', 'local-admin', 110);
  registry.disable('mcp-local', 'local-admin', 120, '暂停使用。');
  assert.throws(() => registry.resolveTool('mcp-local', 'read_docs'), /尚未显式启用/);
  registry.revoke('mcp-local', 'local-admin', 130, '发现风险。');
  assert.throws(() => registry.enable('mcp-local', 'local-admin', 140), /不得重新启用/);
  assert.deepEqual(registry.list()[0] && {
    status: registry.list()[0]?.status,
    revision: registry.list()[0]?.revision,
  }, { status: 'revoked', revision: 4 });
});

test('登记拒绝不安全 HTTP 地址；SQLite 历史可在重开后审查', () => {
  const memory = new McpRegistry(new InMemoryMcpManifestStore());
  assert.throws(() => memory.register({
    id: 'mcp-remote', displayName: 'Remote', connection: { transport: 'streamable_http', endpoint: 'http://example.com/mcp' },
    declaredTools: [{ name: 'read', description: 'read', capability: 'filesystem.read', risk: 'low' }],
    sourceDigest: digest, reviewedBy: 'local-admin', at: 1,
  }), /https/);

  const directory = mkdtempSync(join(tmpdir(), 'awo-mcp-registry-'));
  const filePath = join(directory, 'registry.sqlite');
  try {
    const store = new SqliteMcpManifestStore(filePath);
    const registry = new McpRegistry(store);
    register(registry, 'mcp-sqlite');
    registry.enable('mcp-sqlite', 'local-admin', 110);
    assert.equal(store.history('mcp-sqlite').length, 2);
    store.close();

    const reopened = new SqliteMcpManifestStore(filePath);
    assert.deepEqual(reopened.history('mcp-sqlite').map((item) => item.status), ['registered', 'enabled']);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
