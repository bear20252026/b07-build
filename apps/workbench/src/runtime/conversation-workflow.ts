import type { DirectConversation } from './use-direct-conversations';

export function branchConversation(source: DirectConversation, messageId: string, id: string, now: number): DirectConversation | undefined {
  const index = source.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return undefined;
  return { ...source, id, title: `${source.title.slice(0, 58)} · 分支`, messages: source.messages.slice(0, index + 1), createdAt: now, updatedAt: now };
}

/**
 * 建一个检查点。
 *
 * `fileChangeSequence` 是**建检查点那一刻**文件日志的下一个序号：序号 >= 它的记录
 * 发生在该检查点之后，回退时据此切片。没有它就只能"把整份日志都退了"，
 * 而那意味着用户想回到中途某个检查点时，会把更早的改动也一起撤掉。
 */
export function checkpointConversation(source: DirectConversation, id: string, label: string, now: number, fileChangeSequence: number) {
  return {
    schemaVersion: 2 as const,
    id,
    conversationId: source.id,
    label: label.trim().slice(0, 80) || `检查点 · ${source.messages.length} 条消息`,
    messageCount: source.messages.length,
    createdAt: now,
    fileChangeSequence: Number.isSafeInteger(fileChangeSequence) && fileChangeSequence >= 1 ? fileChangeSequence : 1,
    conversation: source,
  };
}

export function conversationMarkdown(source: DirectConversation): string {
  const lines = [`# ${source.title}`, '', `- Provider：${source.selection.providerId}`, `- 模型：${source.selection.model ?? '未记录'}`, `- 导出时间：${new Date().toISOString()}`, '', '---', ''];
  for (const message of source.messages) lines.push(`## ${message.role === 'user' ? '用户' : message.model ?? '助手'}`, '', message.text, '');
  return lines.join('\n');
}

export function conversationJson(source: DirectConversation): string {
  return JSON.stringify({ schemaVersion: 1, title: source.title, selection: source.selection, createdAt: source.createdAt, updatedAt: source.updatedAt, messages: source.messages.map((message) => ({ id: message.id, role: message.role, text: message.text, createdAt: message.createdAt, ...(message.model ? { model: message.model } : {}) })) }, null, 2);
}
