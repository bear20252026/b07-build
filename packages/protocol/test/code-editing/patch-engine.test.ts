// 一个文件=一种作用：结构化 Patch 引擎（parser / apply / policy）的验收测试。
// 覆盖矩阵（对应审计整改要求）：多文件解析、非法路径拒绝、CRLF 保留、
// 空文件与无末尾换行、严格/宽松匹配外显、匹配失败抛错（失败不落盘的前提）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePatchedContent } from '../../src/code-editing/patch-apply';
import { parseStructuredPatch, type PatchChunk } from '../../src/code-editing/patch-parser';
import { normalizeRelativePath, planPatchSections } from '../../src/code-editing/patch-policy';

function updateChunks(patchText: string): PatchChunk[] {
  const sections = parseStructuredPatch(patchText);
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.type, 'update');
  return sections[0]!.type === 'update' ? sections[0]!.chunks : [];
}

test('解析多文件 patch：update / add / delete / move 与 End of File 标记', () => {
  const sections = parseStructuredPatch(
    [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@ mark',
      ' const keep = 1;',
      '-const old = 2;',
      '+const fresh = 2;',
      '*** Update File: src/b.ts',
      '*** Move to: src/renamed.ts',
      '@@',
      ' tail line',
      '*** End of File',
      '*** Add File: docs/new.md',
      '+# hello',
      '*** Delete File: tmp/x.log',
      '*** End Patch',
    ].join('\n'),
  );
  assert.equal(sections.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(sections[0])), {
    type: 'update',
    path: 'src/a.ts',
    chunks: [{ oldLines: ['const keep = 1;', 'const old = 2;'], newLines: ['const keep = 1;', 'const fresh = 2;'], changeContext: 'mark', endOfFile: false }],
  });
  assert.equal(sections[1]!.type, 'update');
  assert.equal(sections[1]!.type === 'update' ? sections[1]!.movePath : '', 'src/renamed.ts');
  assert.equal(sections[2]!.type, 'add');
  assert.equal(sections[2]!.type === 'add' ? sections[2]!.contents : '', '# hello\n');
  assert.deepEqual(JSON.parse(JSON.stringify(sections[3])), { type: 'delete', path: 'tmp/x.log' });
});

test('heredoc 包裹与 CRLF 输入都能解析', () => {
  const sections = parseStructuredPatch(
    [
      'cat <<PATCH',
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
      'PATCH',
    ].join('\r\n'),
  );
  assert.equal(sections.length, 1);
});

test('第一期策略：只放行更新已存在文件，add/delete/move/逃逸路径/不存在文件/重复目标全部拒绝', () => {
  const sections = parseStructuredPatch(
    [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Update File: src/b.ts',
      '*** Move to: src/c.ts',
      '@@',
      ' x',
      '*** Add File: src/new.ts',
      '+x',
      '*** Delete File: src/gone.ts',
      '*** Update File: ../../escape.ts',
      '@@',
      ' x',
      '*** Update File: C:/abs/path.ts',
      '@@',
      ' x',
      '*** Update File: src/missing.ts',
      '@@',
      ' x',
      '*** Update File: src/a.ts',
      '@@',
      ' x',
      '*** End Patch',
    ].join('\n'),
  );
  const plan = planPatchSections(sections, { existingFiles: new Set(['src/a.ts', 'src/b.ts']) });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.operations)), [{ kind: 'update', path: 'src/a.ts', chunks: [{ oldLines: ['old'], newLines: ['new'], endOfFile: false }] }]);
  assert.deepEqual(
    plan.rejections.map((item) => [item.path, item.reason]),
    [
      ['src/b.ts', 'phase1-update-only'],
      ['src/new.ts', 'phase1-update-only'],
      ['src/gone.ts', 'phase1-update-only'],
      ['../../escape.ts', 'path-escapes-workspace'],
      ['C:/abs/path.ts', 'path-escapes-workspace'],
      ['src/missing.ts', 'file-not-found'],
      ['src/a.ts', 'duplicate-patch-target'],
    ],
  );
});

test('第二期策略：放开 add/delete/move，但存在性前提仍然成立', () => {
  const sections = parseStructuredPatch(
    [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const fresh = 1;',
      '*** Add File: src/a.ts',
      '+x',
      '*** Delete File: src/old.ts',
      '*** Delete File: src/absent.ts',
      '*** Update File: src/a.ts',
      '*** Move to: src/renamed.ts',
      '@@',
      '-old',
      '+new',
      '*** Update File: src/a.ts',
      '*** Move to: src/old.ts',
      '@@',
      ' x',
      '*** Update File: src/old.ts',
      '*** Move to: ../escape.ts',
      '@@',
      ' x',
      '*** End Patch',
    ].join('\n'),
  );
  const plan = planPatchSections(sections, { existingFiles: new Set(['src/a.ts', 'src/old.ts']), allowStructureChanges: true });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.operations)), [
    { kind: 'add', path: 'src/new.ts', contents: 'export const fresh = 1;\n' },
    { kind: 'delete', path: 'src/old.ts' },
    { kind: 'update', path: 'src/a.ts', chunks: [{ oldLines: ['old'], newLines: ['new'], endOfFile: false }], movePath: 'src/renamed.ts' },
  ]);
  assert.deepEqual(
    plan.rejections.map((item) => [item.path, item.reason]),
    [
      ['src/a.ts', 'file-already-exists'],
      ['src/absent.ts', 'file-not-found'],
      ['src/old.ts', 'file-already-exists'],
      ['src/old.ts', 'path-escapes-workspace'],
    ],
  );
});

