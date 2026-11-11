import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readPluginMentionQuery } from '../src/components/workspace/PluginMentionPicker';

describe('readPluginMentionQuery', () => {
  it('光标紧跟 @ 时给出空查询', () => {
    const result = readPluginMentionQuery('帮我 @', 4);
    assert.deepEqual(result, { query: '', start: 3, end: 4 });
  });

  it('@ 后跟了名字片段', () => {
    const text = '帮我 @file';
    const result = readPluginMentionQuery(text, text.length);
    assert.deepEqual(result, { query: 'file', start: 3, end: text.length });
  });

  it('带 marketplace 的 stable id 也能被完整捕获', () => {
    const text = '@filesystem@official';
    const result = readPluginMentionQuery(text, text.length);
    assert.equal(result?.query, 'filesystem@official');
  });

  it('@ 与光标之间隔了空格 → 不是引用（正文里的 @）', () => {
    assert.equal(readPluginMentionQuery('@foo bar', 8), undefined);
  });

  it('行首的 @ 也认', () => {
    const text = '@abc';
    const result = readPluginMentionQuery(text, text.length);
    assert.deepEqual(result, { query: 'abc', start: 0, end: text.length });
  });

  it('没有 @ → undefined', () => {
    assert.equal(readPluginMentionQuery('普通文本', 4), undefined);
  });

  it('@ 在句子中间时，替换范围只覆盖 @ 段', () => {
    // 用(0) 空格(1) @(2) f(3) s(4) → 光标停在 5 时 @fs 完整
    const text = '用 @fs 列目录';
    const result = readPluginMentionQuery(text, 5);
    assert.equal(result?.start, 2);
    assert.equal(result?.end, 5);
    assert.equal(text.slice(result?.start ?? 0, result?.end ?? 0), '@fs');
  });
});
