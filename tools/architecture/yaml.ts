/**
 * 受限 YAML 子集解析器。
 *
 * 为什么手写：`architecture-policy.yaml` 只需要一小撮结构，而仓库没有把 YAML
 * 解析库声明为直接依赖（`node_modules` 里能被解析到的 `yaml` 是别处的传递依赖，
 * 不可依赖）。为了不为了解析策略文件而新增依赖，这里实现一个**受限子集**解析器，
 * 只覆盖策略文件真正使用的语法。
 *
 * 支持：
 * - 块映射 `key: value`；
 * - 块序列 `- value` / `- key: value`（序列项内的后续键与 `- ` 后首键对齐）；
 * - 内联流序列 `[a, b]`（含空 `[]`）；
 * - 内联流映射 `{a: b, c: d}`；
 * - 标量：`'单引号'` / `"双引号"` / `true` / `false` / `null` / 整数 / 裸字符串；
 * - 整行注释与行尾注释（`#` 前需为行首或空白，且不在引号内）。
 *
 * 不支持（会显式报错，避免静默误读）：tab 缩进、锚点/别名、多行标量（`|`/`>`）、
 * 跨行的内联流序列、重复键覆盖。
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface SourceLine {
  readonly indent: number;
  readonly text: string;
}

/** 解析失败时抛出，携带可定位到行的信息。 */
export class YamlSubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YamlSubsetError';
  }
}

/** 去掉引号外的注释；`#` 只有位于行首或空白之后才开启注释。 */
function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble && (index === 0 || /\s/.test(raw[index - 1] ?? ''))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function toSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const rawLines = source.split(/\r?\n/);
  rawLines.forEach((raw, index) => {
    if (/^\s*\t/.test(raw) || /^\t/.test(raw)) {
      throw new YamlSubsetError(`第 ${index + 1} 行使用了 tab 缩进，策略文件只允许空格缩进`);
    }
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === '') return;
    const indent = /^( *)/.exec(withoutComment)?.[1].length ?? 0;
    lines.push({ indent, text: withoutComment.trim() });
  });
  return lines;
}

function isSequenceItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function isMappingEntry(text: string): boolean {
  try {
    splitKey(text);
    return true;
  } catch {
    return false;
  }
}

/** 在顶层（引号与括号之外）寻找 `: ` 分隔符。 */
function splitKey(text: string): { key: string; rest: string } {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') depth -= 1;
      else if (char === ':' && depth === 0 && (text[index + 1] === undefined || text[index + 1] === ' ')) {
        const key = text.slice(0, index).trim();
        if (key === '') throw new YamlSubsetError(`键为空: ${text}`);
        return { key, rest: text.slice(index + 1).trim() };
      }
    }
  }
  throw new YamlSubsetError(`缺少键值分隔符 ": ": ${text}`);
}

function parsePlainScalar(text: string): YamlValue {
  const value = text.trim();
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** 按顶层逗号切分内联流内容，保留嵌套括号。 */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (const char of inner) {
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') depth -= 1;
      else if (char === ',' && depth === 0) {
        items.push(current);
        current = '';
        continue;
      }
    }
    current += char;
  }
  if (current.trim() !== '') items.push(current);
  return items;
}

function parseScalar(text: string): YamlValue {
  const value = text.trim();
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new YamlSubsetError(`内联流序列缺少 "]"：${value}`);
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlowItems(inner).map((item) => parseScalar(item));
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new YamlSubsetError(`内联流映射缺少 "}"：${value}`);
    const inner = value.slice(1, -1).trim();
    const result: { [key: string]: YamlValue } = {};
    if (inner === '') return result;
    for (const item of splitFlowItems(inner)) {
      const { key, rest } = splitKey(item.trim());
      assertNoDuplicateKey(result, key);
      result[key] = parseScalar(rest);
    }
    return result;
  }
  return parsePlainScalar(value);
}

function parseSequence(lines: SourceLine[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent !== indent || !isSequenceItem(line.text)) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') {
      const [value, next] = parseBlock(lines, index + 1, indent + 1);
      items.push(value);
      index = next;
      continue;
    }
    if (isMappingEntry(rest)) {
      // `- key: value`：该项是一个映射，首键来自本行，后续键与 `- ` 之后的内容对齐。
      const [value, next] = parseMapping(lines, index + 1, indent + 2, { indent: indent + 2, text: rest });
      items.push(value);
      index = next;
      continue;
    }
    items.push(parseScalar(rest));
    index += 1;
  }
  return [items, index];
}

/**
 * 重复键必须显式报错：静默「后者覆盖前者」会让策略文件被误读，
 * 而策略文件是 spec-first 的源头，误读代价远高于报错。
 */
function assertNoDuplicateKey(target: { [key: string]: YamlValue }, key: string): void {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new YamlSubsetError(`重复键：${key}`);
  }
}

function parseMapping(
  lines: SourceLine[],
  start: number,
  indent: number,
  syntheticFirst: SourceLine | null,
): [{ [key: string]: YamlValue }, number] {
  const result: { [key: string]: YamlValue } = {};
  let index = start;

  // 记录键值：`rest` 为空表示值是一个子块，从 `childStart` 开始解析。
  const assignKey = (text: string, childStart: number): number => {
    const { key, rest } = splitKey(text);
    assertNoDuplicateKey(result, key);
    if (rest === '') {
      const [value, next] = parseBlock(lines, childStart, indent + 1);
      result[key] = value;
      return next;
    }
    result[key] = parseScalar(rest);
    return childStart;
  };

  if (syntheticFirst) index = assignKey(syntheticFirst.text, index);

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) throw new YamlSubsetError(`缩进异常（期望 ${indent}，实际 ${line.indent}）：${line.text}`);
    if (isSequenceItem(line.text)) break;
    const next = assignKey(line.text, index + 1);
    index = next > index ? next : index + 1;
  }
  return [result, index];
}

function parseBlock(lines: SourceLine[], start: number, minIndent: number): [YamlValue, number] {
  const first = lines[start];
  if (first === undefined || first.indent < minIndent) return [null, start];
  if (isSequenceItem(first.text)) return parseSequence(lines, start, first.indent);
  return parseMapping(lines, start, first.indent, null);
}

/** 解析受限 YAML 子集，返回普通 JS 值。 */
export function parseYamlSubset(source: string): YamlValue {
  const lines = toSourceLines(source);
  const [value, next] = parseBlock(lines, 0, 0);
  if (next !== lines.length) {
    const remaining = lines[next];
    throw new YamlSubsetError(`未能解析完整个文档，剩余内容：${remaining?.text ?? ''}`);
  }
  return value;
}
