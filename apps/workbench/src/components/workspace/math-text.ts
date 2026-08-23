export type MathSegment =
  | Readonly<{ kind: 'text'; value: string }>
  | Readonly<{ kind: 'inline'; value: string }>
  | Readonly<{ kind: 'block'; value: string }>;

const MATH_TOKEN = /(\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)\$)/g;

/** 将模型文本拆成普通文本、行内公式和块公式；不完整标记保持为原文。 */
export function parseMathSegments(value: string): readonly MathSegment[] {
  const segments: MathSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(MATH_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: 'text', value: value.slice(cursor, index) });
    const token = match[0] ?? '';
    const block = token.startsWith('$$') || token.startsWith('\\[');
    const formula = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (!formula) segments.push({ kind: 'text', value: token });
    else segments.push({ kind: block ? 'block' : 'inline', value: formula });
    cursor = index + token.length;
  }
  if (cursor < value.length) segments.push({ kind: 'text', value: value.slice(cursor) });
  return segments.length ? segments : [{ kind: 'text', value }];
}
