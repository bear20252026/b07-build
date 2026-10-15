// 一个文件=一种作用：窗口级 UI 插件页面管理器——离屏回收、容量准入与准入串行。
//
// 移植自 ZCode `packages/ui/src/plugin-ui/app/pluginUiPageManager.ts`（Apache-2.0），
// 按 b07 分层纪律（domain → app → adapters → components）落为**不依赖 DOM 的纯逻辑层**：
// 视图只登记锚点与可见性，页面的挂载/卸载由上层适配器承担，本文件只裁决
// 「谁在窗口里活着、活多久、超限怎么办」。
//
// 四条纪律（与上游一致，常量以上游源码与测试为准）：
// 1. 离屏回收：页面连续不可见满宽限期后 suspend；重新可见即取消计时（连续计时语义）。
// 2. 容量准入：任务数上限 30、活页面上限 64；超限先尝试淘汰「最久未用且可安全回收」的
//    任务/页面，无法安全回收时**拒绝**（抛错），绝不静默超发。
// 3. 准入串行：所有 add/reserve 经同一条 admission 链串行执行，避免并发准入互相踩。
// 4. 迟到保护：排队中被删除的任务会取消其准入；异步回收期间实例被替换时，旧准入不得
//    重新占用已撤销的槽位。
//
// 页面实例（泛型 T）只需实现 ManagedPluginPage：本层不关心它是 iframe、webview 还是
// 其它宿主；「逻辑共享键」由上层 PluginPageRegistry 按 key 归并，本层按 key 唯一持有。

/**
 * 被管理的页面实例契约。本层只调用这些方法，不触碰任何宿主实现细节。
 * - busy：审批/工具调用在途——在途期间不得回收（与「可见」同级的保活条件）。
 * - running：是否已有活实例；用于判定页面是否值得保留。
 * - suspend：回收活实例（离屏宽限到期或容量淘汰时调用）；显式返回 false 表示
 *   此刻不可安全回收，容量准入据此跳过该候选。
 * - destroy：彻底销毁（任务删除/淘汰/清空时调用）。
 */
export interface ManagedPluginPage {
  readonly key: string;
  readonly task: string;
  visible: boolean;
  busy(): boolean;
  running(): boolean;
  suspend(): void | Promise<boolean | void>;
  destroy(): void;
}

/** 离屏宽限期：页面连续不可见满 5 分钟后才回收（上游 `5 * 60_000`）。 */
export const PLUGIN_PAGE_OFFSCREEN_GRACE_MS = 5 * 60_000;

/** 任务上限：超出后按最久未用淘汰；无安全候选则拒绝准入（上游 `>= 30`）。 */
export const PLUGIN_PAGE_MAX_TASKS = 30;

/** 活页面上限（沙箱容量）：全部可见/忙碌时拒绝，否则回收空闲页腾位（上游 `< 64`）。 */
export const PLUGIN_PAGE_MAX_LIVE_PAGES = 64;

/** 取消计时器句柄：由注入的 timer 返回，用于取消一次离屏回收计时。 */
export type PluginPageTimer = (run: () => void, ms: number) => () => void;

export class PluginPageManager<T extends ManagedPluginPage> {
  /** 已占用沙箱槽位的页面（reserve 成功、released 释放）。 */
  private readonly allocated = new Set<T>();
  /** 串行准入链：所有 add/reserve 挂在这条链上顺序执行。 */
  private admission: Promise<void> = Promise.resolve();
  /** key → 页面实例（窗口内 key 唯一）。 */
  private readonly pages = new Map<string, T>();
  /** task → 该任务下的 key 集合；Map 迭代序即最近使用序（可见/新建时移到末尾）。 */
  private readonly tasks = new Map<string, Set<string>>();
  /** key → 离屏回收计时取消句柄。 */
  private readonly timers = new Map<string, () => void>();
  /** 排队中的 add：任务被删除时置 cancelled，避免已撤销的准入继续落地。 */
  private readonly pendingAdds = new Map<T, { cancelled: boolean }>();

  constructor(
    /** 计时器注入（生产用 setTimeout，测试用假时钟）。 */
    private readonly timer: PluginPageTimer,
    /** 任务被删除时的清理回调（释放任务级宿主资源）。 */
    private readonly clearTask: (task: string) => void,
    /** 页面被移除时的通知回调（供注册表清理引用计数与订阅）。 */
    private readonly changed: (key: string) => void = () => {},
  ) {}

  get(key: string): T | undefined {
    return this.pages.get(key);
  }

