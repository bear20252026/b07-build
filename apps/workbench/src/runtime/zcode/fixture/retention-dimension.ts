// 一个文件=一种作用：retention 维度不变式夹具（离屏回收 / 容量准入 / 忙碌保活）。
//
// 上游出处：ZCode `packages/desktop/scripts/mcp-apps-host-fixture/retention-main.ts`
// 与 `retention-renderer.ts`（Apache-2.0）。上游用真实 Electron BrowserWindow + webview
// 驱动 64 个 guest、30 个任务与假时钟推进；b07 没有 Electron 驱动，故只移植**不变式本身**，
// 跑在 b07 原生模块 `PluginPageManager` / `PluginPageRegistry` 上（它们本就是这一层的纯逻辑实现）。
//
// 读清楚的不变式（逐条来自上游源码，措辞已按 b07 语义改写）：
// 1. 离屏回收是**连续计时**：页面不可见满宽限期（5 分钟）才 suspend；中途恢复可见即取消计时，
//    再次离屏重新计满（上游 `advance(299999)`→可见→`advance(600000)` 不回收）。
// 2. 忙碌保活：有在途工具/资源流（busy）时，即使宽限到期也不回收；忙碌结束后由空闲确认
//    立即回收（上游 managed-checks「all anchors unmounted plus expired retention keeps
//    running tool ... until completion」）。
// 3. 活页容量 64：满额时先回收一个**空闲**页腾位；全部可见/忙碌则拒绝准入（绝不静默超发）。
// 4. 任务容量 30：超限时淘汰**最久未用且可安全回收**的任务；忙碌任务不得被淘汰。
// 5. 清空：窗口卸载时页面、计时器一并释放，不残留离屏计时。
// 6. 注册表引用计数：引用非零期间页面保持可见（不启动回收计时），归零才转离屏并计宽限期。

import {
  PLUGIN_PAGE_MAX_LIVE_PAGES,
  PLUGIN_PAGE_MAX_TASKS,
  PLUGIN_PAGE_OFFSCREEN_GRACE_MS,
  PluginPageManager,
  type ManagedPluginPage,
  type PluginPageTimer,
} from '../plugin-page-manager';
import { PluginPageRegistry } from '../plugin-page-registry';
import {
  expect,
  expectEqual,
  type McpAppFixtureCheck,
  type McpAppFixtureDimension,
} from './dimension-report';

