import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_COMPANION_STUDIO_PREFERENCES, parseCompanionStudioPreferences, updateCompanionStudioPreferences } from '../src/runtime/companion-studio-preferences.js';

test('Companion Studio 默认登记 AIRI 风格服务来源、机体模块和 Live2D/VRM 插槽，但不存储秘密或运行权限', () => {
  assert.deepEqual(DEFAULT_COMPANION_STUDIO_PREFERENCES.services, { chat: true, speech: true, transcription: true, artistry: true });
  assert.deepEqual(DEFAULT_COMPANION_STUDIO_PREFERENCES.modules, { consciousness: true, voice: true, hearing: true, vision: true, memory: true, discord: true, minecraft: true, factorio: true, mcp: true });
  assert.deepEqual(DEFAULT_COMPANION_STUDIO_PREFERENCES.modelSlots, { live2d: true, vrm: true });
  assert.equal(DEFAULT_COMPANION_STUDIO_PREFERENCES.desktopResidencyMode, 'disabled');
  assert.equal(JSON.stringify(DEFAULT_COMPANION_STUDIO_PREFERENCES).includes('apiKey'), false);
  assert.equal(JSON.stringify(DEFAULT_COMPANION_STUDIO_PREFERENCES).includes('endpoint'), false);
});

test('Companion Studio 允许在三级页关闭单个服务、机体模块、模型插槽和 Windows 原生桌面角色模式', () => {
  const updated = updateCompanionStudioPreferences(DEFAULT_COMPANION_STUDIO_PREFERENCES, {
    services: { ...DEFAULT_COMPANION_STUDIO_PREFERENCES.services, speech: false },
    modules: { ...DEFAULT_COMPANION_STUDIO_PREFERENCES.modules, discord: false, minecraft: false },
    modelSlots: { live2d: false, vrm: true },
    activeCharacterCardId: 'mori', desktopResidencyMode: 'disabled',
  });
  assert.equal(updated.services.speech, false);
  assert.equal(updated.modules.discord, false);
  assert.equal(updated.modules.minecraft, false);
  assert.equal(updated.modelSlots.live2d, false);
  assert.equal(updated.activeCharacterCardId, 'mori');
  assert.equal(updated.desktopResidencyMode, 'disabled');
});

test('Companion Studio 丢弃未知字段和非法角色卡，且不将外部模块标记为运行已授权', () => {
  const parsed = parseCompanionStudioPreferences({ schemaVersion: 1, services: { chat: false, apiKey: 'must-not-persist' }, modules: { discord: false, gameControl: true }, activeCharacterCardId: 'unknown', desktopResidencyMode: 'remote-control' });
  assert.equal(parsed.services.chat, false);
  assert.equal(parsed.modules.discord, false);
  assert.equal(parsed.activeCharacterCardId, 'orbit');
  assert.equal(parsed.desktopResidencyMode, 'disabled');
  assert.equal(JSON.stringify(parsed).includes('must-not-persist'), false);
  assert.equal('gameControl' in parsed.modules, false);
});