  /**
   * 准入并登记页面。串行执行：容量检查、安全淘汰与最终落地都在同一条链上。
   * 失败原因：任务已被删除 / key 已被占用 / 任务容量已满。
   */
  add(page: T): Promise<void> {
    const admission = { cancelled: false };
    this.pendingAdds.set(page, admission);
    const pending = this.admission
      .then(async () => {
        if (admission.cancelled) throw new Error('MCP App task was removed');
        if (this.pages.has(page.key)) throw new Error('Duplicate MCP App page owner');
        // 新任务会占用一个任务槽位：达到上限时先尝试淘汰一个可安全回收的旧任务。
        if (!this.tasks.has(page.task) && this.tasks.size >= PLUGIN_PAGE_MAX_TASKS) {
          let evicted = false;
          for (const [task, keys] of this.tasks) {
            const candidates = [...keys]
              .map((key) => this.pages.get(key))
              .filter((candidate): candidate is T => candidate !== undefined);
            // 可见或忙碌的任务不淘汰。
            if (candidates.some((candidate) => candidate.visible || candidate.busy())) continue;
            let idle = true;
            for (const background of candidates) {
              if ((await background.suspend()) === false) {
                idle = false;
                break;
              }
            }
            if (admission.cancelled) throw new Error('MCP App task was removed');
            // 回收等待期间候选可能重新可见/忙碌：旧准入不得淘汰它。
            if (candidates.some((candidate) => candidate.visible || candidate.busy())) continue;
            if (!idle) continue;
            this.removeTask(task);
            evicted = true;
            break;
          }
          if (!evicted) throw new Error('MCP App task capacity reached');
        }
        const keys = this.tasks.get(page.task) ?? new Set<string>();
        this.tasks.delete(page.task);
        this.tasks.set(page.task, keys);
        keys.add(page.key);
        this.pages.set(page.key, page);
      })
      .finally(() => this.pendingAdds.delete(page));
    this.admission = pending.catch(() => undefined);
    return pending;
  }

  /**
   * 占用一个沙箱槽位（活页面上限 64）。超限时回收一个空闲页腾位；
   * 全部可见/忙碌则拒绝。回收等待期间页面被删除时不占用已撤销的槽位。
   */
  reserve(page: T): Promise<void> {
    const pending = this.admission.then(async () => {
      if (this.allocated.has(page)) return;
      if (this.pages.get(page.key) !== page) throw new Error('MCP App page was removed');
      const running = [...this.allocated];
      if (running.length < PLUGIN_PAGE_MAX_LIVE_PAGES) {
        this.allocated.add(page);
        return;
      }
      for (const candidate of running) {
        if (candidate.visible || candidate.busy()) continue;
        if ((await candidate.suspend()) === false) continue;
        this.allocated.delete(candidate);
        // 回收等待期间任务可能被删除；旧 admission 不得重新占用已经撤销的槽位。
        if (this.pages.get(page.key) !== page) throw new Error('MCP App page was removed');
        this.allocated.add(page);
        return;
      }
      throw new Error('MCP App sandbox capacity reached');
    });
    this.admission = pending.catch(() => undefined);
    return pending;
  }

  /** 释放沙箱槽位。 */
  released(page: T): void {
    this.allocated.delete(page);
  }

  /**
   * 可见性变更。可见 = 取消离屏计时并刷新任务最近使用序；
   * 不可见 = 启动宽限期计时，到期且仍不可见、不忙碌时回收。
   */
  visibility(page: T, visible: boolean): void {
    if (this.pages.get(page.key) !== page) return;
    page.visible = visible;
    this.timers.get(page.key)?.();
    this.timers.delete(page.key);
    if (visible) {
      const keys = this.tasks.get(page.task)!;
      this.tasks.delete(page.task);
      this.tasks.set(page.task, keys);
    } else {
      this.timers.set(
        page.key,
        this.timer(() => {
          this.timers.delete(page.key);
          if (!page.visible && !page.busy()) page.suspend();
        }, PLUGIN_PAGE_OFFSCREEN_GRACE_MS),
      );
    }
  }

  /**
   * 空闲确认：Agent 原子裁决「已空闲」后调用。若此刻不可见、不忙碌且没有在途计时
   * （例如宽限期内已到期但被忙碌保活），立即回收。
   */
  settled(page: T): void {
    if (this.pages.get(page.key) !== page) return;
    if (!page.visible && !page.busy() && !this.timers.has(page.key)) page.suspend();
  }

  /** 删除任务：取消其排队准入、销毁该任务下全部页面并通知清理。 */
  removeTask(task: string): void {
    for (const [page, pending] of this.pendingAdds) {
      if (page.task === task) pending.cancelled = true;
    }
    const keys = this.tasks.get(task);
    if (!keys) return;
    this.tasks.delete(task);
    for (const key of keys) {
      const page = this.pages.get(key);
      this.pages.delete(key);
      this.timers.get(key)?.();
      this.timers.delete(key);
      page?.destroy();
      this.changed(key);
    }
    this.clearTask(task);
  }

  /** 清空全部页面（窗口卸载时调用）：取消排队准入，逐个删除任务。 */
  clear(): void {
    for (const pending of this.pendingAdds.values()) pending.cancelled = true;
    for (const task of [...this.tasks.keys()]) this.removeTask(task);
  }
}