/** 可手动推进的假时钟：与上游夹具的 `advance(ms)` 同一语义（不 sleep，确定性）。 */
function createClock(): { timer: PluginPageTimer; advance: (ms: number) => void } {
  let now = 0;
  let seq = 0;
  const scheduled: { id: number; at: number; run: () => void }[] = [];
  const timer: PluginPageTimer = (run, ms) => {
    const id = (seq += 1);
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

/**
 * 夹具页面：实现 b07 的 `ManagedPluginPage` 契约（管理器只依赖这个契约，不碰宿主实现）。
 * 显式计数 suspend/destroy，便于把「是否回收」写成可读断言。
 */
class FixturePage implements ManagedPluginPage {
  readonly key: string;
  readonly task: string;
  visible = false;
  suspendCalls = 0;
  destroyCalls = 0;
  private busyFlag = false;
  private active = true;

  constructor(key: string, task: string = key) {
    this.key = key;
    this.task = task;
  }

  busy(): boolean {
    return this.busyFlag;
  }

  running(): boolean {
    return this.active;
  }

  /** 契约允许 `void | Promise<boolean | void>`；夹具恒为「可安全回收」（返回 true）。 */
  suspend(): Promise<boolean> {
    this.suspendCalls += 1;
    this.active = false;
    return Promise.resolve(true);
  }

  destroy(): void {
    this.destroyCalls += 1;
  }

  setBusy(value: boolean): void {
    this.busyFlag = value;
  }
}

const checks: readonly McpAppFixtureCheck[] = [
  {
    name: '离屏宽限期：连续不可见满 5 分钟才回收，中途恢复可见即重置计时',
    run: async () => {
      const clock = createClock();
      const manager = new PluginPageManager<FixturePage>(clock.timer, () => {});
      const page = new FixturePage('page');
      await manager.add(page);

      manager.visibility(page, false);
      clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS - 1);
      expectEqual(page.suspendCalls, 0, '未满宽限期不得回收');

      manager.visibility(page, true);
      clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
      expectEqual(page.suspendCalls, 0, '恢复可见必须重置计时');

      manager.visibility(page, false);
      clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
      expectEqual(page.suspendCalls, 1, '连续离屏满宽限期必须回收一次');
    },
  },
  {
    name: '忙碌保活：在途工具/资源流期间即使宽限到期也不回收，忙碌结束后空闲确认立即回收',
    run: async () => {
      const clock = createClock();
      const manager = new PluginPageManager<FixturePage>(clock.timer, () => {});
      const page = new FixturePage('busy');
      await manager.add(page);

      page.setBusy(true);
      manager.visibility(page, false);
      clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS * 2);
      expectEqual(page.suspendCalls, 0, '忙碌期间宽限到期也不得回收');

      page.setBusy(false);
      manager.settled(page);
      expectEqual(page.suspendCalls, 1, '忙碌结束后的空闲确认必须立即回收');
    },
  },
  {
    name: '活页容量 64：满额时回收一个空闲页腾位（新准入不得被误拒）',
    run: async () => {
      const clock = createClock();
      const manager = new PluginPageManager<FixturePage>(clock.timer, () => {});
      const first = new FixturePage('cap-0', 'capacity');
      await manager.add(first);
      await manager.reserve(first);
      for (let n = 1; n < PLUGIN_PAGE_MAX_LIVE_PAGES; n += 1) {
        const page = new FixturePage(`cap-${n}`, 'capacity');
        await manager.add(page);
        await manager.reserve(page);
      }

      const overflow = new FixturePage('cap-overflow', 'capacity');
      await manager.add(overflow);
      await manager.reserve(overflow);
      expectEqual(first.suspendCalls, 1, '容量满时必须回收一个空闲页腾位');
      expectEqual(first.running(), false, '被腾位的页面必须已停止运行');
    },
  },
  {
    name: '活页容量：全部可见/忙碌时拒绝准入（绝不静默超发）',
    run: async () => {
      const clock = createClock();
      const manager = new PluginPageManager<FixturePage>(clock.timer, () => {});
      for (let n = 0; n < PLUGIN_PAGE_MAX_LIVE_PAGES; n += 1) {
        const page = new FixturePage(`vis-${n}`, 'capacity');
        page.visible = true;
        await manager.add(page);
        await manager.reserve(page);
      }

      const overflow = new FixturePage('vis-overflow', 'capacity');
      await manager.add(overflow);
      let rejected = false;
      try {
        await manager.reserve(overflow);
      } catch {
        rejected = true;
      }
      expect(rejected, '全部可见时新准入必须被拒绝，而不是回收可见页');
    },
  },
  {
    name: '任务容量 30：超限淘汰最久未用的空闲任务，忙碌任务必须保留',
    run: async () => {
      const clock = createClock();
      const manager = new PluginPageManager<FixturePage>(clock.timer, () => {});
      const pages: FixturePage[] = [];
      for (let n = 0; n < PLUGIN_PAGE_MAX_TASKS; n += 1) {
        const page = new FixturePage(`task-${n}`, `task-${n}`);
        await manager.add(page);
        pages.push(page);
      }

      pages[0].setBusy(true);
      const overflow = new FixturePage('task-overflow', 'task-overflow');
      await manager.add(overflow);
      expectEqual(pages[0].destroyCalls, 0, '忙碌任务不得被淘汰');
      expectEqual(manager.get('task-0'), pages[0], '忙碌任务必须保留在管理器中');
      expectEqual(pages[1].destroyCalls, 1, '最久未用的空闲任务必须被淘汰');
      expectEqual(manager.get('task-1'), undefined, '被淘汰任务必须移出管理器');
    },
  },
  {
    name: '任务容量：无安全候选时拒绝准入，可见任务不得被淘汰',
    run: async () => {
      const clock = createClock();
      const manager = new PluginPageManager<FixturePage>(clock.timer, () => {});
      const first = new FixturePage('full-0', 'full-0');
      first.visible = true;
      await manager.add(first);
      for (let n = 1; n < PLUGIN_PAGE_MAX_TASKS; n += 1) {
        const page = new FixturePage(`full-${n}`, `full-${n}`);
        page.visible = true;
        await manager.add(page);
      }

      const overflow = new FixturePage('full-overflow', 'full-overflow');
      let rejected = false;
      try {
        await manager.add(overflow);
      } catch {
        rejected = true;
      }
      expect(rejected, '无安全候选时必须拒绝准入');
      expectEqual(manager.get('full-0'), first, '可见任务不得被淘汰');
    },
  },
  {
    name: '清空：窗口卸载后页面与离屏计时一并释放，不残留回收计时',
    run: async () => {
      const clock = createClock();
      const manager = new PluginPageManager<FixturePage>(clock.timer, () => {});
      const pages: FixturePage[] = [];
      for (let n = 0; n < 5; n += 1) {
        const page = new FixturePage(`clear-${n}`, 'clear');
        await manager.add(page);
        await manager.reserve(page);
        manager.visibility(page, false);
        pages.push(page);
      }

      manager.clear();
      expectEqual(manager.get('clear-0'), undefined, '清空后页面必须全部移除');
      const before = pages.map((page) => page.suspendCalls);
      clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS * 2);
      expect(
        pages.every((page, index) => page.suspendCalls === before[index]),
        '清空后不得残留离屏回收计时',
      );
    },
  },
  {
    name: '注册表引用计数：引用非零期间不回收，归零后离屏并计宽限期',
    run: async () => {
      const clock = createClock();
      const registry = new PluginPageRegistry<FixturePage>(clock.timer);
      const leaseA = await registry.acquire('shared', 'task', () => new FixturePage('shared', 'task'));
      const leaseB = await registry.acquire('shared', 'task', () => new FixturePage('shared', 'task'));
      expectEqual(registry.refCount('shared'), 2, '同键两次获取必须累计引用');
      expectEqual(leaseA.page === leaseB.page, true, '同键两次获取必须是同一实例');

      leaseA.release();
      expectEqual(registry.refCount('shared'), 1, '释放一次后仍被引用');
      const page = registry.get('shared');
      expect(page !== undefined, '页面必须仍在注册表中');
      if (!page) return;
      expectEqual(page.visible, true, '仍有引用期间页面必须保持可见（不启动回收计时）');

      leaseB.release();
      expectEqual(registry.refCount('shared'), 0, '引用必须归零');
      expectEqual(page.visible, false, '引用归零后页面必须转为离屏');
      clock.advance(PLUGIN_PAGE_OFFSCREEN_GRACE_MS);
      expectEqual(page.suspendCalls, 1, '离屏满宽限期后由管理器回收');
    },
  },
];

/** retention 维度：可被 CI 逐项运行，也可被 WebView2 夹具整段运行。 */
export const RETENTION_DIMENSION: McpAppFixtureDimension = {
  id: 'retention',
  title: 'retention：离屏回收 / 容量准入 / 忙碌保活',
  checks,
};
