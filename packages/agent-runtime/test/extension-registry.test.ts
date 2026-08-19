import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capability } from '@awo/protocol';
import {
  ExtensionRegistry,
  InMemoryExtensionManifestStore,
  SqliteExtensionManifestStore,
} from '../src/index.js';

const digest = 'b'.repeat(64);

function discover(registry: ExtensionRegistry, id = 'provider.local'): void {
  registry.discover({
    id,
    version: '1.2.3',
    kind: 'model-provider',
    displayName: 'Reviewed local provider',
    source: { type: 'local-path', locator: '/opt/awo/extensions/provider-local', digest },
    compatibility: { hostApiVersion: 'awo.extension.v1', protocols: ['awo.task-event.v1'] },
    declaredCapabilities: ['model.chat', 'filesystem.read'],
    requestedPermissions: ['model.chat'],
    dataBoundary: 'local-only',
    resourceBudget: { maxMemoryMb: 256, maxCpuMs: 30_000, maxStartupMs: 2_000 },
    entry: { mode: 'supervised-process', ref: 'bin/awo-provider-local' },
    note: '仅登记 metadata，不导入或启动入口。',
    at: 100,
  });
}

test('extension 默认仅 discovered；完整审查和摘要核验后才会成为 activation 候选', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  discover(registry);
  assert.equal(registry.list()[0]?.status, 'discovered');
  assert.equal(registry.eligible().length, 0);

  registry.review('provider.local', 'local-admin', 110, '元数据与权限已审查。');
  assert.equal(registry.get('provider.local')?.status, 'reviewed');
  assert.throws(() => registry.install('provider.local', 'c'.repeat(64), 'local-admin', 120), /摘要不一致/);

  const installed = registry.install('provider.local', digest, 'local-admin', 120, '已核验本地制品。');
  assert.equal(installed.status, 'installed');
  assert.deepEqual(registry.eligible().map((item) => item.id), ['provider.local']);
  assert.equal(installed.entry?.ref, 'bin/awo-provider-local');
});

test('extension 声明不能以冗余或越界权限绕过核心 capability 枚举', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  assert.throws(() => registry.discover({
    id: 'invalid.permission',
    version: '1.0.0',
    kind: 'tool-adapter',
    displayName: 'Invalid permission',
    source: { type: 'npm', locator: 'npm:@example/extension@1.0.0', digest },
    compatibility: { hostApiVersion: 'awo.extension.v1', protocols: [] },
    declaredCapabilities: ['filesystem.read'],
    requestedPermissions: ['shell.execute'],
    dataBoundary: 'local-only',
    resourceBudget: { maxMemoryMb: 64, maxCpuMs: 100, maxStartupMs: 100 },
    at: 1,
  }), /子集/);
  assert.throws(() => registry.discover({
    id: 'invalid.protocol',
    version: '1.0.0',
    kind: 'ui-panel',
    displayName: 'Invalid protocol',
    source: { type: 'npm', locator: 'npm:@example/panel@1.0.0', digest },
    compatibility: { hostApiVersion: 'awo.extension.v1', protocols: ['unversioned'] },
    declaredCapabilities: [],
    requestedPermissions: [],
    dataBoundary: 'local-only',
    resourceBudget: { maxMemoryMb: 64, maxCpuMs: 100, maxStartupMs: 100 },
    at: 1,
  }), /已版本化协议/);
});

test('disable 阻断 activation 候选且 revoked extension 永远不能复活', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  discover(registry);
  registry.review('provider.local', 'local-admin', 110);
  registry.install('provider.local', digest, 'local-admin', 120);
  registry.disable('provider.local', 'local-admin', 130, '暂时停用。');
  assert.equal(registry.eligible().length, 0);
  const installedAgain = registry.install('provider.local', digest, 'local-admin', 140, '重新核验。');
  assert.equal(installedAgain.status, 'installed');
  registry.revoke('provider.local', 'local-admin', 150, '来源被撤销。');
  assert.throws(() => registry.install('provider.local', digest, 'local-admin', 160), /不得变更状态/);
  assert.deepEqual(registry.history('provider.local').map((item) => item.status), [
    'discovered', 'reviewed', 'installed', 'disabled', 'installed', 'revoked',
  ]);
});

test('SQLite extension ledger 追加 revision、提供防御性复制且可重开审查', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-extension-registry-'));
  const filePath = join(directory, 'extensions.sqlite');
  try {
    const store = new SqliteExtensionManifestStore(filePath);
    const registry = new ExtensionRegistry(store);
    discover(registry, 'ui.extension');
    registry.review('ui.extension', 'local-admin', 110);
    registry.install('ui.extension', digest, 'local-admin', 120);
    const copy = registry.get('ui.extension');
    assert.ok(copy);
    (copy!.declaredCapabilities as Capability[]).push('shell.execute');
    assert.deepEqual(registry.get('ui.extension')?.declaredCapabilities, ['model.chat', 'filesystem.read']);
    store.close();

    const reopened = new SqliteExtensionManifestStore(filePath);
    assert.deepEqual(reopened.history('ui.extension').map((item) => item.status), ['discovered', 'reviewed', 'installed']);
    assert.equal(reopened.list()[0]?.source.digest, digest);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
