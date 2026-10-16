// 记忆 recall —— 清单扫描、确定性选择、有界读取。
//
// 设计来源：ZCode v3.15.1（Apache-2.0）`apps/zcode-cli/packages/core/src/memory/recall/`
// 的 manifest / selector / content 三件套。**未复制任何代码**，只研读其设计约束并按 b07 形态
// 重写（详见 THIRD-PARTY-NOTICES.md）。三处保留的设计约束：
//
//   ① **清单与内容分离**：先把「有哪些记忆、各自讲什么」压成一份短清单（文件名 + description
//      + 时间），再按需只读被选中的少数几条。若一上来就把全部记忆读进上下文，等于没有选择。
//   ② **有界读取**：单条记忆按「行数 + 字节数」双上限裁切，且**按完整行裁切**（不切断多字节
//      字符），并在正文里留下明确的截断说明与完整文件路径，让模型知道该去 `Read` 全文。
//   ③ **陈旧标注**：记忆是时间点观察，不是实时状态。超过阈值的记忆在标题里显式写明「多少天前
//      的观察，断言前须对照当前代码核实」——上游洞察是模型会把记忆当权威事实引用。
//
// b07 形态与差异（重要）：
//   - **不调模型**：上游的选择器是一次辅助模型调用（把 manifest 喂给模型、让模型返回文件名）。
//     b07 的 agent-runtime 没有模型端口（architecture-policy 规定其只依赖
//     protocol / capability-placeholder），也不该有——它必须保持确定性、可单测、
//     不发网络请求。故默认实现是**确定性打分**：词面匹配 + 类型权重 + 规模回退，
//     并在 `MemoryRecallSelector` 上留接缝，模型驱动的选择器由调用方注入。
//   - **路径去重而非文件名去重**：上游按 `filename` 去重，不同子目录的同名文件会互相顶掉；
//     b07 按绝对路径去重（`filename` 只用于展示），因为记忆可以分主题放子目录。
//   - **失败逐项收敛**：单个文件读不动（权限、编码、并发删除）不影响其余条目——与上游
//     `Promise.allSettled` 同款姿态，但这里是同步的，用逐项 try/catch 表达。

import { basename, relative, sep } from 'node:path';
import {
  DEFAULT_MEMORY_RECALL_LIMITS,
  MEMORY_RECALL_TYPE_WEIGHT,
  UNTYPED_MEMORY_WEIGHT,
  isMemoryRecallType,
  type MemoryFileContent,
  type MemoryFileSystemPort,
  type MemoryManifestEntry,
  type MemoryManifestScan,
  type MemoryRecallLimits,
  type MemoryRecallSelectionInput,
  type MemoryRecallSelector,
  type MemoryRecallType,
  type RecalledMemory,
} from './memory-recall-contract.js';

/** 清单排除的文件名：`MEMORY.md` 是总览索引，不是一条可召回的记忆。 */
const MANIFEST_EXCLUDED_BASENAME = 'MEMORY.md';

const DAY_MS = 86_400_000;

/**
 * 扫描记忆根目录，生成清单。
 *
 * `status` 只区分 `ok` / `missing`：目录不存在是 `missing`（不是错误，工作区可以没有记忆），
 * 目录存在但一条也扫不出是 `ok` + 空清单。空清单与 missing 的差别对 UI 有意义——
 * 「还没建记忆」与「记忆目录没找到」要给主人不同的提示。
 */
export function scanMemoryManifest(input: {
  fileSystem: MemoryFileSystemPort;
  rootDir: string;
  limits?: Partial<MemoryRecallLimits>;
}): MemoryManifestScan {
  const limits = { ...DEFAULT_MEMORY_RECALL_LIMITS, ...input.limits };
  let paths: readonly string[];
  try {
    paths = collectMemoryPaths(input.fileSystem, input.rootDir);
  } catch {
    // 根目录不存在或不可读：按 missing 处理。记忆是可选增强，缺了不该让装配失败。
    return { status: 'missing', entries: [] };
  }
  const scanned: MemoryManifestEntry[] = [];
  for (const filePath of paths) {
    const entry = readManifestEntry(input.fileSystem, input.rootDir, filePath, limits);
    if (entry) scanned.push(entry);
  }
  scanned.sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath));
  return { status: 'ok', entries: scanned.slice(0, limits.manifestFileLimit) };
}

