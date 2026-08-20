import { strict as assert } from 'node:assert';
import test from 'node:test';
import { decodeTaskSubmitIntentV1 } from '../src/index.js';

test('Task Submit HTTP v1 接受明确版本与已声明 Profile，并将旧客户端安全回退至 review', () => {
  assert.deepEqual(
    decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: '  审查本地项目  ', profileId: 'plan' }),
    { schemaVersion: 1, goal: '审查本地项目', profileId: 'plan', authorityMode: 'review', administratorLease: undefined, inputProvenance: [] },
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
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'fake trusted source', profileId: 'reader', inputProvenance: [{ schemaVersion: 1, inputId: 'fake-1', trust: 'operator-authored', sourceKind: 'operator', contentDigest: 'a'.repeat(64) }] }), /不得自声明/);
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'locator leak', profileId: 'reader', inputProvenance: [{ schemaVersion: 1, inputId: 'web-1', trust: 'external-untrusted', sourceKind: 'web', contentDigest: 'a'.repeat(64), url: 'https://unsafe.invalid' }] }), /受限/);
});

test('Task Submit HTTP v1 接受并稳定归一 external/derived provenance 摘要', () => {
  const decoded = decodeTaskSubmitIntentV1({
    schemaVersion: 1, goal: '总结不可信网页与工具输出', profileId: 'reader',
    inputProvenance: [
      { schemaVersion: 1, inputId: 'tool-1', trust: 'derived-untrusted', sourceKind: 'tool-output', contentDigest: 'b'.repeat(64) },
      { schemaVersion: 1, inputId: 'web-1', trust: 'external-untrusted', sourceKind: 'web', contentDigest: 'a'.repeat(64) },
    ],
  });
  assert.deepEqual(decoded.inputProvenance.map((input) => input.inputId), ['tool-1', 'web-1']);
});

test('Task Submit HTTP v1 接受显式自动完成与受限管理员租约申请', () => {
  assert.equal(decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: '自动整理工作区', profileId: 'build', authorityMode: 'automate' }).authorityMode, 'automate');
  const admin = decodeTaskSubmitIntentV1({
    schemaVersion: 1, goal: '维护本地任务', profileId: 'build', authorityMode: 'admin',
    administratorLease: { operatorId: 'owner-local', allowedCapabilities: ['shell.execute', 'filesystem.write'], reason: '本地维护窗口' },
  });
  assert.equal(admin.administratorLease?.reason, '本地维护窗口');
});
