import type { DirectConversation } from './use-direct-conversations';

export function branchConversation(source: DirectConversation, messageId: string, id: string, now: number): DirectConversation | undefined {
  const index = source.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return undefined;
  return { ...source, id, title: `${source.title.slice(0, 58)} · 分支`, messages: source.messages.slice(0, index + 1), createdAt: now, updatedAt: now };
}

export function checkpointConversation(source: DirectConversation, id: string, label: string, now: number) {
  return { schemaVersion: 1 as const, id, conversationId: source.id, label: label.trim().slice(0, 80) || `检查点 · ${source.messages.length} 条消息`, messageCount: source.messages.length, createdAt: now, conversation: source };
}

export function conversationMarkdown(source: DirectConversation): string {
  const lines = [`# ${source.title}`, '', `- Provider：${source.selection.providerId}`, `- 模型：${source.selection.model ?? '未记录'}`, `- 导出时间：${new Date().toISOString()}`, '', '---', ''];
  for (const message of source.messages) lines.push(`## ${message.role === 'user' ? '用户' : message.model ?? '助手'}`, '', message.text, '');
  return lines.join('\n');
}

export function conversationJson(source: DirectConversation): string {
  return JSON.stringify({ schemaVersion: 1, title: source.title, selection: source.selection, createdAt: source.createdAt, updatedAt: source.updatedAt, messages: source.messages.map((message) => ({ id: message.id, role: message.role, text: message.text, createdAt: message.createdAt, ...(message.model ? { model: message.model } : {}) })) }, null, 2);
}
