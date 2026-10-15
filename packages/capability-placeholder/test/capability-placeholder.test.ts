// 一个文件=一种作用：fail-closed 契约占位包的验收测试。
//
// 断言四件事：① 机器可检的占位标记存在且两处一致；② 全部能力谓词恒 false；
// ③ 运行时全拒（execute 恒 isError、closeSession/dispose 是空操作）；
// ④ 权限端口 fail-closed 且与 agent-runtime 的 PermissionBroker 结构兼容。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CAPABILITY_PLACEHOLDER,
  CAPABILITY_PLACEHOLDER_FIELD,
  CAPABILITY_UNAVAILABLE_TEXT,
  PLACEHOLDER_SURFACES,
  DenyCapabilityPermissionPort,
  canCaptureScreen,
  canControlDesktop,
  canExecuteBrowserActions,
  canReadBrowserSecrets,
  canReadPageContent,
  createComputerUseRuntime,
  unavailableCapabilityFlags,
} from '../src/index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;

/** agent-runtime `permission-broker.ts` 的 PermissionBroker 形状（仅取方法签名）。 */
interface PermissionBrokerLike {
  ask(question: { actionId: string; toolName: string; capability: string; risk: string; reason: string; inputPreview: string }): Promise<boolean>;
}

const context = { sessionId: 'session:test', runtimeScope: 'main', workspaceKey: 'workspace:test' } as const;

test('占位标记：package.json 与运行期常量一致，且本包仍是占位', () => {
  assert.equal(manifest[CAPABILITY_PLACEHOLDER_FIELD], true);
  assert.equal(CAPABILITY_PLACEHOLDER, true);
  assert.equal(manifest[CAPABILITY_PLACEHOLDER_FIELD], CAPABILITY_PLACEHOLDER);
  // 覆盖面清单非空，且每一项都是「未实现」的具名面。
  assert.ok(PLACEHOLDER_SURFACES.length >= 4);
});

test('能力谓词：全部恒 false，绝不为 true', () => {
  for (const predicate of [canExecuteBrowserActions, canReadPageContent, canReadBrowserSecrets, canControlDesktop, canCaptureScreen]) {
    assert.equal(predicate(), false);
  }
});

test('能力位：一次取齐四个 false，且返回值不可被就地篡改影响后续调用', () => {
  const flags = unavailableCapabilityFlags();
  assert.deepEqual(flags, { canExecute: false, canReadPageContent: false, canReadBrowserSecrets: false, canControlDesktop: false });

  // 尝试就地改写：后续调用必须仍是全新对象、四个 false。
  (flags as { canExecute: boolean }).canExecute = true;
  const fresh = unavailableCapabilityFlags();
  assert.equal(fresh.canExecute, false);
  assert.notEqual(fresh, flags);
});

test('计算机使用运行时：execute 恒报告 unavailable（isError: true，不抛错）', async () => {
  const runtime = createComputerUseRuntime();
  const result = await runtime.execute({ toolName: 'computer_use', context });

  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  assert.equal(result.content[0]?.text, CAPABILITY_UNAVAILABLE_TEXT);
  assert.match(result.content[0]?.text ?? '', /unavailable/u);

  // 选项被忽略：装配任何选项都不改变全拒行为。
  const withOptions = createComputerUseRuntime({ brokerSocketPath: '/tmp/does-not-exist.sock' });
  assert.equal((await withOptions.execute({ toolName: 'computer_use', context })).isError, true);
});

test('计算机使用运行时：closeSession / dispose 是空操作（不抛错、不假装成功）', async () => {
  const runtime = createComputerUseRuntime();
  assert.equal(await runtime.closeSession(context), undefined);
  assert.equal(await runtime.dispose(), undefined);
});

test('权限端口：一切裁决以拒绝收尾，且与 PermissionBroker 结构兼容', async () => {
  const port = new DenyCapabilityPermissionPort();
  assert.equal(await port.ask({ actionId: 'action:1', toolName: 'computer_use', reason: '请求桌面控制' }), false);
  assert.equal(await port.ask({ actionId: 'action:2', toolName: 'screen_capture', reason: '请求截屏' }), false);

  // 结构兼容：可被 agent-runtime 的 PermissionBroker 位置消费（同一 fail-closed 纪律）。
  const brokerLike: PermissionBrokerLike = port;
  assert.equal(await brokerLike.ask({ actionId: 'action:3', toolName: 'computer_use', capability: 'desktop.control', risk: 'high', reason: 'r', inputPreview: 'p' }), false);
});
