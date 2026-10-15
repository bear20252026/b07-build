// 一个文件=一种作用：UI 插件页面注册表——逻辑共享键与引用计数。
//
// 位于 PluginPageManager 之上：管理器按 key 唯一持有页面并裁决容量/回收；
// 注册表负责「同一逻辑键的多个使用方共享同一个页面实例」，用引用计数把
// 「还有没有人用」表达清楚——引用归零才把页面标记为离屏、交给管理器按宽限期
// 真正回收（引用非零期间不启动回收计时）。
//
// 逻辑键（key）的语义与上游一致：包含 workspace identity、session、plugin、
// server、resource 与逻辑视图；surface 显式共享，普通工具只按明确的
// widgetSessionId 与相同权限范围共享，否则按 toolCallId 隔离（key 由调用方构造，
// 本文件不做推断合并）。任务键（task）决定容量与淘汰域：同一任务下的页面共享
// 30/64 上限，任务删除时整组回收。
//
// 分层纪律（对齐上游 CONTRACT.md）：本层只做引用计数与订阅分发，不碰 DOM、
// 不碰插件 HTML、不碰连接凭据；页面的挂载/卸载由上层组件适配器承担。

import { PluginPageManager, type ManagedPluginPage, type PluginPageTimer } from './plugin-page-manager';

/** 一次使用方持有的页面租约：release 幂等，重复释放不重复扣减引用。 */
export interface PluginPageLease<T extends ManagedPluginPage> {
  readonly key: string;
  readonly page: T;
  release(): void;
}

export interface PluginPageRegistryOptions {
  /** 任务被删除时的清理回调（释放任务级宿主资源）。 */
  readonly clearTask?: (task: string) => void;
  /** 页面被管理器移除（淘汰/任务删除）时的回调，供使用方销毁宿主资源。 */
  readonly onRemoved?: (key: string) => void;
}

export class PluginPageRegistry<T extends ManagedPluginPage> {
  /** 底层页面管理器：容量、离屏回收与准入串行都在这里。 */
  readonly manager: PluginPageManager<T>;
  /** key → 活跃引用计数。 */
  private readonly refs = new Map<string, number>();
  /** key → 在途创建（并发 acquire 去重，避免同一逻辑键建出两个实例）。 */
  private readonly creating = new Map<string, Promise<T>>();
  /** key → 页面被移除时的订阅者。 */
  private readonly removedListeners = new Map<string, Set<() => void>>();
  private readonly clearTask: (task: string) => void;
  private readonly onRemoved?: (key: string) => void;

  constructor(timer: PluginPageTimer, options: PluginPageRegistryOptions = {}) {
    this.clearTask = options.clearTask ?? (() => {});
    this.onRemoved = options.onRemoved;
    // 管理器的 changed 回调接回注册表：页面被移除时同步清引用计数并通知订阅者。
    this.manager = new PluginPageManager<T>(timer, this.clearTask, (key) => this.handleRemoved(key));
  }

  get(key: string): T | undefined {
    return this.manager.get(key);
  }

  /** 当前活跃引用数（测试与诊断用）。 */
  refCount(key: string): number {
    return this.refs.get(key) ?? 0;
  }

  /**
   * 获取（或首次创建）逻辑键对应的共享页面，并 +1 引用。
   * 相同 key 的并发/先后调用拿到同一实例；创建失败时销毁半成品并抛出。
   */
  async acquire(key: string, task: string, create: () => T): Promise<PluginPageLease<T>> {
    const existing = this.manager.get(key);
    if (existing) {
      this.retain(key, existing);
      return this.makeLease(key, existing);
    }
    let pending = this.creating.get(key);
    if (!pending) {
      const created = create();
      pending = this.manager.add(created).then(
        () => created,
        (error: unknown) => {
          created.destroy();
          throw error;
        },
      );
      this.creating.set(key, pending);
      const settled = () => {
        if (this.creating.get(key) === pending) this.creating.delete(key);
      };
      void pending.then(settled, settled);
    }
    const page = await pending;
    this.retain(key, page);
    return this.makeLease(key, page);
  }

  /** 释放一次引用。归零时把页面标记为离屏，交由管理器按宽限期回收。 */
  release(key: string): void {
    const current = this.refs.get(key);
    if (current === undefined) return;
    if (current > 1) {
      this.refs.set(key, current - 1);
      return;
    }
    this.refs.delete(key);
    const page = this.manager.get(key);
    if (page) this.manager.visibility(page, false);
  }

  /** 上报页面可见性：可见取消回收计时，不可见启动宽限期计时。 */
  setVisibility(key: string, visible: boolean): void {
    const page = this.manager.get(key);
    if (page) this.manager.visibility(page, visible);
  }

  /** 占用沙箱槽位（活页面上限 64）；页面已被移除则拒绝。 */
  async reserve(key: string): Promise<void> {
    const page = this.manager.get(key);
    if (!page) throw new Error('MCP App page was removed');
    await this.manager.reserve(page);
  }

  /** 释放沙箱槽位。 */
  released(key: string): void {
    const page = this.manager.get(key);
    if (page) this.manager.released(page);
  }

  /** 空闲确认（审批/调用结束后）：满足条件立即回收。 */
  settled(key: string): void {
    const page = this.manager.get(key);
    if (page) this.manager.settled(page);
  }

  /** 订阅页面移除（淘汰/任务删除）；返回取消订阅函数。 */
  subscribeRemoved(key: string, listener: () => void): () => void {
    const set = this.removedListeners.get(key) ?? new Set<() => void>();
    set.add(listener);
    this.removedListeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.removedListeners.delete(key);
    };
  }

  /** 删除任务：整组页面被管理器销毁并回调清理。 */
  removeTask(task: string): void {
    this.manager.removeTask(task);
  }

  /** 清空全部页面（窗口卸载时调用）。 */
  clear(): void {
    this.manager.clear();
  }

  /** +1 引用；首次引用时取消可能在途的离屏回收计时。 */
  private retain(key: string, page: T): void {
    const next = (this.refs.get(key) ?? 0) + 1;
    this.refs.set(key, next);
    if (next === 1) this.manager.visibility(page, true);
  }

  private makeLease(key: string, page: T): PluginPageLease<T> {
    let released = false;
    return {
      key,
      page,
      release: () => {
        if (released) return;
        released = true;
        this.release(key);
      },
    };
  }

  /** 管理器移除页面时的清理：清引用计数、通知订阅者与外部回调。 */
  private handleRemoved(key: string): void {
    this.refs.delete(key);
    for (const listener of this.removedListeners.get(key) ?? []) listener();
    this.onRemoved?.(key);
  }
}
