import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopDiagnosticsFrom } from '../src/runtime/desktop-diagnostics-client.js';

test('接受不含路径、令牌或聊天正文的本地桌面诊断快照', () => {
  const snapshot = desktopDiagnosticsFrom({ schemaVersion: 1, desktopVersion: '0.1.3', sourceRevision: '0123456789abcdef0123456789abcdef01234567', workspaceSelected: true, connectedProviderCount: 2, searxng: { schemaVersion: 1, state: 'running', port: 34567, startupTimeoutSeconds: 35, requestTimeoutSeconds: 30 } });
  assert.equal(snapshot.desktopVersion, '0.1.3');
  assert.equal(snapshot.searxng.port, 34567);
});

test('拒绝缺少 SearXNG 预算或无效端口的桌面诊断快照', () => {
  assert.throws(() => desktopDiagnosticsFrom({ schemaVersion: 1, desktopVersion: '0.1.3', sourceRevision: 'not-a-revision', workspaceSelected: false, connectedProviderCount: 0, searxng: { schemaVersion: 1, state: 'running', port: 0, startupTimeoutSeconds: 35 } }), /desktop-diagnostics-invalid/);
});
