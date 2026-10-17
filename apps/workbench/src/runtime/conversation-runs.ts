// 把一次**会话**汇总成一条"运行"记录。
//
// ## 为什么是会话，不是任务
//
// 原来的"任务执行"是一套独立的节点图引擎（submit / events / trajectory / artifacts /
// checkpoints / deliveries / approveAndResume），它的后端随 `apps/runtime-gateway`
// 一起被删了，整套界面停摆。
//
// 而对话循环已经在做同样的事：目标 → 调工具 → 逐次审批 → 记录轨迹。
// 所以采用**一套执行模型**：一次运行 = 一段会话。这个模块只做"把会话读成运行摘要"，
// 不引入任何新的执行引擎。
//
// ## 刻意不编的东西
//
// 会话没有"完成/失败"这种终态 —— 它是可以随时继续的。所以状态只有三种，
// 且都由**已有事实**推导，不猜：
// - `pending`：最后一条是用户消息（还没回复）
// - `interrupted`：有回合被中断，但工具已经执行过（文件真的改了）
// - `idle`：其余（有过回答，可继续）
//
// 同理，"改了几个文件"只数文件日志里**真实记录**过的路径，不按消息文本推断。

import type { DirectConversation } from './use-direct-conversations';
import type { WorkspaceFileChangeRecord } from './workspace-file-rewind-contract';

/** 一次会话运行的状态。 */
export type ConversationRunStatus = 'pending' | 'interrupted' | 'idle';

/** 一条运行摘要。 */
export interface ConversationRun {
  readonly conversationId: string;
  readonly title: string;
  /** 首条用户消息（截断），作为这次运行的"目标"。 */
  readonly goal: string;
  readonly messageCount: number;
  /** 记录在消息活动里的工具调用次数。 */
  readonly toolCallCount: number;
  /** 文件日志里出现过的**不同路径**数。 */
  readonly filesChanged: number;
  /** 文件日志的**记录条数**（同一文件多次写入会重复计）。 */
  readonly fileChangeCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: ConversationRunStatus;
}

/** 目标摘要的最大长度。够看出在干什么，又不至于把整段话塞进列表。 */
const MAX_GOAL_CHARS = 120;

function truncateGoal(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length <= MAX_GOAL_CHARS ? normalized : `${normalized.slice(0, MAX_GOAL_CHARS)}…`;
}

/** 汇总一条会话。`records` 是该会话的文件变更日志（可为空）。 */
export function summarizeConversationRun(
  conversation: DirectConversation,
  records: readonly WorkspaceFileChangeRecord[],
): ConversationRun {
  const messages = conversation.messages;
  const goal = messages.find((message) => message.role === 'user')?.text ?? '';
  let toolCallCount = 0;
  let interrupted = false;
  for (const message of messages) {
    for (const activity of message.activities ?? []) {
      if (activity.kind === 'tool') toolCallCount += 1;
    }
    if (message.interrupted) interrupted = true;
  }
  const last = messages[messages.length - 1];
  // 顺序有意义：最后一条是用户消息说明"还没回复"，这比"曾经中断过"更贴近当前状态。
  const status: ConversationRunStatus = last?.role === 'user'
    ? 'pending'
    : interrupted
      ? 'interrupted'
      : 'idle';
  return {
    conversationId: conversation.id,
    title: conversation.title,
    goal: truncateGoal(goal),
    messageCount: messages.length,
    toolCallCount,
    filesChanged: new Set(records.map((record) => record.path)).size,
    fileChangeCount: records.length,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    status,
  };
}

/**
 * 汇总多条会话，按**最近活动**倒序。
 *
 * 顺序按 `updatedAt` 而不是创建时间：运行记录要回答"最近在忙什么"，
 * 而不是"最早建了什么"。
 */
export function summarizeConversationRuns(
  conversations: readonly DirectConversation[],
  recordsOf: (conversationId: string) => readonly WorkspaceFileChangeRecord[],
): readonly ConversationRun[] {
  return conversations
    .map((conversation) => summarizeConversationRun(conversation, recordsOf(conversation.id)))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/** 状态的可读文案。 */
export function conversationRunStatusLabel(status: ConversationRunStatus): string {
  return ({ pending: '等待回复', interrupted: '回合中断', idle: '可继续' })[status];
}
