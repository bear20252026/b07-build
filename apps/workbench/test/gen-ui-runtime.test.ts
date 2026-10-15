// 一个文件=一种作用：Gen UI 工作台侧运行时（状态存储 / Tweak 注册表 / 宿主桥分发器）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { GenUiStateStore } from '../src/runtime/gen-ui/gen-ui-state-store.js';
import { GenUiTweakRegistry } from '../src/runtime/gen-ui/gen-ui-tweak-registry.js';
import { createGenUiBridgeHost } from '../src/runtime/gen-ui/gen-ui-bridge-host.js';
import type { GenUiAnnotationControl } from '@awo/protocol';

const target = { workspacePath: '/project', sessionId: 'session', path: '/project/example.html' };

test('状态存储：按 (workspace, session, path) 隔离，非法状态整体拒绝', () => {
  const store = new GenUiStateStore();
  const changes: string[] = [];
  const subscription = store.onStateChanged(() => changes.push('changed'));

  assert.equal(store.set(target, { modelContent: { a: 1 } }) !== undefined, true);
  assert.deepEqual(store.get(target), { modelContent: { a: 1 }, privateContent: null });
  assert.equal(changes.length, 1);

  // 非法状态不落库、不广播、不覆盖已有值。
  assert.equal(store.set(target, { bad: 1 }), undefined);
  assert.equal(changes.length, 1);
  assert.deepEqual(store.get(target), { modelContent: { a: 1 }, privateContent: null });

  // 不同会话/工作区不串扰。
  assert.equal(store.get({ ...target, sessionId: 'other' }), null);
  assert.equal(store.get({ ...target, workspaceIdentity: 'remote' }), null);

  assert.match(store.modelContext(), /"a":1/);
  store.clear(target);
  assert.equal(store.get(target), null);
  assert.equal(store.modelContext(), '');
  assert.equal(changes.length, 2);
  subscription.dispose();
});

const rangeControl: GenUiAnnotationControl = { callback: 'tweak-1-1', label: '光晕', type: 'range', currentValue: 50, min: 0, max: 100, step: 5 };
const tweakTarget = { id: 'card', label: '卡片', selector: '#card', tagName: 'section', rect: { x: 0, y: 0, width: 100, height: 50 } };

test('Tweak 注册表：登记分组、回显控件、拒绝越界值', () => {
  const registry = new GenUiTweakRegistry();
  const result = registry.handle({
    type: 'register',
    registrationId: 'tweak-1',
    annotationControls: { controlsMode: 'replace', controls: [rangeControl] },
    targets: [tweakTarget],
  });
  assert.equal(result.annotationControls?.controls.length, 1);
  assert.equal(registry.groups().length, 1);
  assert.equal(registry.groups()[0]?.title, '卡片');
  assert.deepEqual(registry.values(), { 'tweak-1-1': 50 });

  assert.equal(registry.setValue('tweak-1-1', 70), true);
  assert.equal(registry.setValue('tweak-1-1', 200), false);
  assert.equal(registry.setValue('missing', 1), false);
  assert.deepEqual(registry.values(), { 'tweak-1-1': 70 });
});

test('Tweak 标注：只回传已改动控件，dispose 后清空', () => {
  const registry = new GenUiTweakRegistry();
  registry.handle({ type: 'register', registrationId: 'tweak-1', annotationControls: { controlsMode: 'replace', controls: [rangeControl] }, targets: [tweakTarget] });
  assert.deepEqual(registry.annotation().changes, []);
  registry.setValue('tweak-1-1', 70);
  const annotation = registry.annotation();
  assert.equal(annotation.active, true);
  assert.deepEqual(annotation.changes[0]?.annotationControlChanges, [{ callback: 'tweak-1-1', previousValue: 50, value: 70 }]);

  registry.handle({ type: 'select', registrationId: 'tweak-1', targetId: 'card' });
  assert.deepEqual(registry.currentSelection(), { registrationId: 'tweak-1', targetId: 'card' });
  registry.handle({ type: 'escape' });
  assert.equal(registry.currentSelection(), null);

  registry.handle({ type: 'dispose', registrationId: 'tweak-1' });
  assert.equal(registry.groups().length, 0);
  assert.deepEqual(registry.values(), {});
  assert.equal(registry.annotation().active, false);
});

test('宿主桥分发器：四个方法分发到处理器并按 JSON-RPC 应答', async () => {
  const seen: string[] = [];
  const bridge = createGenUiBridgeHost({
    onSetState: (state) => {
      seen.push(`state:${JSON.stringify(state.modelContent)}`);
    },
    onFollowUp: (prompt, title) => {
      seen.push(`followUp:${prompt}:${title ?? ''}`);
    },
    onTweak: () => ({ annotationControls: { controlsMode: 'replace', controls: [rangeControl] } }),
    onPresentation: (event) => {
      seen.push(`presentation:${String(event.hovered)}:${String(event.escape)}`);
    },
    onViolation: (reason) => {
      seen.push(`violation:${reason}`);
    },
  });

  const stateOutcome = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'zcode/gen-ui/state', params: { state: { modelContent: { a: 1 } } } });
  assert.equal(stateOutcome.kind, 'response');
  if (stateOutcome.kind === 'response') assert.deepEqual(stateOutcome.message, { jsonrpc: '2.0', id: 1, result: {} });

  await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'zcode/gen-ui/follow-up', params: { prompt: 'go' } });
  const tweakOutcome = await bridge.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'zcode/gen-ui/tweak',
    params: { type: 'register', registrationId: 'tweak-1', annotationControls: { controlsMode: 'replace', controls: [rangeControl] }, targets: [tweakTarget] },
  });
  assert.equal(tweakOutcome.kind, 'response');
  if (tweakOutcome.kind === 'response') {
    const result = (tweakOutcome.message as { result?: { annotationControls?: unknown } }).result;
    assert.ok(result?.annotationControls);
  }
  await bridge.handle({ jsonrpc: '2.0', id: 4, method: 'zcode/gen-ui/presentation', params: { hovered: true } });

  assert.deepEqual(seen, ['state:{"a":1}', 'followUp:go:', 'presentation:true:undefined']);

  // 非 JSON-RPC 噪声静默忽略；违规方法带错误码应答。
  assert.deepEqual(await bridge.handle({ hello: 'world' }), { kind: 'ignored' });
  const violation = await bridge.handle({ jsonrpc: '2.0', id: 9, method: 'zcode/gen-ui/nope', params: {} });
  assert.equal(violation.kind, 'violation');
  if (violation.kind === 'violation') assert.equal((violation.message as { error?: { code?: number } }).error?.code, -32601);
});

test('宿主桥分发器：处理器抛错时以 internalError 应答而不是崩栈', async () => {
  const bridge = createGenUiBridgeHost({
    onSetState: () => {
      throw new Error('state-store-offline');
    },
    onFollowUp: () => undefined,
    onTweak: () => ({}),
  });
  const outcome = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'zcode/gen-ui/state', params: { state: { modelContent: null } } });
  assert.equal(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    const error = (outcome.message as { error?: { code?: number; message?: string } }).error;
    assert.equal(error?.code, -32603);
    assert.equal(error?.message, 'state-store-offline');
  }
});
