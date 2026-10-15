// 一个文件=一种作用：Gen UI guest 运行时脚本（沙箱内 window.zcode / Tweak）的验收测试。
//
// 测试手段：脚本是自包含 IIFE，用 `new Function('window','document','CustomEvent', src)`
// 在受控的假 window/document 上求值，断言它安装的 API 形状与发出的 postMessage 载荷。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGenUiGuestRuntimeScript,
  injectGenUiGuestRuntime,
  injectGenUiInitialState,
  GEN_UI_GUEST_RUNTIME_MARKER,
  GEN_UI_INITIAL_STATE_ELEMENT_ID,
} from '../src/gen-ui/guest-runtime';

interface FakeWindow {
  readonly parent: { postMessage(message: unknown): void };
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
  dispatchEvent(event: { type: string; detail?: unknown }): void;
  zcode?: {
    readonly widgetState: unknown;
    setWidgetState(value: unknown): Promise<unknown>;
    sendFollowUpMessage(value: unknown): Promise<unknown>;
    onContext(listener: (globals: unknown) => void): () => void;
  };
  Tweak?: new (options: { container: unknown; onChange?: () => void }) => { addSlider(object: Record<string, unknown>, property: string, options: Record<string, unknown>): unknown; dispose(): void };
}

function createEnvironment() {
  const posted: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const dispatch = (event: { type: string; detail?: unknown; source?: unknown; data?: unknown }): void => {
    for (const handler of listeners.get(event.type) ?? []) handler(event);
  };
  const parent = {
    postMessage(message: unknown): void {
      const record = message as Record<string, unknown>;
      posted.push(record);
      // 自动回执，让 guest 的 request Promise 得以完成；Tweak 请求回显被采纳的控件。
      const params = record.params as { annotationControls?: unknown } | undefined;
      const result = record.method === 'zcode/gen-ui/tweak' && params?.annotationControls !== undefined ? { annotationControls: params.annotationControls } : {};
      queueMicrotask(() => dispatch({ type: 'message', source: parent, data: { jsonrpc: '2.0', id: record.id, result } }));
    },
  };
  const documentElement = { dataset: {} as Record<string, string>, style: { colorScheme: '', setProperty: (): void => undefined } };
  const win = {
    parent,
    addEventListener(type: string, handler: (event: unknown) => void): void {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener(type: string, handler: (event: unknown) => void): void {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event: { type: string; detail?: unknown }): void {
      dispatch(event);
    },
  } as unknown as FakeWindow;
  const doc = { getElementById: (): unknown => null, documentElement };
  const source = buildGenUiGuestRuntimeScript();
  const factory = new Function('window', 'document', 'CustomEvent', source) as (w: unknown, d: unknown, c: unknown) => void;
  factory(win, doc, CustomEvent);
  return { win, doc, posted, dispatch, parent };
}

test('guest 运行时脚本语法有效且安装 window.zcode', () => {
  const source = buildGenUiGuestRuntimeScript();
  assert.doesNotThrow(() => new Function(source));
  const { win } = createEnvironment();
  assert.equal(typeof win.zcode?.setWidgetState, 'function');
  assert.equal(typeof win.zcode?.sendFollowUpMessage, 'function');
  assert.equal(win.zcode?.widgetState, null);
  assert.equal(typeof win.Tweak, 'function');
});

test('setWidgetState 归一化并发出 zcode/gen-ui/state 请求', async () => {
  const { win, posted } = createEnvironment();
  await win.zcode?.setWidgetState({ modelContent: { a: 1 } });
  const request = posted.find((message) => message.method === 'zcode/gen-ui/state');
  assert.ok(request);
  assert.deepEqual(request?.params, { state: { modelContent: { a: 1 }, privateContent: null } });
  assert.throws(() => win.zcode?.setWidgetState({ nope: 1 }), /Unknown widget state key/);
});

test('sendFollowUpMessage 校验并发出 zcode/gen-ui/follow-up 请求', async () => {
  const { win, posted } = createEnvironment();
  await win.zcode?.sendFollowUpMessage({ prompt: '  继续  ', title: '卡片' });
  const request = posted.find((message) => message.method === 'zcode/gen-ui/follow-up');
  assert.deepEqual(request?.params, { prompt: '继续', title: '卡片' });
  await assert.rejects(async () => win.zcode?.sendFollowUpMessage({ prompt: '   ' }));
});

test('上下文通知更新 widgetState 并派发 zcode:set_globals', () => {
  const { win, dispatch, parent } = createEnvironment();
  const seen: unknown[] = [];
  win.zcode?.onContext((globals) => seen.push(globals));
  dispatch({
    type: 'message',
    source: parent,
    data: { jsonrpc: '2.0', method: 'zcode/gen-ui/context', params: { widgetState: { modelContent: { m: 1 }, privateContent: null }, theme: 'dark', visualizationAnnotation: null } },
  });
  assert.deepEqual(win.zcode?.widgetState, { modelContent: { m: 1 }, privateContent: null });
  assert.equal(seen.length, 1);
  assert.deepEqual((seen[0] as { widgetState: unknown }).widgetState, { modelContent: { m: 1 }, privateContent: null });
});

test('Tweak 绑定登记为 register 消息，dispose 发出注销', async () => {
  const { win, posted } = createEnvironment();
  const container = {
    id: 'card',
    localName: 'section',
    isConnected: true,
    getAttribute: (name: string): string | null => (name === 'aria-label' ? '卡片' : null),
    getBoundingClientRect: (): { x: number; y: number; width: number; height: number } => ({ x: 0, y: 0, width: 100, height: 50 }),
  };
  const design = { glow: 50 };
  const tweak = new win.Tweak!({ container });
  tweak.addSlider(design, 'glow', { min: 0, max: 100, step: 5, label: '光晕' });
  await Promise.resolve();
  await Promise.resolve();
  const register = posted.find((message) => message.method === 'zcode/gen-ui/tweak' && message.params !== undefined && (message.params as { type?: string }).type === 'register');
  assert.ok(register, '应发出 register 消息');
  const params = register?.params as { annotationControls: { controls: Array<{ callback: string; type: string; min: number; max: number }> }; targets: Array<{ id: string; label: string }> };
  assert.equal(params.annotationControls.controls.length, 1);
  assert.equal(params.annotationControls.controls[0]?.type, 'range');
  assert.equal(params.targets[0]?.label, '卡片');
  tweak.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(posted.some((message) => message.method === 'zcode/gen-ui/tweak' && (message.params as { type?: string }).type === 'dispose'));
});

test('注入器：替换运行时槽位、内联初始状态并转义脚本闭合', () => {
  const withMarker = `<html><head>${GEN_UI_GUEST_RUNTIME_MARKER}</head><body></body></html>`;
  const injected = injectGenUiGuestRuntime(withMarker);
  assert.doesNotMatch(injected, new RegExp(GEN_UI_GUEST_RUNTIME_MARKER));
  assert.match(injected, /<script>/);
  assert.equal(injected.match(/<\/script>/g)?.length, 1);

  const withoutMarker = injectGenUiGuestRuntime('<html><head></head><body></body></html>');
  assert.match(withoutMarker, /<script>[\s\S]*<\/head>/);

  const withState = injectGenUiInitialState('<html><head></head></html>', { modelContent: { a: 1 }, privateContent: null });
  assert.match(withState, new RegExp(`id="${GEN_UI_INITIAL_STATE_ELEMENT_ID}"`));
  assert.match(withState, /"modelContent":\{"a":1\}/);
});
