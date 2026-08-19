import { strict as assert } from 'node:assert';
import test from 'node:test';
import { decodeTaskSubmitIntentV1 } from '../src/index.js';

test('Task Submit HTTP v1 接受明确版本与已声明 Profile', () => {
  assert.deepEqual(
    decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: '  审查本地项目  ', profileId: 'plan' }),
    { schemaVersion: 1, goal: '审查本地项目', profileId: 'plan' },
  );
});

test('Task Submit HTTP v1 拒绝版本漂移、隐式字段和无效意图', () => {
  assert.throws(() => decodeTaskSubmitIntentV1({ goal: 'missing version', profileId: 'plan' }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 2, goal: 'wrong version', profileId: 'plan' }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'unknown field', profileId: 'plan', canExecute: true }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: ' ', profileId: 'plan' }));
  assert.throws(() => decodeTaskSubmitIntentV1({ schemaVersion: 1, goal: 'bad profile', profileId: 'operator' }));
});
