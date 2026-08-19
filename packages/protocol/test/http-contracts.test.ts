import { strict as assert } from 'node:assert';
import test from 'node:test';
import { decodeTaskSubmitIntentV1 } from '../src/index.js';

test('Task Submit HTTP v1 接受明确版本与已声明 Profile，并将旧客户端安全回退至 review', () => {
  assert.deepEqual(
    decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: '  审查本地项目  ', profileId: 'plan' }),
    { schemaVersion: 1, goal: '审查本地项目', profileId: 'plan', authorityMode: 'review', administratorLease: undefined },
  );
});

test('Task Submit HTTP v1 拒绝版本漂移、隐式字段、无效权限和错配管理员租约', () => {
  assert.throws(() => decodeTaskSubmitIntentV1({ goal: 'missing version', profileId: 'plan' }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 2, goal: 'wrong version', profileId: 'plan' }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'unknown field', profileId: 'plan', canExecute: true }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: ' ', profileId: 'plan' }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'bad profile', profileId: 'operator' }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'admin without lease', profileId: 'build', authorityMode: 'admin' }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'lease on review', profileId: 'build', authorityMode: 'review', administratorLease: { operatorId: 'owner', allowedCapabilities: ['shell.execute'], reason: 'maintenance' } }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'bad lease capability', profileId: 'build', authorityMode: 'admin', administratorLease: { operatorId: 'owner', allowedCapabilities: ['everything'], reason: 'maintenance' } }));
});

test('Task Submit HTTP v1 接受显式自动完成与受限管理员租约申请', () => {
  assert.equal(decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: '自动整理工作区', profileId: 'build', authorityMode: 'automate' }).authorityMode, 'automate');
  const admin = decodeTaskSubmitIntentV1({
    schemaVersion: 1, goal: '维护本地任务', profileId: 'build', authorityMode: 'admin',
    administratorLease: { operatorId: 'owner-local', allowedCapabilities: ['shell.execute', 'filesystem.write'], reason: '本地维护窗口' },
  });
  assert.equal(admin.administratorLease?.reason, '本地维护窗口');
});