test('normalizeRelativePath：反斜杠归一、./ 前缀收敛、控制字符与空段拒绝', () => {
  assert.equal(normalizeRelativePath('src\\lib\\a.ts'), 'src/lib/a.ts');
  assert.equal(normalizeRelativePath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRelativePath('/abs/a.ts'), undefined);
  assert.equal(normalizeRelativePath('../a.ts'), undefined);
  assert.equal(normalizeRelativePath('src//a.ts'), undefined);
  assert.equal(normalizeRelativePath('a\u0000b'), undefined);
  assert.equal(normalizeRelativePath(''), undefined);
});

test('应用：CRLF 文件保留 CRLF 行尾', () => {
  const content = 'const one = 1;\r\nconst two = 2;\r\nconst three = 3;\r\n';
  const chunks = updateChunks(
    [
      '*** Begin Patch',
      '*** Update File: x.ts',
      '@@',
      '-const two = 2;',
      '+const two = 22;',
      '*** End Patch',
    ].join('\n'),
  );
  const result = derivePatchedContent(content, chunks);
  assert.equal(result.content, 'const one = 1;\r\nconst two = 22;\r\nconst three = 3;\r\n');
  assert.equal(result.strict, true);
});

test('应用：无末尾换行的文件保持无末尾换行，有末尾换行的保持有', () => {
  const chunks = updateChunks(['*** Begin Patch', '*** Update File: x.ts', '@@', '-b', '+B', '*** End Patch'].join('\n'));
  const withoutNewline = derivePatchedContent('a\nb\nc', chunks);
  assert.equal(withoutNewline.content, 'a\nB\nc');
  const withNewline = derivePatchedContent('a\nb\nc\n', chunks);
  assert.equal(withNewline.content, 'a\nB\nc\n');
});

test('应用：空文件可被纯插入 chunk 填充', () => {
  const chunks = updateChunks(['*** Begin Patch', '*** Update File: empty.ts', '@@', '+first line', '+second line', '*** End Patch'].join('\n'));
  const result = derivePatchedContent('', chunks);
  assert.equal(result.content, 'first line\nsecond line\n');
});

test('应用：精确匹配 strict=true；trim/Unicode 宽松回退 strict=false（外显给审批界面）', () => {
  const exact = updateChunks(['*** Begin Patch', '*** Update File: x.ts', '@@', '-const value = 1;', '+const value = 2;', '*** End Patch'].join('\n'));
  assert.equal(derivePatchedContent('const value = 1;\n', exact).strict, true);

  const lenient = updateChunks(['*** Begin Patch', '*** Update File: x.ts', '@@', '-const value = 1;  ', '+const value = 2;', '*** End Patch'].join('\n'));
  // 模型多打了行尾空格：精确匹配失败 → trimEnd 回退命中，但 strict=false。
  const lenientResult = derivePatchedContent('const value = 1;\n', lenient);
  assert.equal(lenientResult.content, 'const value = 2;\n');
  assert.equal(lenientResult.strict, false);

  const unicode = updateChunks(['*** Begin Patch', '*** Update File: x.ts', '@@', '-say "hello"', "+say 'hello'", '*** End Patch'].join('\n'));
  // 文件里是弯引号、patch 里是直引号：精确匹配失败 → Unicode 归一化回退命中，strict=false。
  const unicodeResult = derivePatchedContent('say \u201Chello\u201D\n', unicode);
  assert.equal(unicodeResult.content, "say 'hello'\n");
  assert.equal(unicodeResult.strict, false);
});

test('应用：多 chunk 与 changeContext、End of File 锚定、chunk 匹配失败抛错（调用方不落盘）', () => {
  const chunks = updateChunks(
    [
      '*** Begin Patch',
      '*** Update File: x.ts',
      '@@ beta',
      '-gamma',
      '+GAMMA',
      '@@',
      '-omega',
      '+OMEGA',
      '*** End of File',
      '*** End Patch',
    ].join('\n'),
  );
  const result = derivePatchedContent('alpha\nbeta\ngamma\nomega\n', chunks);
  assert.equal(result.content, 'alpha\nbeta\nGAMMA\nOMEGA\n');

  assert.throws(() => derivePatchedContent('nothing\nmatches\nhere\n', chunks), /Failed to find (context|expected lines)/);
});
