// 一个文件=一种作用：UI 插件页面注册表的验收测试（逻辑共享键、引用计数、移除清理）。
//
// 引用计数与共享是纯逻辑：用可推进的假时钟 + 计数工厂，不需要浏览器环境。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLUGIN_PAGE_OFFSCREEN_GRACE_MS,
  type ManagedPluginPage,
  type PluginPageTimer,
} from '../src/runtime/zcode/plugin-page-manager';
import { PluginPageRegistry } from '../src/runtime/zcode/plugin-page-registry';

/** 可手动推进的假时钟：timer 注册回调，advance 按时间序触发到期回调。 */
function createClock(): { timer: PluginPageTimer; advance: (ms: number) => void } {
  let now = 0;
  let seq = 0;
  const scheduled: { id: number; at: number; run: () => void }[] = [];
  const timer: PluginPageTimer = (run, ms) => {
    const id = ++seq;
    scheduled.push({ id, at: now + ms, run });
    return () => {
      const index = scheduled.findIndex((entry) => entry.id === id);
      if (index >= 0) scheduled.splice(index, 1);
    };
  };
  const advance = (ms: number): void => {
    now += ms;
    for (;;) {
      const due = scheduled.filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at);
      const next = due[0];
      if (next === undefined) return;
      scheduled.splice(scheduled.indexOf(next), 1);
      next.run();
    }
  };
  return { timer, advance };
}

interface FakePage extends ManagedPluginPage {
  readonly suspendCalls: () => number;
  readonly destroyCalls: () => number;
  setBusy(value: boolean): void;
}

function makePage(key: string, task = key): FakePage {
  let running = true;
  let busy = false;
  let suspendCalls = 0;
  let destroyCalls = 0;
  return {
    key,
    task,
    visible: false,
    busy: () => busy,
    running: () => running,
    suspend: () => {
      suspendCalls += 1;
      running = false;
    },
    destroy: () => {
      destroyCalls += 1;
    },
    suspendCalls: () => suspendCalls,
    destroyCalls: () => destroyCalls,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

test('逻辑共享键：相同 key 的多个使用方共享同一实例，引用计数累加', async () => {
  const clock = createClock();
  const registry = new PluginPageRegistry<FakePage>(clock.timer);
  let created = 0;
  const create = (): FakePage => {
    created += 1;
    return makePage('k', 'task');
  };

  const leaseA = await registry.acquire('k', 'task', create);
  const leaseB = await registry.acquire('k', 'task', create);
  assert.equal(created, 1, '工厂只调用一次');
  assert.equal(leaseA.page, leaseB.page, '两个使用方共享同一页面实例');
  assert.equal(registry.refCount('k'), 2);
});

test('引用计数归零才真正回收：非零期间不启动离屏计时', async () => {
  const clock = createClock();
  const registry = new PluginPageRegistry<FakePage>(clock.timer);
  const leaseA = await registry.acquire('k', 'task', () => makePage('k', 'task'));
  const leaseB = await registry.acquire('k', 'task', () => makePage('k', 'task'));
  const page = leaseA.page;

  leaseA.release();
  assert.equal(registry.refCount('k'), 1);
  clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
  assert.equal(page.suspendCalls(), 0, '仍有使用方时不回收');

  leaseB.release();
  assert.equal(registry.refCount('k'), 0);
  clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
  assert.equal(page.suspendCalls(), 1, '引用归零且宽限到期才回收');
});

test('租约释放幂等：重复 release 不重复扣减引用', async () => {
  const clock = createClock();
  const registry = new PluginPageRegistry<FakePage>(clock.timer);
  const lease = await registry.acquire('k', 'task', () => makePage('k', 'task'));
  lease.release();
  lease.release();
  assert.equal(registry.refCount('k'), 0);
});

test('并发获取去重：同一逻辑键的在途创建只建一个实例', async () => {
  const clock = createClock();
  const registry = new PluginPageRegistry<FakePage>(clock.timer);
  let created = 0;
  const create = (): FakePage => {
    created += 1;
    return makePage('k', 'task');
  };
  const [leaseA, leaseB] = await Promise.all([
    registry.acquire('k', 'task', create),
    registry.acquire('k', 'task', create),
  ]);
  assert.equal(created, 1);
  assert.equal(leaseA.page, leaseB.page);
  assert.equal(registry.refCount('k'), 2);
});

test('页面被移除：清理引用计数、通知回调，再次获取时重建', async () => {
  const clock = createClock();
  const removed: string[] = [];
  const registry = new PluginPageRegistry<FakePage>(clock.timer, { onRemoved: (key) => removed.push(key) });
  let created = 0;
  const create = (): FakePage => {
    created += 1;
    return makePage('k', 'task');
  };

  const lease = await registry.acquire('k', 'task', create);
  const page = lease.page;
  registry.removeTask('task');
  assert.deepEqual(removed, ['k'], '移除回调被触发');
  assert.equal(registry.get('k'), undefined);
  assert.equal(registry.refCount('k'), 0);
  assert.equal(page.destroyCalls(), 1);

  const rebuilt = await registry.acquire('k', 'task', create);
  assert.equal(created, 2, '移除后再次获取会重建');
  assert.notEqual(rebuilt.page, page);
  rebuilt.release();
});

test('容量与空闲确认转发：忙碌保活、空闲后经 settled 回收', async () => {
  const clock = createClock();
  const registry = new PluginPageRegistry<FakePage>(clock.timer);
  const lease = await registry.acquire('k', 'task', () => makePage('k', 'task'));
  const page = lease.page;

  await registry.reserve('k');
  registry.released('k');

  page.setBusy(true);
  registry.setVisibility('k', false);
  clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
  assert.equal(page.suspendCalls(), 0, '忙碌期间不回收');

  page.setBusy(false);
  registry.settled('k');
  assert.equal(page.suspendCalls(), 1, '空闲确认后立即回收');
});

test('页面被移除后 reserve 明确拒绝', async () => {
  const clock = createClock();
  const registry = new PluginPageRegistry<FakePage>(clock.timer);
  await registry.acquire('k', 'task', () => makePage('k', 'task'));
  registry.removeTask('task');
  await assert.rejects(registry.reserve('k'), /removed/);
});
