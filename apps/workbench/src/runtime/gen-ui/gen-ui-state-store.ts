// 一个文件=一种作用：Gen UI 宿主侧 Widget 状态存储——按 (workspace, session, path) 键隔离，
// 广播变更，并把全部条目的 modelContent 投影成有界模型上下文。
//
// 与上游 `services/genUi` 的关系：上游把状态落在主进程服务里、经 IPC 通知渲染层；b07 的
// 工作台是浏览器 DTO 边界（不得碰 Node），故这里收敛为纯内存 store + 订阅，落盘/跨窗口
// 同步留给后续批次（见 PR 模式评估结论）。语义对齐：状态键、订阅投影、模型上下文构建
// 全部复用 `@awo/protocol` 的 gen-ui 契约。

import {
  buildGenUiModelContext,
  buildGenUiStateKey,
  parseGenUiWidgetState,
  type GenUiStateChange,
  type GenUiStateEntry,
  type GenUiStateTarget,
  type GenUiWidgetState,
} from '@awo/protocol';

export interface GenUiStateSubscription {
  dispose(): void;
}

interface StoredState {
  readonly target: GenUiStateTarget;
  readonly state: GenUiWidgetState | null;
}

export class GenUiStateStore {
  private readonly entries = new Map<string, StoredState>();
  private readonly listeners = new Set<(change: GenUiStateChange) => void>();

  /** 读取状态；未登记或已清空返回 null。 */
  get(target: GenUiStateTarget): GenUiWidgetState | null {
    return this.entries.get(buildGenUiStateKey(target))?.state ?? null;
  }

  /**
   * 写入状态：非法状态整体拒绝（返回 undefined，不改变已有值）。
   * 状态键相同即视为同一页面实例的更新。
   */
  set(target: GenUiStateTarget, state: unknown): GenUiStateChange | undefined {
    const parsed = parseGenUiWidgetState(state);
    if (!parsed.ok) return undefined;
    const change: GenUiStateChange = { target, state: parsed.value };
    this.entries.set(buildGenUiStateKey(target), { target, state: parsed.value });
    for (const listener of this.listeners) listener(change);
    return change;
  }

  /** 清空某个页面的状态（页面被销毁时调用）。 */
  clear(target: GenUiStateTarget): void {
    const key = buildGenUiStateKey(target);
    if (!this.entries.delete(key)) return;
    const change: GenUiStateChange = { target, state: null };
    for (const listener of this.listeners) listener(change);
  }

  onStateChanged(listener: (change: GenUiStateChange) => void): GenUiStateSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** 当前全部条目（供模型上下文构建）。 */
  list(): readonly GenUiStateEntry[] {
    return [...this.entries.values()].map((entry) => ({ path: entry.target.path, state: entry.state ?? { modelContent: null, privateContent: null } }));
  }

  /** 有界模型上下文块（≤100 条 / ≤64KiB，只含 modelContent）。 */
  modelContext(): string {
    return buildGenUiModelContext(this.list());
  }
}

/** 工作台共享的单例状态存储（跨面板/会话复用同一隔离键空间）。 */
export const genUiStateStore = new GenUiStateStore();
