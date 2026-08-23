import type { WorkspaceFileDescriptor } from './workspace-file-contract';

export const DIRECT_CHAT_MAX_ATTACHMENT_CONTENT_CHARS = 1_000_000;

export interface DirectChatAttachmentInput { readonly descriptor: WorkspaceFileDescriptor; readonly file: File; }
export interface DirectChatAttachmentContext { readonly name: string; readonly mimeType: string; readonly byteSize: number; readonly included: boolean; readonly content?: string; readonly reason?: string; }

export async function readDirectChatAttachments(inputs: readonly DirectChatAttachmentInput[]): Promise<readonly DirectChatAttachmentContext[]> {
  return Promise.all(inputs.map(async ({ descriptor, file }) => {
    const mimeType = file.type || `text/x-${descriptor.extension || 'plain'}`;
    if (descriptor.kind !== 'text') return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '当前文件不是可直接读取的文本；未伪装为已发送内容。' };
    if (file.size > DIRECT_CHAT_MAX_ATTACHMENT_CONTENT_CHARS) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '文件超过本轮 1M 字符上下文预算；未静默截断。' };
    try {
      const content = await file.text();
      if (!content.trim()) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '文件没有可读取的文本内容。' };
      if (content.length > DIRECT_CHAT_MAX_ATTACHMENT_CONTENT_CHARS) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '文件文本超过本轮 1M 字符上下文预算；未静默截断。' };
      return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: true, content };
    } catch {
      return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '无法读取此文件的本地文本内容。' };
    }
  }));
}

export function attachmentContextText(attachments: readonly DirectChatAttachmentContext[]): string {
  const included = attachments.filter((attachment) => attachment.included && attachment.content);
  if (!included.length) return '';
  return included.map((attachment) => `\n\n--- 用户明确附加的本地文件：${attachment.name} (${attachment.mimeType}, ${attachment.byteSize} bytes) ---\n${attachment.content}\n--- 文件结束：${attachment.name} ---`).join('');
}
