// 一个文件=一种作用：UI 插件页面管理器的验收测试（离屏回收、容量准入、准入串行、迟到保护）。
//
// 用可推进的假时钟替换真实计时器：计时、容量、串行都是纯逻辑，不需要浏览器环境。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PluginPageManager,
  PLUGIN_PAGE_MAX_LIVE_PAGES,
  PLUGIN_PAGE_MAX_TASKS,
  PLUGIN_PAGE_OFFSCREEN_GRACE_MS,
  type ManagedPluginPage,
  type PluginPageTimer,
} from '../src/runtime/zcode/plugin-page-manager';

/**
 * 受控结算的 Promise。不用 `Promise.withResolvers`：本项目 lib 是 ES2022，
 * 它不在类型清单里——运行时能跑但类型检查看不见，正是这批要堵的洞。
 */
function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

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
  setSuspendResult(value: boolean | Promise<boolean>): void;
  setSuspendImpl(impl: () => boolean | Promise<boolean>): void;
}

function makePage(key: string, task = key): FakePage {
  let running = true;
  let busy = false;
  let suspendCalls = 0;
  let destroyCalls = 0;
  let suspendResult: boolean | Promise<boolean> = true;
  let suspendImpl: (() => boolean | Promise<boolean>) | undefined;
  return {
    key,
    task,
    visible: false,
    busy: () => busy,
    running: () => running,
    suspend: async () => {
      suspendCalls += 1;
      running = false;
      return suspendImpl ? suspendImpl() : suspendResult;
    },
    destroy: () => {
      destroyCalls += 1;
    },
    suspendCalls: () => suspendCalls,
    destroyCalls: () => destroyCalls,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setSuspendResult: (value: boolean | Promise<boolean>) => {
      suspendResult = value;
    },
    setSuspendImpl: (impl: () => boolean | Promise<boolean>) => {
      suspendImpl = impl;
    },
  };
}

function createManager(clock: { timer: PluginPageTimer }): PluginPageManager<FakePage> {
  return new PluginPageManager<FakePage>(clock.timer, () => {});
}

test('离屏回收：连续不可见满宽限期才回收，中途恢复可见会重置计时', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  const page = makePage('page');
  await manager.add(page);

  manager.visibility(page, false);
  clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS - 1);
  assert.equal(page.suspendCalls(), 0, '未满宽限期不回收');

  manager.visibility(page, true);
  clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
  assert.equal(page.suspendCalls(), 0, '恢复可见后计时重置');

  manager.visibility(page, false);
  clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
  assert.equal(page.suspendCalls(), 1, '连续离屏满宽限期回收一次');
});

test('忙碌保活：在途审批/调用期间不回收，空闲确认后立即释放', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  const page = makePage('page');
  await manager.add(page);

  page.setBusy(true);
  manager.visibility(page, false);
  clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
  assert.equal(page.suspendCalls(), 0, '忙碌时不回收');

  page.setBusy(false);
  manager.settled(page);
  assert.equal(page.suspendCalls(), 1, '空闲确认立即回收');
});

test('任务容量：超过上限淘汰最久未用的空闲任务', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  const first = makePage('first');
  await manager.add(first);
  for (let n = 1; n < PLUGIN_PAGE_MAX_TASKS; n += 1) await manager.add(makePage(String(n)));

  await manager.add(makePage('overflow'));
  assert.equal(first.destroyCalls(), 1, '最久未用任务被淘汰');
  assert.equal(manager.get('first'), undefined);
});

test('任务容量：无安全候选时拒绝准入，不淘汰可见任务', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  const first = makePage('first');
  first.setSuspendResult(false);
  await manager.add(first);
  for (let n = 1; n < PLUGIN_PAGE_MAX_TASKS; n += 1) {
    const page = makePage(String(n));
    page.visible = true;
    await manager.add(page);
  }

  await assert.rejects(manager.add(makePage('overflow')), /capacity/);
  assert.equal(first.destroyCalls(), 0, '无法安全回收则不淘汰');
  assert.equal(manager.get('first'), first);
});

test('活页容量：全部可见/忙碌时拒绝准入', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  for (let n = 0; n < PLUGIN_PAGE_MAX_LIVE_PAGES; n += 1) {
    const page = makePage(String(n), 'task');
    page.visible = true;
    await manager.add(page);
    await manager.reserve(page);
  }
  const next = makePage('next', 'task');
  await manager.add(next);
  await assert.rejects(manager.reserve(next), /capacity/);
});

test('准入串行：并发占用沙箱槽位不超过活页上限', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  const pages = Array.from({ length: PLUGIN_PAGE_MAX_LIVE_PAGES + 1 }, (_, index) => makePage(String(index), 'task'));
  for (const page of pages) {
    page.visible = true;
    await manager.add(page);
  }
  const results = await Promise.allSettled(pages.map((page) => manager.reserve(page)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, PLUGIN_PAGE_MAX_LIVE_PAGES);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('迟到保护：过期可见性清理不得改写替换实例', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  const a = makePage('same');
  await manager.add(a);
  manager.removeTask(a.task);
  const b = makePage('same');
  await manager.add(b);
  manager.visibility(b, true);
  manager.visibility(a, false);
  assert.equal(b.visible, true, '旧实例的可见性回调被忽略');
});

test('迟到保护：排队准入在任务删除时被取消', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  const page = makePage('late');
  const pending = manager.add(page);
  manager.removeTask(page.task);
  await assert.rejects(pending, /removed/);
  assert.equal(manager.get(page.key), undefined);
});

test('迟到保护：异步回收期间页面被删除则拒绝占用已撤销槽位', async () => {
  const clock = createClock();
  const manager = createManager(clock);
  const entered = deferred<void>();
  const recycled = deferred<boolean>();
  const first = makePage('first', 'task');
  first.setSuspendImpl(() => {
    entered.resolve(undefined);
    return recycled.promise;
  });
  await manager.add(first);
  await manager.reserve(first);
  for (let n = 1; n < PLUGIN_PAGE_MAX_LIVE_PAGES; n += 1) {
    const page = makePage(String(n), 'task');
    page.visible = true;
    await manager.add(page);
    await manager.reserve(page);
  }
  const next = makePage('next');
  await manager.add(next);
  const pending = manager.reserve(next);
  await entered.promise;
  manager.removeTask(next.task);
  recycled.resolve(true);
  await assert.rejects(pending, /removed/);
});
