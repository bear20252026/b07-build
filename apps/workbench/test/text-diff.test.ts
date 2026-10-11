import assert from 'node:assert/strict';
import test from 'node:test';
import { countDiffLines, diffLines, MAX_DIFF_LINES } from '../src/runtime/text-diff';

const kinds = (previous: readonly string[], next: readonly string[]): string => diffLines(previous, next).map((line) => `${line.kind === 'same' ? ' ' : line.kind === 'added' ? '+' : '-'}${line.text}`).join('\n');

test('内容完全一致时不产生任何增删', () => {
  const diff = diffLines(['a', 'b'], ['a', 'b']);
  assert.equal(diff.every((line) => line.kind === 'same'), true);
  assert.deepEqual(countDiffLines(diff), { removed: 0, added: 0 });
});

test('只改一行时只标记那一行', () => {
  assert.equal(kinds(['a', 'b', 'c'], ['a', 'B', 'c']), ' a\n-b\n+B\n c');
});

test('纯新增与纯删除', () => {
  assert.equal(kinds(['a'], ['a', 'b']), ' a\n+b');
  assert.equal(kinds(['a', 'b'], ['a']), ' a\n-b');
});

test('整段替换不会把公共前后缀算进去', () => {
  const diff = diffLines(['fn main() {', '    old();', '}'], ['fn main() {', '    new();', '}']);
  assert.deepEqual(countDiffLines(diff), { removed: 1, added: 1 });
});

test('空输入', () => {
  assert.deepEqual(diffLines([], []), []);
  assert.deepEqual(countDiffLines(diffLines([], ['a'])), { removed: 0, added: 1 });
  assert.deepEqual(countDiffLines(diffLines(['a'], [])), { removed: 1, added: 0 });
});

test('超大文件退化为整体对比而不是卡死', () => {
  const huge = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, index) => `line ${index}`);
  const diff = diffLines(huge, ['only one']);
  // 退化形态：全部旧行在前，全部新行在后。
  assert.equal(diff.filter((line) => line.kind === 'removed').length, huge.length);
  assert.equal(diff.filter((line) => line.kind === 'added').length, 1);
});

test('diff 结果能还原出目标内容', () => {
  // 不管算法怎么切分，把 same 与 added 拼回去必须等于新内容——否则用户看到的就不是将要写入的东西。
  const previous = ['a', 'b', 'c', 'd'];
  const next = ['a', 'x', 'c', 'd', 'e'];
  const rebuilt = diffLines(previous, next).filter((line) => line.kind !== 'removed').map((line) => line.text);
  assert.deepEqual(rebuilt, next);
});
