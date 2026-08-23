import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMathSegments } from '../src/components/workspace/math-text.js';

test('数学文本分段同时保留普通文字、行内公式和块级公式', () => {
  assert.deepEqual(parseMathSegments('速度 $v=\\frac{s}{t}$。\n\n$$E=mc^2$$'), [
    { kind: 'text', value: '速度 ' },
    { kind: 'inline', value: 'v=\\frac{s}{t}' },
    { kind: 'text', value: '。\n\n' },
    { kind: 'block', value: 'E=mc^2' },
  ]);
});

test('不完整公式标记保持为可读原文而不会丢弃整段回答', () => {
  assert.deepEqual(parseMathSegments('保留 $未闭合公式'), [{ kind: 'text', value: '保留 $未闭合公式' }]);
});
