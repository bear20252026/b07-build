import { invoke } from '@tauri-apps/api/core';
import type { DirectConversation } from './use-direct-conversations';

/**
 * 会话账本的原生持久化门面。
 *
 * WebView 侧只提交一个会话对象、或按 id 删除一行；数据库文件、路径与 SQL 全在 Rust 侧。
 * 桌面端不可用时（web 预览、Android、命令缺失）自动降级，调用方回退到 localStorage。
 *
 * ## 为什么写操作必须返回可等待的结果
 *
 * 上一版 `upsert()` / `remove()` 返回 `void`，内部 `void invoke(...).catch(...)`：
 * 失败只把 `degraded` 置真。于是出现一个**数据丢失窗口**——
 *
 * 1. 调用方看到 `available()` 为真，走原生分支，**不再写 localStorage**；
 * 2. 原生写失败（磁盘忙、数据库被占、权限变化），`upsert` 内部吞掉；
 * 3. 调用方毫不知情，既不知道失败，也没有把这份数据补存到备用存储；
 * 4. 在"下一次保存"或"正常卸载"到来之前崩溃/强退，这段内容就没了。
 *
 * 第 3 步是关键：**失败必须让调用方知道，且必须对"这一次"的数据立刻做处理**，
 * 而不是等下一次写入顺带覆盖。因此写操作返回 `Promise<boolean>`，失败时调用方
 * 立即回退到备用存储。
 *
 * ## 待重试队列
 *
 * 失败不是终点：磁盘忙、数据库短暂被占这类原因是**可恢复**的。失败的写入按会话 id
 * 记进待重试队列（同一 id 后者覆盖前者，因为最终状态才是要落盘的东西），
 * `flushPending()` 显式重试。队列非空 = 有内容尚未落盘，`hasUnsaved()` 把它暴露给
 * 界面，让"尚未保存"成为用户可见的状态而不是静默的风险。
 */

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** 待重试的写入。同一 id 只保留最后一条：要落盘的是**最终状态**，不是过程。 */
type PendingWrite =
  | { readonly kind: 'upsert'; readonly conversation: DirectConversation }
  | { readonly kind: 'remove'; readonly id: string };

/** 原生账本当前是否不可用。**可恢复**：一次成功写入或一次完整 flush 会把它清掉。 */
let degraded = false;
/** 尚未落盘成功的写入，按会话 id 索引（后者覆盖前者）。 */
const pending = new Map<string, PendingWrite>();
const unsavedListeners = new Set<(unsavedCount: number) => void>();

function notifyUnsaved(): void {
  const count = pending.size;
  for (const listener of unsavedListeners) {
    try {
      listener(count);
    } catch {
      /* 单个监听者出错不应影响持久化本身。 */
    }
  }
}

function rememberPending(key: string, write: PendingWrite): void {
  pending.set(key, write);
  notifyUnsaved();
}

function forgetPending(key: string): void {
  if (pending.delete(key)) notifyUnsaved();
}

/** 把一条写入真正提交到原生侧。成功返回 true。 */
async function commit(write: PendingWrite): Promise<boolean> {
  try {
    if (write.kind === 'upsert') {
      await invoke('conversation_store_upsert', { conversation: write.conversation });
    } else {
      await invoke('conversation_store_remove', { id: write.id });
    }
    return true;
  } catch {
    return false;
  }
}

export const conversationStore = Object.freeze({
  /** 原生账本是否可用。为假时调用方应走备用存储。 */
  available(): boolean {
    return isTauriRuntime() && !degraded;
  },
  /** 返回未校验的行；校验由持有 DTO 契约的会话层完成。失败时返回空数组并降级。 */
  async load(): Promise<readonly unknown[]> {
    if (!isTauriRuntime()) return [];
    try {
      const rows: unknown = await invoke('conversation_store_load');
      return Array.isArray(rows) ? rows : [];
    } catch {
      degraded = true;
      return [];
    }
  },
  /**
   * 提交一个会话。返回是否已由原生账本持久化。
   *
   * **返回 false 时调用方必须立刻把这份数据写入备用存储**——不能假定"以后还会再存一次"。
   */
  async upsert(conversation: DirectConversation): Promise<boolean> {
    if (!isTauriRuntime() || degraded) {
      // 原生不可用：记进队列，让"尚未落盘"这件事可见、可重试。
      rememberPending(conversation.id, { kind: 'upsert', conversation });
      return false;
    }
    if (await commit({ kind: 'upsert', conversation })) {
      forgetPending(conversation.id);
      return true;
    }
    degraded = true;
    rememberPending(conversation.id, { kind: 'upsert', conversation });
    return false;
  },
  /** 按 id 删除一行。返回是否已由原生账本持久化；false 时调用方必须立刻处理备用存储。 */
  async remove(id: string): Promise<boolean> {
    if (!isTauriRuntime() || degraded) {
      rememberPending(id, { kind: 'remove', id });
      return false;
    }
    if (await commit({ kind: 'remove', id })) {
      forgetPending(id);
      return true;
    }
    degraded = true;
    rememberPending(id, { kind: 'remove', id });
    return false;
  },
  /** 是否有尚未落盘的内容。界面据此显示"尚未保存"。 */
  hasUnsaved(): boolean {
    return pending.size > 0;
  },
  /** 尚未落盘的条数。 */
  unsavedCount(): number {
    return pending.size;
  },
  /** 订阅"尚未保存"状态变化，返回取消订阅函数。 */
  onUnsavedChange(listener: (unsavedCount: number) => void): () => void {
    unsavedListeners.add(listener);
    return () => {
      unsavedListeners.delete(listener);
    };
  },
  /**
   * 重试所有尚未落盘的写入。返回成功与失败的条数。
   *
   * 全部成功时清除降级标记——失败可能是暂时的（磁盘忙、数据库被占），
   * 一旦补上就不该继续把原生账本判为不可用。
   */
  async flushPending(): Promise<{ saved: number; failed: number }> {
    if (!isTauriRuntime() || pending.size === 0) return { saved: 0, failed: 0 };
    let saved = 0;
    let failed = 0;
    // 快照后再遍历：commit 期间可能有新的写入进来，那些留给下一轮。
    for (const [key, write] of [...pending.entries()]) {
      if (await commit(write)) {
        pending.delete(key);
        saved += 1;
      } else {
        failed += 1;
      }
    }
    if (pending.size === 0) degraded = false;
    notifyUnsaved();
    return { saved, failed };
  },
  /** 仅供测试：把模块级状态复位，避免用例之间互相污染。 */
  __resetForTests(): void {
    degraded = false;
    pending.clear();
    unsavedListeners.clear();
  },
});
