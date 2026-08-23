import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceFileDescriptor } from './workspace-file-contract';

export const DIRECT_CHAT_MAX_ATTACHMENT_CONTENT_CHARS = 1_000_000;

export interface DirectChatAttachmentInput { readonly descriptor: WorkspaceFileDescriptor; readonly file: File; }
export interface DirectChatImage { readonly mediaType: string; readonly base64Data: string; }
export interface DirectChatAttachmentContext { readonly name: string; readonly mimeType: string; readonly byteSize: number; readonly included: boolean; readonly content?: string; readonly image?: DirectChatImage; readonly reason?: string; }

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
const IMAGE_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
// MiMo documents a 50 MB limit for the Base64 string. Base64 expands raw bytes by about 4/3,
// so retaining at most 37.5 MB of local binary keeps the outgoing value within that contract.
const MAX_IMAGE_BYTES_FOR_BASE64 = 37_500_000;

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
    const extension = descriptor.extension.toLowerCase();
    const mimeType = file.type.toLowerCase() || IMAGE_TYPE_BY_EXTENSION[extension] || `text/x-${descriptor.extension || 'plain'}`;
    if (descriptor.kind === 'media') {
      if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '当前模型请求支持 PNG、JPEG、WebP、GIF 或 BMP 图片；该媒体文件没有被伪装为已传递。' };
      if (file.size > MAX_IMAGE_BYTES_FOR_BASE64) return { name: descriptor.name, mimeType, byteSize: descriptor.byteSize, included: false, reason: '图片转为 Base64 后会超过供应商 50 MB 上限；未静默压缩或丢弃。' };
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
