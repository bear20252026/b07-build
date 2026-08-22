import assert from 'node:assert/strict';
import test from 'node:test';
import { descriptorsFromFiles, mergeComposerAttachments, mergeComposerFileAttachments } from '../src/components/workspace/ComposerAttachments.js';

const item = (name: string, size: number): File => ({ name, size } as File);
const list = (...files: File[]): FileList => Object.assign(files, { item: (index: number) => files[index] ?? null }) as unknown as FileList;

test('聊天附件入口只从显式 FileList 分类为脱敏描述符', () => {
  const [markdown, archive, binary] = descriptorsFromFiles(list(item('brief.md', 120), item('sources.zip', 80), item('unknown.payload', 5)), 0);
  assert.deepEqual({ name: markdown?.name, kind: markdown?.kind, preview: markdown?.preview }, { name: 'brief.md', kind: 'text', preview: 'text' });
  assert.deepEqual({ name: archive?.name, kind: archive?.kind, preview: archive?.preview }, { name: 'sources.zip', kind: 'archive', preview: 'metadata' });
  assert.deepEqual({ name: binary?.name, kind: binary?.kind, preview: binary?.preview }, { name: 'unknown.payload', kind: 'binary', preview: 'metadata' });
});

test('聊天附件合并拒绝重复元数据并严格限制为实际可提交的 8 项', () => {
  const first = mergeComposerAttachments([], list(item('brief.md', 120)));
  assert.equal(mergeComposerAttachments(first, list(item('brief.md', 120))).length, 1);
  const many = list(...Array.from({ length: 30 }, (_, index) => item(`note-${index}.md`, index + 1)));
  assert.equal(mergeComposerAttachments([], many).length, 8);
});

test('聊天附件只在本次页面内存中保留 File 候选，按名称与大小去重且不读取字节', () => {
  const first = mergeComposerFileAttachments([], list(item('brief.md', 120), item('data.json', 80)));
  const merged = mergeComposerFileAttachments(first, list(item('brief.md', 120), item('source.ts', 40)));
  assert.equal(merged.length, 3);
  assert.equal(merged[0]?.file.name, 'brief.md');
  assert.equal(merged[2]?.descriptor.name, 'source.ts');
});
