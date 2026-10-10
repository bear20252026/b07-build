import { invoke } from '@tauri-apps/api/core';
import type { DirectConversation } from './use-direct-conversations';

/**
 * 会话账本的原生持久化门面。
 *
 * WebView 侧只提交一个会话对象、或按 id 删除一行；数据库文件、路径与 SQL 全在 Rust 侧。
 * 桌面端不可用时（web 预览、Android、命令缺失）自动降级，调用方回退到 localStorage。
 */

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

let degraded = false;

export const conversationStore = Object.freeze({
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
  upsert(conversation: DirectConversation): void {
    if (!isTauriRuntime() || degraded) return;
    void invoke('conversation_store_upsert', { conversation }).catch(() => {
      degraded = true;
    });
  },
  remove(id: string): void {
    if (!isTauriRuntime() || degraded) return;
    void invoke('conversation_store_remove', { id }).catch(() => {
      degraded = true;
    });
  },
});
