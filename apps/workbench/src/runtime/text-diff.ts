/**
 * 行级差异：用于把「文件将被改成什么样」讲清楚。
 *
 * 这里刻意不引入 diff 库：只需要在确认弹窗里展示一次前后对比，
 * 一个 LCS 就够，而且能自己控制规模上限，避免大文件把界面卡死。
 */

export type DiffKind = 'same' | 'removed' | 'added';
export interface DiffLine { readonly kind: DiffKind; readonly text: string; }

/** 单个文件最多参与 diff 的行数；超出就退化为整体对比。 */
export const MAX_DIFF_LINES = 400;
/** LCS 表规模上限（约 1 MB 的 u32 表）；超出同样退化为整体对比。 */
const MAX_LCS_CELLS = 250_000;

/** 退化形态：先列全部旧行，再列全部新行。宁可难看，也不能让界面失去响应。 */
function coarseDiff(previous: readonly string[], next: readonly string[]): readonly DiffLine[] {
  return [...previous.map((text) => ({ kind: 'removed' as const, text })), ...next.map((text) => ({ kind: 'added' as const, text }))];
}

export function diffLines(previous: readonly string[], next: readonly string[]): readonly DiffLine[] {
  if (previous.length > MAX_DIFF_LINES || next.length > MAX_DIFF_LINES) return coarseDiff(previous, next);
  if (previous.length * next.length > MAX_LCS_CELLS) return coarseDiff(previous, next);

  const columns = next.length + 1;
  const table = new Uint32Array((previous.length + 1) * columns);
  for (let row = previous.length - 1; row >= 0; row -= 1) {
    for (let column = next.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] = previous[row] === next[column]
        ? table[(row + 1) * columns + column + 1]! + 1
        : Math.max(table[(row + 1) * columns + column]!, table[row * columns + column + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < previous.length && column < next.length) {
    if (previous[row] === next[column]) {
      out.push({ kind: 'same', text: previous[row]! });
      row += 1;
      column += 1;
    } else if (table[(row + 1) * columns + column]! >= table[row * columns + column + 1]!) {
      out.push({ kind: 'removed', text: previous[row]! });
      row += 1;
    } else {
      out.push({ kind: 'added', text: next[column]! });
      column += 1;
    }
  }
  for (; row < previous.length; row += 1) out.push({ kind: 'removed', text: previous[row]! });
  for (; column < next.length; column += 1) out.push({ kind: 'added', text: next[column]! });
  return out;
}

export function countDiffLines(lines: readonly DiffLine[]): { readonly removed: number; readonly added: number } {
  let removed = 0;
  let added = 0;
  for (const line of lines) {
    if (line.kind === 'removed') removed += 1;
    else if (line.kind === 'added') added += 1;
  }
  return { removed, added };
}
