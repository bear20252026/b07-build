import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceFileDescriptor } from './workspace-file-contract';

export const DIRECT_CHAT_MAX_ATTACHMENT_CONTENT_CHARS = 1_000_000;

export interface DirectChatAttachmentInput { readonly descriptor: WorkspaceFileDescriptor; readonly file: File; }
export interface DirectChatImage { readonly mediaType: string; readonly base64Data: string; }
export interface DirectChatAttachmentContext { readonly name: string; readonly mimeType: string; readonly byteSize: number; readonly included: boolean; readonly content?: string; readonly image?: DirectChatImage; readonly reason?: string; }

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let output = '';
  for (let start = 0; start < bytes.length; start += 0x8000) output += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(output);
}

async function extractWithNativeReader(file: File): Promise<{ content: string; format: string }> {
  return invoke<{ content: string; format: string }>('extract_file_content', { request: { name: file.name, base64Data: await base64(file) } });
}

export async function readDirectChatAttachments(inputs: readonly DirectChatAttachmentInput[]): Promise<readonly DirectChatAttachmentContext[]> {
  return Promise.all(inputs.map(async ({ descriptor, file }) => {
    const mimeType = file.type || `text/x-${descriptor.extension || 'plain'}`;
    if (descriptor.kind === 'media') {
      if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '当前模型请求仅支持 PNG、JPEG、WebP 或 GIF 图片；该媒体文件没有被伪装为已传递。' };
      if (file.size > 5 * 1024 * 1024) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '图片超过当前轮 5 MB 多模态传递上限；未静默压缩或丢弃。' };
      try { return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: true, image: { mediaType: mimeType, base64Data: await base64(file) } }; } catch { return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '无法读取图片的本地二进制内容。' }; }
    }
    if (descriptor.kind !== 'text') {
      if (file.size > 10 * 1024 * 1024) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '文件超过原生提取器的 10 MB 单文件上限；未静默截断。' };
      try {
        const extracted = await extractWithNativeReader(file);
        if (!extracted.content.trim()) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '原生提取器未得到可读内容。' };
        return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: true, content: extracted.content };
      } catch {
        return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '当前格式无法由本地提取器转换为模型文本；未伪装为已发送内容。' };
      }
    }
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

export function attachmentImages(attachments: readonly DirectChatAttachmentContext[]): readonly DirectChatImage[] { return attachments.flatMap((attachment) => attachment.image ? [attachment.image] : []); }
