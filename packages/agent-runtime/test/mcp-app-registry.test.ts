// 一个文件=一种作用：MCP App 注册表（准入持久化 + 生命周期）的验收测试。

import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { InMemoryMcpManifestStore } from '../src/mcp-registry';
import { InMemoryMcpAppStore, McpAppRegistry, SqliteMcpAppStore } from '../src/mcp-app-registry';
import type { RegisterMcpServerRequest } from '../src/mcp-registry';

function serverStoreWithEnabledServer(): InMemoryMcpManifestStore {
  const store = new InMemoryMcpManifestStore();
  const request: RegisterMcpServerRequest = {
    id: 'demo-mcp',
    displayName: '笔记 MCP',
    connection: { transport: 'streamable_http', endpoint: 'https://mcp.example.com/rpc' },
    declaredTools: [
      { name: 'read_note', description: '读笔记', capability: 'filesystem.read', risk: 'low' },
      { name: 'write_note', description: '写笔记', capability: 'filesystem.write', risk: 'high' },
    ],
    sourceDigest: 'a'.repeat(64),
    reviewedBy: 'reviewer-1',
    at: 1_000,
  };
  store.append({ ...request, schemaVersion: 1, status: 'registered', revision: 1, createdAt: 1_000, updatedAt: 1_000 });
  store.append({ ...request, schemaVersion: 1, status: 'enabled', revision: 2, createdAt: 1_000, updatedAt: 1_100, enabledAt: 1_100 });
  return store;
}

function freshRegistry(): { registry: McpAppRegistry; serverStore: InMemoryMcpManifestStore } {
  const serverStore = serverStoreWithEnabledServer();
  return { registry: new McpAppRegistry(new InMemoryMcpAppStore(), serverStore), serverStore };
}

function registerNotesApp(registry: McpAppRegistry): void {
  registry.register({
    id: 'mcpapp-demo-mcp.notes-ui',
    serverId: 'demo-mcp',
    displayName: '笔记面板',
    htmlResourceUri: 'ui://demo-mcp/notes-app',
    requestedToolNames: ['read_note'],
    reviewedBy: 'reviewer-1',
    at: 1_200,
  });
}

test('注册：准入校验通过并记录 admittedToolNames，初始态 registered（未启用不可解析）', () => {
  const { registry } = freshRegistry();
  registerNotesApp(registry);
  const manifest = registry.list()[0]!;
  assert.equal(manifest.status, 'registered');
  assert.deepEqual(manifest.admittedToolNames, ['read_note']);
  assert.throws(() => registry.resolveApp('mcpapp-demo-mcp.notes-ui'), /尚未显式启用/);
});

test('注册：服务器未登记 / 未启用 / 工具未登记 均拒绝', () => {
  const { registry } = freshRegistry();
  const base = {
    id: 'mcpapp-demo-mcp.notes-ui',
    serverId: 'demo-mcp',
    displayName: '笔记面板',
    htmlResourceUri: 'ui://demo-mcp/notes-app',
    requestedToolNames: ['read_note'],
    reviewedBy: 'reviewer-1',
    at: 1_200,
  };
  assert.throws(() => registry.register({ ...base, serverId: 'no-such-mcp' }), /未登记/);
  // 未启用的服务器（只有 registered 修订）不能挂应用。
  const freshServerStore = new InMemoryMcpManifestStore();
  freshServerStore.append({
    schemaVersion: 1,
    id: 'demo-mcp',
    displayName: '笔记 MCP',
    connection: { transport: 'streamable_http', endpoint: 'https://mcp.example.com/rpc' },
    declaredTools: [{ name: 'read_note', description: '读笔记', capability: 'filesystem.read', risk: 'low' }],
    sourceDigest: 'a'.repeat(64),
    status: 'registered',
    revision: 1,
    reviewedBy: 'reviewer-1',
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  const isolated = new McpAppRegistry(new InMemoryMcpAppStore(), freshServerStore);
  assert.throws(() => isolated.register({ ...base, serverId: 'demo-mcp' }), /尚未显式启用/);
  // 服务器已启用但工具未登记：protocol 准入校验整单拒绝。
  assert.throws(() => registry.register({ ...base, requestedToolNames: ['exec_shell'] }), /准入校验未通过/);
});

test('生命周期：enable → resolveApp 可解析（含 server revision）；server 被禁用后无法解析', () => {
  const { registry, serverStore } = freshRegistry();
  registerNotesApp(registry);
  registry.enable('mcpapp-demo-mcp.notes-ui', 'reviewer-1', 1_300);
  const resolved = registry.resolveApp('mcpapp-demo-mcp.notes-ui');
  assert.deepEqual(resolved.admission.admittedToolNames, ['read_note']);
  assert.equal(resolved.serverRevision, 2);

  // server 侧新修订（禁用）落地后：应用解析立即失败——准入白名单随 server 状态失效。
  const current = serverStore.load('demo-mcp')!;
  serverStore.append({ ...current, status: 'disabled', revision: current.revision + 1, updatedAt: 2_000, disabledAt: 2_000 });
  assert.throws(() => registry.resolveApp('mcpapp-demo-mcp.notes-ui'), /未处于启用态/);
});

test('server 被禁用后应用无法单独启用（防止绕过服务器状态）', () => {
  const { registry, serverStore } = freshRegistry();
  registerNotesApp(registry);
  const current = serverStore.load('demo-mcp')!;
  serverStore.append({ ...current, status: 'disabled', revision: current.revision + 1, updatedAt: 2_000, disabledAt: 2_000 });
  assert.throws(() => registry.enable('mcpapp-demo-mcp.notes-ui', 'reviewer-1', 2_100), /未处于启用态/);
});

test('disable / revoke 语义与 mcp-registry 对称；已撤销不得重新启用', () => {
  const { registry } = freshRegistry();
  registerNotesApp(registry);
  registry.enable('mcpapp-demo-mcp.notes-ui', 'reviewer-1', 1_300);
  registry.disable('mcpapp-demo-mcp.notes-ui', 'reviewer-1', 1_400);
  registry.revoke('mcpapp-demo-mcp.notes-ui', 'reviewer-1', 1_500);
  assert.equal(registry.list()[0]!.status, 'revoked');
  assert.throws(() => registry.enable('mcpapp-demo-mcp.notes-ui', 'reviewer-1', 1_600), /不得重新启用/);
});

test('SqliteMcpAppStore 往返：重开后 latest/history 与内存实现一致', () => {
  const dir = os.tmpdir();
  const filePath = `${dir}/awo-mcp-app-store-${process.pid}-sqlite/apps.db`;
  const sqliteStore = new SqliteMcpAppStore(filePath);
  const sqliteRegistry = new McpAppRegistry(sqliteStore, serverStoreWithEnabledServer());
  registerNotesApp(sqliteRegistry);
  sqliteRegistry.enable('mcpapp-demo-mcp.notes-ui', 'reviewer-1', 1_300);
  sqliteStore.close();

  const reopened = new SqliteMcpAppStore(filePath);
  const record2 = new McpAppRegistry(reopened, serverStoreWithEnabledServer());
  assert.equal(record2.list().length, 1);
  assert.equal(record2.list()[0]!.status, 'enabled');
  assert.equal(record2.resolveApp('mcpapp-demo-mcp.notes-ui').admission.manifest.displayName, '笔记面板');
  reopened.close();
});