function collectMemoryPaths(
  fileSystem: MemoryFileSystemPort,
  directory: string,
): readonly string[] {
  const listed = fileSystem.listDirectory(directory);
  const paths: string[] = [];
  for (const entry of listed) {
    if (entry.kind === 'directory') {
      paths.push(...collectMemoryPaths(fileSystem, entry.path));
      continue;
    }
    if (entry.kind === 'file') {
      if (isMemoryCandidate(entry.path)) paths.push(entry.path);
      continue;
    }
    // 符号链接：只有当它最终指向普通文件时才收录。指向目录的链接**不递归**
    // （避免环），指向外部的链接由端口的实现层负责拒绝（记忆目录不得越界读取）。
    if (entry.kind !== 'symlink' || !isMemoryCandidate(entry.path)) continue;
    paths.push(entry.path);
  }
  return paths;
}

function isMemoryCandidate(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md') && basename(filePath) !== MANIFEST_EXCLUDED_BASENAME;
}

function readManifestEntry(
  fileSystem: MemoryFileSystemPort,
  rootDir: string,
  filePath: string,
  limits: MemoryRecallLimits,
): MemoryManifestEntry | undefined {
  try {
    // 先取元数据（不读内容）：清单只需要 mtime + frontmatter，
    // 若为列出 200 条而把 200 个文件整体读一遍，就违背了「清单要轻」的初衷。
    const stat = fileSystem.stat(filePath);
    if (!stat.isFile) return undefined;
    const head = fileSystem.readHead(filePath, limits.frontmatterLineLimit);
    const frontmatter = parseMemoryFrontmatter(head.content);
    const relativeName = relative(rootDir, filePath).split(sep).join('/');
    return {
      filePath,
      filename: relativeName,
      mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      ...(frontmatter.type ? { type: frontmatter.type } : {}),
    };
  } catch {
    // 单个文件不可读（权限 / 编码 / 扫描期间被删）不影响其余条目。
    return undefined;
  }
}

/**
 * 解析记忆文件的 frontmatter 子集：只认 `description`，以及 `type` 或 `metadata.type`。
 *
 * 刻意**不引入 YAML 依赖**：本包零运行时依赖（package.json 无 dependencies），
 * 且记忆 frontmatter 的实际形态极简（`---` 包围的 `key: value` 若干行）。
 * 宽松解析落在「合法就取、不合法就当作没有标注」，与本仓库对 subagent-profile
 * frontmatter 的一贯姿态一致——配置写错不该让整条记忆消失。
 */
