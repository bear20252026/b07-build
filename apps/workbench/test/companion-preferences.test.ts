import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_COMPANION_PREFERENCES,
  loadCompanionPreferences,
  parseCompanionPreferences,
  saveCompanionPreferences,
  updateCompanionPreferences,
} from '../src/runtime/companion-preferences.js';

test('Companion 默认启用 3D 视觉，但语音和所有高影响能力默认关闭', () => {
  assert.equal(DEFAULT_COMPANION_PREFERENCES.visualEnabled, true);
  assert.equal(DEFAULT_COMPANION_PREFERENCES.visualMode, 'three-dimensional');
  assert.equal(DEFAULT_COMPANION_PREFERENCES.voiceEnabled, false);
  assert.equal(DEFAULT_COMPANION_PREFERENCES.microphoneEnabled, false);
  assert.equal(DEFAULT_COMPANION_PREFERENCES.screenCaptureEnabled, false);
  assert.equal(DEFAULT_COMPANION_PREFERENCES.desktopAutomationEnabled, false);
  assert.equal(DEFAULT_COMPANION_PREFERENCES.gameControlEnabled, false);
  assert.equal(DEFAULT_COMPANION_PREFERENCES.backgroundServiceEnabled, false);
});

test('关闭角色会同时关闭语音与主动提示，但不会生成任何高影响授权', () => {
  const voiced = updateCompanionPreferences(DEFAULT_COMPANION_PREFERENCES, { voiceEnabled: true, proactiveSpeechEnabled: true });
  assert.equal(voiced.voiceEnabled, true);
  assert.equal(voiced.proactiveSpeechEnabled, true);
  const disabled = updateCompanionPreferences(voiced, { visualEnabled: false });
  assert.equal(disabled.visualEnabled, false);
  assert.equal(disabled.voiceEnabled, false);
  assert.equal(disabled.proactiveSpeechEnabled, false);
  assert.equal(disabled.microphoneEnabled, false);
  assert.equal(disabled.desktopAutomationEnabled, false);
});

test('解析未知或高影响字段时固定拒绝为关闭状态', () => {
  const parsed = parseCompanionPreferences({
    schemaVersion: 1,
    visualEnabled: true,
    visualMode: 'three-dimensional',
    voiceEnabled: true,
    proactiveSpeechEnabled: true,
    microphoneEnabled: true,
    screenCaptureEnabled: true,
    desktopAutomationEnabled: true,
    gameControlEnabled: true,
    backgroundServiceEnabled: true,
    apiKey: 'must-not-persist',
  });
  assert.equal(parsed.voiceEnabled, true);
  assert.equal(parsed.microphoneEnabled, false);
  assert.equal(parsed.screenCaptureEnabled, false);
  assert.equal(parsed.desktopAutomationEnabled, false);
  assert.equal(parsed.gameControlEnabled, false);
  assert.equal(parsed.backgroundServiceEnabled, false);
  assert.deepEqual(Object.keys(parsed).sort(), ['backgroundServiceEnabled', 'desktopAutomationEnabled', 'gameControlEnabled', 'microphoneEnabled', 'proactiveSpeechEnabled', 'schemaVersion', 'screenCaptureEnabled', 'ttsProvider', 'visualEnabled', 'visualMode', 'voiceEnabled']);
});

test('偏好只保存无秘密设置，损坏数据安全回退到默认状态', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  const saved = updateCompanionPreferences(DEFAULT_COMPANION_PREFERENCES, { visualMode: 'two-dimensional' });
  saveCompanionPreferences(saved, storage);
  assert.deepEqual(loadCompanionPreferences(storage), saved);
  values.set('awo.companion.preferences.v1', '{invalid-json');
  assert.deepEqual(loadCompanionPreferences(storage), DEFAULT_COMPANION_PREFERENCES);
});
