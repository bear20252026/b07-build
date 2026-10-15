// 一个文件=一种作用：MCP App 宿主页面实例——逻辑键、引用计数与活跃/可见状态存储。
//
// 这是 PluginPageManager 的页面实现：把「活跃（iframe 是否挂载）」「忙碌（工具调用在途）」
// 收敛成一个可订阅的小状态机，供 React 组件用 useSyncExternalStore 渲染。
// 本文件不碰 DOM、不碰 React，只做状态与生命周期标记；真正的挂载/卸载由上层组件承担。

import { PluginPageRegistry } from './plugin-page-registry';
import type { ManagedPluginPage, PluginPageTimer } from './plugin-page-manager';

/** 生产计时器：离屏回收宽限期用真实 setTimeout。 */
const realTimer: PluginPageTimer = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

export class McpAppPage implements ManagedPluginPage {
  readonly key: string;
  readonly task: string;
  visible = false;
  /** 是否应挂载宿主 iframe；被管理器回收（suspend/destroy）时置 false。 */
  private active = true;
  /** 在途工具调用数：大于 0 即忙碌，忙碌期间不得回收。 */
  private calls = 0;
  private readonly listeners = new Set<() => void>();

  constructor(key: string, task: string) {
    this.key = key;
    this.task = task;
  }

  busy(): boolean {
    return this.calls > 0;
  }

  running(): boolean {
    return this.active;
  }

  suspend(): void {
    this.setActive(false);
  }

  destroy(): void {
    this.setActive(false);
  }

  /** 工具调用入账（宿主注入的 onToolCallRequest 包裹层调用）。 */
  beginCall(): void {
    this.calls += 1;
  }

  /** 工具调用结束。 */
  endCall(): void {
    this.calls = Math.max(0, this.calls - 1);
  }

  /** 重新可见时复活页面（取消离屏回收计时后由锚点触发）。 */
  activate(): void {
    this.setActive(true);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): boolean => this.active;

  private setActive(next: boolean): void {
    if (next === this.active) return;
    this.active = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * 窗口级共享注册表：相同逻辑键（pageKey）的多个宿主共享同一页面实例，
 * 引用计数归零后交由管理器按 5 分钟离屏宽限期回收；任务上限 30、活页面上限 64。
 */
export const mcpAppPages = new PluginPageRegistry<McpAppPage>(realTimer);

/**
 * 任务删除时调用（会话/任务被移除）：销毁该任务下全部页面并取消其排队准入。
 * 组件卸载只释放引用（进入离屏回收），任务级销毁走本入口。
 */
export function removeMcpAppPageTask(task: string): void {
  mcpAppPages.removeTask(task);
}
