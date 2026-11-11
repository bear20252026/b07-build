// 浏览会话的**真实**状态客户端（走 Tauri 命令，不经过任何 HTTP 服务）。
//
// ## 这个文件替换了什么
//
// 原来这里是一条 HTTP 客户端（`browser-session-client.ts`），指向 `/api/browser-sessions`。
// 那个服务（`apps/runtime-gateway`）在 2026-08-26 被整个删除，于是这条客户端一直在
// 调一个不存在的端点 —— 界面上的"授权账本"因此永远停在"未就绪"。
//
// 现在的数据来源是**原生侧真实的会话状态**：`browser_sessions_list` 读的是
// `BrowserToolState` 里那几张表，与浏览器工具用的是同一份状态。
//
// ## 概念也变了，不只是换数据源
//
// 旧面板是"授权账本"：请求 → 授权 → 暂停 → 恢复 → 结束，还有审计事件。
// 那套状态机在真实实现里**不存在** —— 真实的东西是"工具调用期间附着的 CDP 会话"，
// 它有连接、有目标 tab、可能在执行命令、可能正在关闭。所以这里列的是会话本身，
// 不是某个审批流程。**不把旧概念硬套到新数据上**，否则界面会继续描述一个不存在的流程。

import { invoke } from '@tauri-apps/api/core';

/** 一条活动浏览会话。 */
export interface LiveBrowserSession {
  /** 会话 id（浏览器工具里用的那个）。 */
  readonly sessionId: string;
  /** 已配对的目标 tab id；**在途会话取不到**（那段时间它被取出去执行命令了）。 */
  readonly targetId: string | null;
  /** `active` 能用；`inflight` 正在执行命令；`closing` 已被请求关闭。 */
  readonly status: 'active' | 'inflight' | 'closing';
}

const SESSION_STATUSES = new Set<string>(['active', 'inflight', 'closing']);

/**
 * 校验并归一化一条原生返回的会话。
 *
 * 为什么要验：`invoke` 的返回值是**跨进程边界来的**，类型系统在这里不起作用。
 * 一个形状不对的条目如果直接进渲染，界面会显示 `undefined` 之类的假信息 ——
 * 那比"没有会话"更糟，因为用户会以为状态是好的。
 */
export function toLiveBrowserSession(value: unknown): LiveBrowserSession | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as { sessionId?: unknown; targetId?: unknown; status?: unknown };
  if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) return undefined;
  if (typeof input.status !== 'string' || !SESSION_STATUSES.has(input.status)) return undefined;
  // `targetId` 允许为 null（在途会话），但不允许是别的类型。
  if (input.targetId !== null && typeof input.targetId !== 'string') return undefined;
  return {
    sessionId: input.sessionId,
    targetId: input.targetId,
    status: input.status as LiveBrowserSession['status'],
  };
}

/**
 * 列出活动浏览会话。
 *
 * 形状不对的条目**丢弃而不是猜**：少显示一条是"看不到"，显示一条假的会让用户
 * 对状态做出错误判断。返回顺序由原生侧排好（按会话 id）。
 */
export async function listLiveBrowserSessions(): Promise<readonly LiveBrowserSession[]> {
  const payload = await invoke<unknown>('browser_sessions_list');
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item) => toLiveBrowserSession(item))
    .filter((item): item is LiveBrowserSession => item !== undefined);
}

/** 会话状态的可读文案。 */
export function liveSessionStatusLabel(status: LiveBrowserSession['status']): string {
  return ({ active: '可用', inflight: '执行中', closing: '正在关闭' })[status];
}