export function parseMemoryFrontmatter(content: string): {
  description?: string;
  type?: MemoryRecallType;
} {
  const normalized = content.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return {};

  let description: string | undefined;
  let typeValue: string | undefined;
  let metadataTypeValue: string | undefined;
  let inMetadata = false;
  let metadataIndent = -1;

  for (const rawLine of lines.slice(1, end)) {
    const line = rawLine.replace(/\s+$/u, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u.exec(line.trim());
    if (!match) continue;
    const key = match[1]!;
    const value = stripQuotes(match[2]!.trim());

    if (inMetadata && indent <= metadataIndent) inMetadata = false;
    if (key === 'metadata' && value === '') {
      inMetadata = true;
      metadataIndent = indent;
      continue;
    }
    if (inMetadata) {
      if (key === 'type' && value) metadataTypeValue = value;
      continue;
    }
    if (key === 'description' && value) description = value;
    if (key === 'type' && value) typeValue = value;
  }

  // 顶层 type 优先于嵌套 metadata.type：顶层更靠近文件语义、更明确。
  const type = toMemoryRecallType(typeValue) ?? toMemoryRecallType(metadataTypeValue);
  return {
    ...(description ? { description } : {}),
    ...(type ? { type } : {}),
  };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function toMemoryRecallType(value: string | undefined): MemoryRecallType | undefined {
  return isMemoryRecallType(value) ? value : undefined;
}

/**
 * 默认的确定性选择器：词面匹配 + 类型权重。
 *
 * 打分口径与 memory-ledger 的 `selectForContext` **刻意保持同构**（类型权重 + 词面命中 ×10），
 * 这样「账本记忆」与「文件记忆」在 L2 里的排序理由一致，审计时不必学两套。
 *
 * 与上游的差别是**没有模型**：上游让模型读 description 做判断，本实现只看词面。
 * 词面匹配会在「问题里偶然出现同一词」时过度召回，故用 `type` 权重压制
 * （未标注记忆权重最低），并把上限压到 5 条——宁可少召，不要把无关记忆塞进上下文。
 */
export class LexicalMemoryRecallSelector implements MemoryRecallSelector {
  select(input: MemoryRecallSelectionInput): readonly string[] {
    if (input.limit <= 0) return [];
    const terms = new Set(tokenize(input.query));
    if (terms.size === 0) return [];

    const scored = input.manifest
      .filter((entry) => !input.recalledPaths.has(entry.filePath))
      .map((entry) => {
        // 比较词元集合而不是子串：中文经「单字 + 二元组」切分后，子串匹配会漏掉
        // 「查询是长句、描述是短词」这种最常见情形。
        const haystack = new Set(tokenize(`${entry.filename} ${entry.description ?? ''}`));
        let lexical = 0;
        for (const term of terms) if (haystack.has(term)) lexical += 1;
        const weight = entry.type ? MEMORY_RECALL_TYPE_WEIGHT[entry.type] : UNTYPED_MEMORY_WEIGHT;
        return { entry, lexical, score: lexical * 10 + weight };
      })
      // 词面零命中的记忆不召回：没有信号就交给主人自己显式 @ 引用，而不是猜。
      .filter((candidate) => candidate.lexical > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.entry.mtimeMs - left.entry.mtimeMs ||
          left.entry.filePath.localeCompare(right.entry.filePath),
      );

    return scored.slice(0, input.limit).map((candidate) => candidate.entry.filePath);
  }
}

/**
 * 词元化：与 `SqliteVectorKnowledgeStore` 的 `lexemes()` **同一口径**——英文/数字取词项，
 * 汉字连续文本同时取单字与相邻二元组。
 *
 * 为什么不用一个 `[\p{L}\p{N}]+` 了事：那样「测试策略是什么」会切成一整个词元，
 * 与记忆描述里的「测试」永远匹配不上，中文记忆的选择器会静默失灵。取单字 + 二元组
 * 让中文有部分匹配能力，同时又比纯单字（噪声太大）精确。
 *
 * 前缀 `han:` / `han2:` / `word:` 与知识库一致，便于排障时一眼看出是哪种词元命中。
 */
function tokenize(value: string): readonly string[] {
  const result: string[] = [];
  for (const run of value.toLocaleLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(run)) {
      for (const character of run) result.push(`han:${character}`);
      for (let index = 0; index < run.length - 1; index += 1) result.push(`han2:${run.slice(index, index + 2)}`);
    } else {
      result.push(`word:${run}`);
    }
  }
  return result;
}

/**
 * 读取被选中的记忆，产出可直接注入上下文的正文。
 *
 * 每一条独立收敛：读不动的条目从结果里消失（而不是产出半条空记忆污染上下文）。
 */
export function readRecalledMemories(input: {
  fileSystem: MemoryFileSystemPort;
  entries: readonly MemoryManifestEntry[];
  nowMs: number;
  limits?: Partial<MemoryRecallLimits>;
}): readonly RecalledMemory[] {
  const limits = { ...DEFAULT_MEMORY_RECALL_LIMITS, ...input.limits };
  const recalled: RecalledMemory[] = [];
  for (const entry of input.entries) {
    const memory = readRecalledMemory(input.fileSystem, entry, input.nowMs, limits);
    if (memory) recalled.push(memory);
  }
  return recalled;
}

function readRecalledMemory(
  fileSystem: MemoryFileSystemPort,
  entry: MemoryManifestEntry,
  nowMs: number,
  limits: MemoryRecallLimits,
): RecalledMemory | undefined {
  let whole: MemoryFileContent;
  try {
    whole = fileSystem.readWhole(entry.filePath);
  } catch {
    return undefined;
  }

  const normalized = whole.content.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const allLines = normalized === '' ? [] : normalized.split('\n');
  const lineBounded = allLines.slice(0, limits.contentLineLimit);
  const byteBounded = limitCompleteLinesByBytes(lineBounded.join('\n'), limits.contentByteLimit);

  const lineTruncated = allLines.length > limits.contentLineLimit;
  const truncated = byteBounded.truncated || lineTruncated;
  // 用**刚读到的** mtime 而非清单里的缓存值：内容与时间来自同一次读取，
  // 避免「扫描后被改过」时标题写着旧时间、正文却是新的。
  const mtimeMs = Number.isFinite(whole.mtimeMs) ? whole.mtimeMs : entry.mtimeMs;
  const stale = isStale(mtimeMs, nowMs, limits.staleDayThreshold);

  return {
    filePath: entry.filePath,
    filename: entry.filename,
    mtimeMs,
    content: byteBounded.content,
    header: memoryHeader(entry.filename, mtimeMs, nowMs, limits.staleDayThreshold),
    ...(truncated ? { truncatedLineCount: byteBounded.lineCount } : {}),
    sizeBytes: whole.sizeBytes,
    stale,
  };
}

/**
 * 按**完整行**裁切到字节上限。
 *
 * 若某一行本身就超过上限（例如一整行压缩过的 JSON），返回空内容并标记截断——
 * 绝不为了塞进一点内容而切断多字节字符（那会产出替换字符，模型会当成正文）。
 */
function limitCompleteLinesByBytes(content: string, byteLimit: number): {
  content: string;
  lineCount: number;
  truncated: boolean;
} {
  if (content === '') return { content: '', lineCount: 0, truncated: false };
  const lines = content.split('\n');
  const selected: string[] = [];
  let selectedBytes = 0;
  for (const line of lines) {
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const nextBytes = selectedBytes + separatorBytes + byteLength(line);
    if (nextBytes > byteLimit) {
      return { content: selected.join('\n'), lineCount: selected.length, truncated: true };
    }
    selected.push(line);
    selectedBytes = nextBytes;
  }
  return { content: selected.join('\n'), lineCount: selected.length, truncated: false };
}

// 不用 Buffer：工作台是浏览器上下文，`Buffer` 不存在。用 TextEncoder 度量 UTF-8 字节数。
const utf8 = new TextEncoder();

function byteLength(value: string): number {
  return utf8.encode(value).length;
}

function isStale(mtimeMs: number, nowMs: number, thresholdDays: number): boolean {
  if (!Number.isFinite(mtimeMs) || thresholdDays < 0) return false;
  return (nowMs - mtimeMs) / DAY_MS > thresholdDays;
}

function memoryHeader(filename: string, mtimeMs: number, nowMs: number, thresholdDays: number): string {
  if (!isStale(mtimeMs, nowMs, thresholdDays)) return `Memory: ${filename}:`;
  const daysOld = Math.max(0, Math.floor((nowMs - mtimeMs) / DAY_MS));
  // 上游洞察：模型会把记忆当权威事实引用，故陈旧记忆必须自带免责声明。
  return (
    `This memory is ${daysOld} days old. Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n\n` +
    `Memory: ${filename}:`
  );
}

/**
 * 把召回的记忆拼成一段可注入的附件文本。
 *
 * 「Retrieved for possible relevance」这句前缀是上游的措辞，作用是把记忆从「事实」降级为
 * 「候选参考」——否则模型会把召回的偏好当成硬性指令执行。
 */
export function formatRecalledMemories(memories: readonly RecalledMemory[]): string {
  return memories
    .map(
      (memory, index) =>
        `${index === 0 ? 'Retrieved for possible relevance — use only if it actually applies to what the user asked.\n\n' : ''}${memory.header}\n\n${memory.content}`,
    )
    .join('\n\n');
}

/** 供 UI 显示的清单文本（未选中的记忆也列出来，让主人知道「有哪些没被召回」）。 */
export function formatMemoryManifest(entries: readonly MemoryManifestEntry[]): string {
  return entries
    .map((entry) => {
      const type = entry.type ? `[${entry.type}] ` : '';
      const timestamp = new Date(entry.mtimeMs).toISOString();
      const base = `- ${type}${entry.filename} (${timestamp})`;
      return entry.description ? `${base}: ${entry.description}` : base;
    })
    .join('\n');
}

/**
 * 一步完成「扫描 → 选择 → 读取」，并把已召回路径并入 `recalledPaths`。
 *
 * 上层（工作台 / ContextAssembler 的调用方）只需调这一个函数；中间三步都各有独立单测。
 */
export function recallMemoriesForQuery(input: {
  fileSystem: MemoryFileSystemPort;
  rootDir: string;
  query: string;
  nowMs: number;
  recalledPaths: Set<string>;
  limit?: number;
  selector?: MemoryRecallSelector;
  limits?: Partial<MemoryRecallLimits>;
}): readonly RecalledMemory[] {
  const scan = scanMemoryManifest({
    fileSystem: input.fileSystem,
    rootDir: input.rootDir,
    ...(input.limits ? { limits: input.limits } : {}),
  });
  if (scan.entries.length === 0) return [];

  const selector = input.selector ?? new LexicalMemoryRecallSelector();
  const selectedPaths = selector.select({
    manifest: scan.entries,
    query: input.query,
    recalledPaths: input.recalledPaths,
    limit: input.limit ?? 5,
  });

  const byPath = new Map(scan.entries.map((entry) => [entry.filePath, entry]));
  const selected = selectedPaths
    .map((path) => byPath.get(path))
    .filter((entry): entry is MemoryManifestEntry => entry !== undefined);

  const recalled = readRecalledMemories({
    fileSystem: input.fileSystem,
    entries: selected,
    nowMs: input.nowMs,
    ...(input.limits ? { limits: input.limits } : {}),
  });
  // 只有真正读出来的才登记为「已召回」——读失败的下轮可以再试。
  for (const memory of recalled) input.recalledPaths.add(memory.filePath);
  return recalled;
}
