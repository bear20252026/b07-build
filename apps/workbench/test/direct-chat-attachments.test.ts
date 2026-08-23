import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentContextText } from '../src/runtime/direct-chat-attachments.js';

test('文本附件上下文保留完整用户文件正文与来源标签', () => {
  const value = attachmentContextText([{ name: 'brief.md', mimeType: 'text/markdown', byteSize: 18, included: true, content: '# 需求\n完整内容' }]);
  assert.match(value, /brief\.md/);
  assert.match(value, /完整内容/);
});

test('未读取的附件绝不伪造到 Provider 上下文', () => {
  const value = attachmentContextText([{ name: 'archive.zip', mimeType: 'application/zip', byteSize: 18, included: false, reason: '当前文件不是可直接读取的文本。' }]);
  assert.equal(value, '');
});
