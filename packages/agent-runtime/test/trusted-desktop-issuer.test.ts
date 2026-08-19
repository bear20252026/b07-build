import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AdministratorAuthorityLedger,
  InMemoryAdministratorLeaseStore,
  InMemoryTrustedDesktopIssuerStore,
  TrustedDesktopIssuerRegistry,
  TrustedDesktopLeaseIssuer,
} from '../src/index.js';

const digest = createHash('sha256').update('native confirmation').digest('hex');

function setup(now = 10_000) {
  const issuers = new TrustedDesktopIssuerRegistry(new InMemoryTrustedDesktopIssuerStore());
  const ledger = new AdministratorAuthorityLedger(new InMemoryAdministratorLeaseStore(), () => now);
  return { issuers, issuer: new TrustedDesktopLeaseIssuer(issuers, ledger, () => now), ledger };
}

function request() {
  return {
    issuerId: 'desktop-host-1', leaseId: 'lease-native-1', operatorId: 'owner-local', taskId: 'task-native-1', runId: 'run-native-1',
    allowedCapabilities: ['filesystem.write'] as const, reasonDigest: digest, issuedAt: 10_000, expiresAt: 70_000,
  };
}

test('可信桌面签发器在 issuer 已显式受信且 capability ceiling 匹配时才创建管理员租约', () => {
  const { issuers, issuer, ledger } = setup();
  issuers.register({ issuerId: 'desktop-host-1', displayName: 'Local Native Host', platform: 'windows', at: 9_000 });
  assert.throws(() => issuer.issue(request(), ['filesystem.write']), /未登记、未验证/);
  issuers.setStatus('desktop-host-1', 'trusted', 9_001);
  const lease = issuer.issue(request(), ['filesystem.read', 'filesystem.write']);
  assert.equal(lease.status, 'active');
  assert.equal(ledger.get('lease-native-1')?.operatorId, 'owner-local');
  assert.equal(lease.canOverrideDeny, false);
  assert.equal(lease.canReadSecrets, false);
});

test('可信桌面签发器拒绝越界 capability、过时请求、已停用或撤销 issuer', () => {
  const { issuers, issuer } = setup();
  issuers.register({ issuerId: 'desktop-host-1', displayName: 'Local Native Host', platform: 'macos', at: 9_000 });
  issuers.setStatus('desktop-host-1', 'trusted', 9_001);
  assert.throws(() => issuer.issue(request(), ['filesystem.read']), /capability ceiling/);
  assert.throws(() => issuer.issue({ ...request(), issuedAt: 70_001, expiresAt: 130_001 }, ['filesystem.write']), /时间偏差/);
  issuers.setStatus('desktop-host-1', 'disabled', 9_002);
  assert.throws(() => issuer.issue(request(), ['filesystem.write']), /未登记、未验证/);
  issuers.setStatus('desktop-host-1', 'revoked', 9_003);
  assert.throws(() => issuers.setStatus('desktop-host-1', 'trusted', 9_004), /已撤销/);
});

test('issuer registry 仅保存不可执行 host metadata 并防御调用方变异', () => {
  const { issuers } = setup();
  const registered = issuers.register({ issuerId: 'desktop-host-1', displayName: 'Local Native Host', platform: 'linux', at: 9_000 });
  assert.equal(registered.canExecute, false);
  assert.equal(registered.canAuthenticateRenderer, false);
  const view = issuers.get('desktop-host-1');
  if (!view) throw new Error('expected registered issuer');
  (view as { displayName: string }).displayName = 'mutated';
  assert.equal(issuers.get('desktop-host-1')?.displayName, 'Local Native Host');
});
