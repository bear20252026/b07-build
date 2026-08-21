import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKBENCH_PROFILE_IDS } from '../src/components/workspace/agent-profiles.js';

test('Workbench 只渲染四个明确声明的用户 Profile，不从 i18n 对象键名推导', () => {
  assert.deepEqual(WORKBENCH_PROFILE_IDS, ['build', 'plan', 'explore', 'reader']);
  assert.equal(WORKBENCH_PROFILE_IDS.includes('admin' as never), false);
  assert.equal(WORKBENCH_PROFILE_IDS.includes('selectAria' as never), false);
});
