import assert from 'node:assert/strict';
import test from 'node:test';
import { descriptorsFromFiles, mergeComposerAttachments } from '../src/components/workspace/ComposerAttachments.js';

const item = (name: string, size: number): File => ({ name, size } as File);
const list = (...files: File[]): FileList => Object.assign(files, { item: (index: number) => files[index] ?? null }) as unknown as FileList;

test('聊天附件入口只从显式 FileList 分类为脱敏描述符', () => {
  const [markdown, archive, binary] = descriptorsFromFiles(list(item('brief.md', 120), item('sources.zip', 80), item('unknown.payload', 5)), 0);
  assert.deepEqual({ name: markdown?.name, kind: markdown?.kind, preview: markdown?.preview }, { name: 'brief.md', kind: 'text', preview: 'text' });
  assert.deepEqual({ name: archive?.name, kind: archive?.kind, preview: archive?.preview }, { name: 'sources.zip', kind: 'archive', preview: 'metadata' });
  assert.deepEqual({ name: binary?.name, kind: binary?.kind, preview: binary?.preview }, { name: 'unknown.payload', kind: 'binary', preview: 'metadata' });
});

test('聊天附件合并拒绝重复元数据并严格限制为 24 项', () => {
  const first = mergeComposerAttachments([], list(item('brief.md', 120)));
  assert.equal(mergeComposerAttachments(first, list(item('brief.md', 120))).length, 1);
  const many = list(...Array.from({ length: 30 }, (_, index) => item(`note-${index}.md`, index + 1)));
  assert.equal(mergeComposerAttachments([], many).length, 24);
});
