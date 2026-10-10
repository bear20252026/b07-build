import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentContextText, DIRECT_CHAT_ATTACHMENT_TRUNCATION_CHARS, DIRECT_CHAT_MAX_ATTACHMENT_CONTENT_CHARS } from '../src/runtime/direct-chat-attachments.js';

test('文本附件上下文保留完整用户文件正文与来源标签', () => {
  const value = attachmentContextText([{ name: 'brief.md', mimeType: 'text/markdown', byteSize: 18, included: true, content: '# 需求\n完整内容' }]);
  assert.match(value, /brief\.md/);
  assert.match(value, /完整内容/);
});

test('未读取的附件绝不伪造到 Provider 上下文', () => {
  const value = attachmentContextText([{ name: 'archive.zip', mimeType: 'application/zip', byteSize: 18, included: false, reason: '当前文件不是可直接读取的文本。' }]);
  assert.equal(value, '');
});

test('超长文本文件按预算截断并显式标注，而不是整份拒绝', () => {
  const long = 'x'.repeat(DIRECT_CHAT_ATTACHMENT_TRUNCATION_CHARS + 5_000);
  const value = attachmentContextText([{ name: 'long.md', mimeType: 'text/markdown', byteSize: long.length, included: true, content: `${long.slice(0, DIRECT_CHAT_ATTACHMENT_TRUNCATION_CHARS)}\n…[文件已截断：原始 ${long.length.toLocaleString()} 字符，已传递前 ${DIRECT_CHAT_ATTACHMENT_TRUNCATION_CHARS.toLocaleString()} 字符。需要完整内容请分段发送或缩小文件。]` }]);
  assert.ok(value.includes('文件已截断'));
  assert.ok(value.length < long.length);
  assert.ok(DIRECT_CHAT_ATTACHMENT_TRUNCATION_CHARS < DIRECT_CHAT_MAX_ATTACHMENT_CONTENT_CHARS);
});
