// 一个文件=一种作用：把 PatchChunk 应用到文件内容上，产出新内容。
// 移植自 ZCode（Apache-2.0 License）apps/zcode-cli/packages/core/src/tool/patch-apply.ts，
// 相对上游的两处刻意差异（b07 审计结论）：
// 1. 行尾与末尾换行保留——上游统一归一化为 \n 并强制补末尾换行；这里检测原文件的
//    CRLF 与「无末尾换行」状态，应用后原样恢复，避免改掉模型未指定的部分；
// 2. 匹配严格度外显——匹配阶梯（精确 → trimEnd → trim → Unicode 归一化）保留以维持
//    补丁成功率，但结果带 strict 标志：任一 chunk 走了宽松匹配即为 false，
//    由调用方（审批界面）决定是否放行/提示。

import type { PatchChunk } from './patch-parser.js';

export interface PatchApplyResult {
  content: string;
  /** true = 所有 chunk（含 changeContext）都以逐字符精确匹配命中，未触发任何宽松回退。 */
  strict: boolean;
}

type Replacement = [startIndex: number, oldLineCount: number, newLines: string[]];
type Comparator = (actual: string, expected: string) => boolean;

/** 匹配阶梯：从精确到宽松逐级回退，index 越大越宽松。 */
const COMPARATORS: readonly Comparator[] = [exactCompare, trimEndCompare, trimCompare, normalizedCompare];

export function derivePatchedContent(content: string, chunks: PatchChunk[]): PatchApplyResult {
  const eol = detectLineEnding(content);
  const endsWithNewline = content.endsWith('\n');
  const { lines: originalLines, hadTrailingEmpty } = splitLogicalLines(normalizeLineEndings(content));
  const { replacements, strict } = computeReplacements(originalLines, chunks);
  const nextLines = applyReplacements(originalLines, replacements);
  if (hadTrailingEmpty) {
    nextLines.push('');
  }
  // join 后的末尾换行由「原文件是否有末尾换行」决定，恢复无末尾换行文件的原状。
  return { content: nextLines.join(eol) + (endsWithNewline && nextLines[nextLines.length - 1] !== '' ? eol : ''), strict };
}

function computeReplacements(
  lines: string[],
  chunks: PatchChunk[],
): { replacements: Replacement[]; strict: boolean } {
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  let strict = true;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextMatch = findMatch(lines, [chunk.changeContext], lineIndex, chunk.endOfFile === true);
      if (!contextMatch) {
        throw new Error(`Failed to find context '${chunk.changeContext}'`);
      }
      if (!contextMatch.strict) strict = false;
      lineIndex = contextMatch.index + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let match = findMatch(lines, pattern, lineIndex, chunk.endOfFile === true);
    if (!match && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      replacement =
        replacement[replacement.length - 1] === '' ? replacement.slice(0, -1) : replacement;
      match = findMatch(lines, pattern, lineIndex, chunk.endOfFile === true);
    }

    if (!match) {
      throw new Error(`Failed to find expected lines:\n${chunk.oldLines.join('\n')}`);
    }
    if (!match.strict) strict = false;
    replacements.push([match.index, pattern.length, replacement]);
    lineIndex = match.index + pattern.length;
  }

  return { replacements: replacements.sort((left, right) => left[0] - right[0]), strict };
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines];
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const [startIndex, oldLineCount, newLines] = replacements[index]!;
    result.splice(startIndex, oldLineCount, ...newLines);
  }
  return result;
}

interface MatchOutcome {
  index: number;
  strict: boolean;
}

function findMatch(lines: string[], pattern: string[], startIndex: number, eof: boolean): MatchOutcome | undefined {
  if (pattern.length === 0) return undefined;
  for (let level = 0; level < COMPARATORS.length; level += 1) {
    const index = tryMatch(lines, pattern, startIndex, COMPARATORS[level]!, eof);
    if (index !== -1) return { index, strict: level === 0 };
  }
  return undefined;
}

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  eof: boolean,
): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex && linesMatch(lines, pattern, fromEnd, compare)) return fromEnd;
  }

  for (let index = startIndex; index <= lines.length - pattern.length; index += 1) {
    if (linesMatch(lines, pattern, index, compare)) return index;
  }
  return -1;
}

function linesMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    if (!compare(lines[startIndex + offset] ?? '', pattern[offset] ?? '')) return false;
  }
  return true;
}

function exactCompare(actual: string, expected: string): boolean {
  return actual === expected;
}

function trimEndCompare(actual: string, expected: string): boolean {
  return actual.trimEnd() === expected.trimEnd();
}

function trimCompare(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}

function normalizedCompare(actual: string, expected: string): boolean {
  return normalizeUnicode(actual.trim()) === normalizeUnicode(expected.trim());
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

/** 文件含 CRLF 即按 CRLF 重组（混合行尾以 CRLF 为主，覆盖 Windows 常见形态）。 */
function detectLineEnding(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/** 切成逻辑行：末尾的空串来自最后的换行符，单独记录而不当作内容行。 */
function splitLogicalLines(content: string): { lines: string[]; hadTrailingEmpty: boolean } {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return { lines: lines.slice(0, -1), hadTrailingEmpty: true };
  }
  return { lines, hadTrailingEmpty: false };
}
