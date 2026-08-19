import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryProviderProfileStore,
  ModelRouter,
  ProviderProfileRegistry,
  SqliteProviderProfileStore,
  type ChatRequest,
  type ModelCapabilities,
  type ModelDriver,
} from '../src/index.js';

class FakeDriver implements ModelDriver {
  constructor(private readonly driverId: string, private readonly profile: ModelCapabilities) {}

  id(): string { return this.driverId; }
  capabilities(): ModelCapabilities { return this.profile; }
  async *chat(_request: ChatRequest, _apiKey: string): AsyncIterable<string> { yield this.driverId; }
}

function router(): ModelRouter {
  const value = new ModelRouter();
  value.register(new FakeDriver('local-code', {
    contextWindow: 32_000, supportsTools: true, supportsVision: false, isLocal: true, costTier: 'low',
  }));
  value.register(new FakeDriver('remote-code', {
    contextWindow: 128_000, supportsTools: true, supportsVision: true, isLocal: false, costTier: 'high',
  }));
  return value;
}

function register(registry: ProviderProfileRegistry, id = 'local-only'): void {
  registry.register({
    id,
    displayName: '本地编码配置',
    driverIds: ['local-code', 'remote-code'],
    maximumDataBoundary: 'local-only',
    credentialReference: 'keychain.local-profile',
    reviewedBy: 'local-admin',
    note: '仅保存 keychain 引用，不保存 secret。',
    at: 100,
  });
}

test('Provider Profile 默认仅登记；凭据引用保持为 metadata，激活后只能选择 allowlist 内满足本地边界的驱动', () => {
  const registry = new ProviderProfileRegistry(new InMemoryProviderProfileStore());
  register(registry);
  const profile = registry.get('local-only');
  assert.equal(profile?.status, 'registered');
  assert.equal(profile?.credentialReference, 'keychain.local-profile');
  assert.equal(Object.hasOwn(profile ?? {}, 'apiKey'), false);
  assert.equal(Object.hasOwn(profile ?? {}, 'token'), false);
  assert.equal(Object.hasOwn(profile ?? {}, 'password'), false);
  assert.throws(() => registry.route('local-only', { kind: 'code' }, router()), /尚未激活/);

  registry.activate('local-only', 'local-admin', 110);
  const decision = registry.route('local-only', { kind: 'code', needsTools: true }, router());
  assert.equal(decision.selectedDriverId, 'local-code');
  assert.equal(decision.effectiveDataBoundary, 'local-only');
  assert.deepEqual(decision.decision.candidates.map((candidate) => candidate.driverId), ['local-code']);
  assert.match(decision.reason, /Profile local-only@2/);
});

test('Profile 更新、停用、回滚与撤销都是追加 revision，且撤销后不可复活', () => {
  const registry = new ProviderProfileRegistry(new InMemoryProviderProfileStore());
  register(registry);
  registry.activate('local-only', 'local-admin', 110);
  registry.update('local-only', {
    driverIds: ['remote-code'], maximumDataBoundary: 'remote-allowed', clearCredentialReference: true,
    reviewedBy: 'local-admin', at: 120, note: '临时远程配置。',
  });
  assert.equal(registry.get('local-only')?.credentialReference, undefined);
  const rolledBack = registry.rollback('local-only', 2, 'local-admin', 130, '恢复本地配置。');
  assert.deepEqual(rolledBack.driverIds, ['local-code', 'remote-code']);
  assert.equal(rolledBack.maximumDataBoundary, 'local-only');
  assert.equal(rolledBack.status, 'active');
  registry.disable('local-only', 'local-admin', 140);
  assert.throws(() => registry.route('local-only', { kind: 'code' }, router()), /尚未激活/);
  registry.revoke('local-only', 'local-admin', 150);
  assert.throws(() => registry.activate('local-only', 'local-admin', 160), /不得被修改/);
  assert.deepEqual(registry.history('local-only').map((item) => item.status), [
    'registered', 'active', 'active', 'active', 'disabled', 'revoked',
  ]);
});

test('Profile data boundary 只能收紧任务请求，router allowlist 不能被调用方扩展', () => {
  const registry = new ProviderProfileRegistry(new InMemoryProviderProfileStore());
  register(registry);
  registry.activate('local-only', 'local-admin', 110);
  const decision = registry.route('local-only', {
    kind: 'chat', minContextTokens: 4_000, dataBoundary: 'remote-allowed', allowedDriverIds: ['remote-code'],
  }, router());
  assert.equal(decision.effectiveDataBoundary, 'local-only');
  assert.equal(decision.selectedDriverId, 'local-code');
});

test('SQLite Provider Profile 账本可重开审查，且返回对象不会泄露内部可变 driverIds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-provider-profile-'));
  const filePath = join(directory, 'profiles.sqlite');
  try {
    const store = new SqliteProviderProfileStore(filePath);
    const registry = new ProviderProfileRegistry(store);
    register(registry, 'sqlite-local');
    registry.activate('sqlite-local', 'local-admin', 110);
    const copy = registry.get('sqlite-local');
    assert.ok(copy);
    (copy!.driverIds as string[]).push('unexpected');
    assert.deepEqual(registry.get('sqlite-local')?.driverIds, ['local-code', 'remote-code']);
    store.close();

    const reopened = new SqliteProviderProfileStore(filePath);
    assert.deepEqual(reopened.history('sqlite-local').map((item) => item.status), ['registered', 'active']);
    assert.equal(reopened.load('sqlite-local')?.credentialReference, 'keychain.local-profile');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
