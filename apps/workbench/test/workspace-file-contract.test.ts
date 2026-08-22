import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyWorkspaceFile, parseWorkspaceFilePreferences } from '../src/runtime/workspace-file-contract.js';

const file = (name: string, size: number): File => ({ name, size } as File);

test('工作区导入将常见文本和代码标为限长只读预览，不读取文件内容', () => {
  const markdown = classifyWorkspaceFile(file('notes.md', 1024));
  const typescript = classifyWorkspaceFile(file('app.ts', 1024));
  assert.equal(markdown.kind, 'text');
  assert.equal(markdown.preview, 'text');
  assert.equal(typescript.kind, 'text');
  assert.equal(typescript.preview, 'text');
  assert.equal(classifyWorkspaceFile(file('large.json', 300 * 1024)).preview, 'metadata');
});

test('工作区导入将文档、压缩包、媒体和未知二进制只登记为元数据', () => {
  assert.deepEqual({ kind: classifyWorkspaceFile(file('brief.pdf', 2048)).kind, preview: classifyWorkspaceFile(file('brief.pdf', 2048)).preview }, { kind: 'document', preview: 'metadata' });
  assert.deepEqual({ kind: classifyWorkspaceFile(file('source.7z', 2048)).kind, preview: classifyWorkspaceFile(file('source.7z', 2048)).preview }, { kind: 'archive', preview: 'metadata' });
  assert.deepEqual({ kind: classifyWorkspaceFile(file('clip.webm', 2048)).kind, preview: classifyWorkspaceFile(file('clip.webm', 2048)).preview }, { kind: 'media', preview: 'metadata' });
  assert.deepEqual({ kind: classifyWorkspaceFile(file('unknown.bin', 2048)).kind, preview: classifyWorkspaceFile(file('unknown.bin', 2048)).preview }, { kind: 'binary', preview: 'metadata' });
});

test('工作区偏好只保存脱敏标签，不接受绝对路径或未知输出目标', () => {
  assert.deepEqual(parseWorkspaceFilePreferences({ outputTarget: 'selected-workspace', workspaceLabel: 'Research workspace' }), { schemaVersion: 1, outputTarget: 'selected-workspace', workspaceLabel: 'Research workspace' });
  assert.deepEqual(parseWorkspaceFilePreferences({ outputTarget: 'selected-workspace', workspaceLabel: 'C:\\Users\\bear\\secret' }), { schemaVersion: 1, outputTarget: 'selected-workspace', workspaceLabel: undefined });
  assert.equal(parseWorkspaceFilePreferences({ outputTarget: 'anything' }).outputTarget, 'app-managed');
});
