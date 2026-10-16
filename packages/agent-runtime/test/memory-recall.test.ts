import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_MEMORY_RECALL_LIMITS,
  LexicalMemoryRecallSelector,
  MEMORY_RECALL_TYPES,
  NodeMemoryFileSystem,
  formatMemoryManifest,
  formatRecalledMemories,
  isMemoryRecallType,
  parseMemoryFrontmatter,
  readRecalledMemories,
  recallMemoriesForQuery,
  scanMemoryManifest,
  type MemoryFileSystemPort,
  type MemoryManifestEntry,
  type MemoryRecallSelector,
} from '../src/index.js';

const DAY = 86_400_000;
// 固定时间基准，避免测试依赖真实时钟。
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 假文件系统：精确控制「哪个文件读得动、哪个读不动」，用于覆盖边界。
// ---------------------------------------------------------------------------

interface FakeFile {
  head: string;
  whole: string;
  mtimeMs: number;
  sizeBytes?: number;
  throwOnStat?: boolean;
  throwOnHead?: boolean;
  throwOnWhole?: boolean;
}

class FakeFileSystem implements MemoryFileSystemPort {
  readonly reads: string[] = [];

  constructor(
    private readonly tree: Record<string, readonly { path: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[]>,
    private readonly files: Record<string, FakeFile>,
  ) {}

  listDirectory(path: string): readonly { path: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[] {
    const children = this.tree[path];
    if (!children) throw new Error(`目录不存在：${path}`);
    return children;
  }

  stat(path: string): { mtimeMs: number; sizeBytes: number; isFile: boolean } {
    this.reads.push(`stat:${path}`);
    const file = this.files[path];
    if (!file) throw new Error(`文件不存在：${path}`);
    if (file.throwOnStat) throw new Error('stat 失败');
    return {
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes ?? new TextEncoder().encode(file.whole).length,
      isFile: true,
    };
  }

  readHead(path: string, limitLines: number): { content: string; totalLines: number } {
    this.reads.push(`head:${path}`);
    const file = this.files[path];
    if (!file) throw new Error(`文件不存在：${path}`);
    if (file.throwOnHead) throw new Error('head 读取失败');
    const lines = file.head.split('\n');
    return { content: lines.slice(0, limitLines).join('\n'), totalLines: lines.length };
  }

  readWhole(path: string): { content: string; sizeBytes: number; mtimeMs: number } {
    this.reads.push(`whole:${path}`);
    const file = this.files[path];
    if (!file) throw new Error(`文件不存在：${path}`);
    if (file.throwOnWhole) throw new Error('whole 读取失败');
    return {
      content: file.whole,
      sizeBytes: file.sizeBytes ?? new TextEncoder().encode(file.whole).length,
      mtimeMs: file.mtimeMs,
    };
  }
}

/**
 * 假文件系统的树：目录 → 直接子项的 `{path, kind}` 列表。
 * 路径用完整 POSIX 路径，不经 `join`——避免 Windows 上 `join` 产出反斜杠与夹具键对不上。
 */
function buildFs(
  files: Record<string, FakeFile>,
  dirs: Record<string, readonly string[]> = {},
): FakeFileSystem {
  const tree: Record<string, readonly { path: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[]> = {};
  const collect = (dir: string, candidates: readonly string[]): readonly { path: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[] =>
    candidates
      .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
      .map((path) => ({ path, kind: 'file' as const }));

  tree['/mem'] = collect('/mem', Object.keys(files));
  for (const [dir, children] of Object.entries(dirs)) {
    // dirs 用于显式声明子目录（子目录本身也要出现在父目录的列举里）。
    tree[dir] = children.map((path) => ({ path, kind: 'file' as const }));
    const parent = dir.slice(0, dir.lastIndexOf('/'));
    tree[parent] = [...(tree[parent] ?? []), { path: dir, kind: 'directory' as const }];
  }
  return new FakeFileSystem(tree, files);
}

// ---------------------------------------------------------------------------
// ① 闭集与契约
// ---------------------------------------------------------------------------

test('记忆类型闭集是四个，且只认精确匹配', () => {
  assert.deepEqual([...MEMORY_RECALL_TYPES], ['user', 'feedback', 'project', 'reference']);
  assert.equal(isMemoryRecallType('user'), true);
  assert.equal(isMemoryRecallType('USER'), false);
  assert.equal(isMemoryRecallType('other'), false);
  assert.equal(isMemoryRecallType(undefined), false);
  assert.equal(isMemoryRecallType(3), false);
});

test('默认上限是一组合理的正数（防止有人改成 0 而静默禁用）', () => {
  const limits = DEFAULT_MEMORY_RECALL_LIMITS;
  assert.ok(limits.manifestFileLimit > 0);
  assert.ok(limits.frontmatterLineLimit > 0);
  assert.ok(limits.contentLineLimit > 0);
  assert.ok(limits.contentByteLimit > 0);
  assert.ok(limits.staleDayThreshold >= 0);
  assert.ok(Object.isFrozen(limits), '默认上限必须是冻结的，避免被就地改写');
});

// ---------------------------------------------------------------------------
// ② frontmatter 解析
// ---------------------------------------------------------------------------

test('frontmatter：解析 description 与顶层 type', () => {
  const parsed = parseMemoryFrontmatter('---\ndescription: 关于主人的偏好\ntype: user\n---\n正文');
  assert.equal(parsed.description, '关于主人的偏好');
  assert.equal(parsed.type, 'user');
});

test('frontmatter：解析嵌套 metadata.type', () => {
  const parsed = parseMemoryFrontmatter('---\ndescription: 项目背景\nmetadata:\n  type: project\n---\n正文');
  assert.equal(parsed.description, '项目背景');
  assert.equal(parsed.type, 'project');
});

test('frontmatter：顶层 type 优先于 metadata.type（同层按出现顺序后者不覆盖前者）', () => {
  const parsed = parseMemoryFrontmatter('---\ntype: feedback\nmetadata:\n  type: reference\n---\n');
  assert.equal(parsed.type, 'feedback');
});

test('frontmatter：未知 type 不猜测，直接不标注', () => {
  const parsed = parseMemoryFrontmatter('---\ntype: 不存在的类型\n---\n');
  assert.equal(parsed.type, undefined);
});

test('frontmatter：没有 frontmatter 或未闭合时返回空对象（不抛）', () => {
  assert.deepEqual(parseMemoryFrontmatter('就是一段正文\n没有 frontmatter'), {});
  assert.deepEqual(parseMemoryFrontmatter('---\ndescription: 开了没关\n正文'), {});
  assert.deepEqual(parseMemoryFrontmatter(''), {});
});

test('frontmatter：BOM 与 CRLF 不干扰识别', () => {
  const parsed = parseMemoryFrontmatter('\uFEFF---\r\ndescription: 带 BOM\r\n---\r\n正文');
  assert.equal(parsed.description, '带 BOM');
});

test('frontmatter：引号值去掉外层引号，注释行忽略', () => {
  const parsed = parseMemoryFrontmatter('---\n# 这是注释\ndescription: "带引号的描述"\ntype: \'project\'\n---\n');
  assert.equal(parsed.description, '带引号的描述');
  assert.equal(parsed.type, 'project');
});

// ---------------------------------------------------------------------------
// ③ manifest 扫描
// ---------------------------------------------------------------------------

test('扫描：把 .md 收进清单，排除 MEMORY.md 与非 .md 文件', () => {
  const fs = buildFs({
    '/mem/a.md': { head: '---\ndescription: A\n---', whole: '# A', mtimeMs: NOW - 1 },
    '/mem/MEMORY.md': { head: '# 索引', whole: '# 索引', mtimeMs: NOW },
    '/mem/readme.txt': { head: 'x', whole: 'x', mtimeMs: NOW },
    '/mem/b.md': { head: '---\ntype: project\n---', whole: '# B', mtimeMs: NOW - 2 },
  });
  const scan = scanMemoryManifest({ fileSystem: fs, rootDir: '/mem' });
  assert.equal(scan.status, 'ok');
  assert.deepEqual(
    scan.entries.map((entry) => entry.filename).sort(),
    ['a.md', 'b.md'],
  );
  assert.equal(scan.entries.find((e) => e.filename === 'a.md')?.description, 'A');
  assert.equal(scan.entries.find((e) => e.filename === 'b.md')?.type, 'project');
});

test('扫描：按 mtime 倒序排列（新记忆在前）', () => {
  const fs = buildFs({
    '/mem/old.md': { head: '# old', whole: '# old', mtimeMs: NOW - 100 * DAY },
    '/mem/new.md': { head: '# new', whole: '# new', mtimeMs: NOW },
    '/mem/mid.md': { head: '# mid', whole: '# mid', mtimeMs: NOW - 10 * DAY },
  });
  const scan = scanMemoryManifest({ fileSystem: fs, rootDir: '/mem' });
  assert.deepEqual(scan.entries.map((e) => e.filename), ['new.md', 'mid.md', 'old.md']);
});

test('扫描：mtime 相同时按路径稳定排序（保证清单可复现）', () => {
  const fs = buildFs({
    '/mem/z.md': { head: '# z', whole: '# z', mtimeMs: NOW },
    '/mem/a.md': { head: '# a', whole: '# a', mtimeMs: NOW },
  });
  const scan = scanMemoryManifest({ fileSystem: fs, rootDir: '/mem' });
  assert.deepEqual(scan.entries.map((e) => e.filename), ['a.md', 'z.md']);
});

test('扫描：超过 manifestFileLimit 时按 mtime 截断，保留最新的', () => {
  const fs = buildFs({
    '/mem/a.md': { head: '# a', whole: '# a', mtimeMs: NOW - 3 },
    '/mem/b.md': { head: '# b', whole: '# b', mtimeMs: NOW - 2 },
    '/mem/c.md': { head: '# c', whole: '# c', mtimeMs: NOW - 1 },
  });
  const scan = scanMemoryManifest({ fileSystem: fs, rootDir: '/mem', limits: { manifestFileLimit: 2 } });
  assert.deepEqual(scan.entries.map((e) => e.filename), ['c.md', 'b.md']);
});

test('扫描：单个文件读不动时其他条目照常返回（逐项收敛）', () => {
  const fs = buildFs({
    '/mem/good.md': { head: '# good', whole: '# good', mtimeMs: NOW },
    '/mem/bad-head.md': { head: '', whole: '', mtimeMs: NOW, throwOnHead: true },
    '/mem/bad-stat.md': { head: '# x', whole: '# x', mtimeMs: NOW, throwOnStat: true },
  });
  const scan = scanMemoryManifest({ fileSystem: fs, rootDir: '/mem' });
  assert.equal(scan.status, 'ok');
  assert.deepEqual(scan.entries.map((e) => e.filename), ['good.md']);
});

test('扫描：不为列清单而整体读取文件（只 stat + readHead）', () => {
  const fs = buildFs({
    '/mem/a.md': { head: '---\ndescription: A\n---', whole: 'A'.repeat(50_000), mtimeMs: NOW },
    '/mem/b.md': { head: '---\ndescription: B\n---', whole: 'B'.repeat(50_000), mtimeMs: NOW },
  });
  scanMemoryManifest({ fileSystem: fs, rootDir: '/mem' });
  // 清单阶段不得出现任何 whole 读取——否则 200 条记忆的清单会把 200 个文件全读一遍。
  assert.deepEqual(
    fs.reads.filter((read) => read.startsWith('whole:')),
    [],
  );
  assert.equal(fs.reads.filter((read) => read.startsWith('stat:')).length, 2);
  assert.equal(fs.reads.filter((read) => read.startsWith('head:')).length, 2);
});

test('扫描：根目录不可读时返回 missing 而不是抛出（记忆是可选增强）', () => {
  const fs = new FakeFileSystem({}, {});
  const scan = scanMemoryManifest({ fileSystem: fs, rootDir: '/does-not-exist' });
  assert.equal(scan.status, 'missing');
  assert.deepEqual(scan.entries, []);
});

test('扫描：空目录返回 ok + 空清单（与 missing 可区分）', () => {
  const fs = new FakeFileSystem({ '/mem': [] }, {});
  const scan = scanMemoryManifest({ fileSystem: fs, rootDir: '/mem' });
  assert.equal(scan.status, 'ok');
  assert.deepEqual(scan.entries, []);
});

// ---------------------------------------------------------------------------
// ④ 确定性选择器
// ---------------------------------------------------------------------------

function entry(filename: string, overrides: Partial<MemoryManifestEntry> = {}): MemoryManifestEntry {
  return { filePath: `/mem/${filename}`, filename, mtimeMs: NOW, ...overrides };
}

test('选择：词面零命中的记忆不召回（没有信号就不猜）', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [entry('unrelated.md', { description: '数据库索引优化' })],
    query: '今天天气怎么样',
    recalledPaths: new Set(),
    limit: 5,
  });
  assert.deepEqual(selected, []);
});

test('选择：词面命中者胜出，且返回绝对路径而非文件名', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [entry('hit.md', { description: '关于测试策略' }), entry('miss.md', { description: '关于部署' })],
    query: '测试策略是什么',
    recalledPaths: new Set(),
    limit: 5,
  });
  assert.deepEqual(selected, ['/mem/hit.md']);
});

test('选择：同词面命中时，类型权重高者在前（user > feedback > project > reference）', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [
      entry('ref.md', { description: '性能 资料', type: 'reference' }),
      entry('user.md', { description: '性能 偏好', type: 'user' }),
      entry('proj.md', { description: '性能 背景', type: 'project' }),
      entry('fb.md', { description: '性能 纠正', type: 'feedback' }),
    ],
    query: '性能',
    recalledPaths: new Set(),
    limit: 5,
  });
  assert.deepEqual(selected, ['/mem/user.md', '/mem/fb.md', '/mem/proj.md', '/mem/ref.md']);
});

test('选择：未标注类型的记忆权重最低，但仍可被召回', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [entry('untyped.md', { description: '性能相关' }), entry('typed.md', { description: '性能相关', type: 'reference' })],
    query: '性能',
    recalledPaths: new Set(),
    limit: 5,
  });
  assert.deepEqual(selected, ['/mem/typed.md', '/mem/untyped.md']);
});

test('选择：命中数多者排在前（两次命中优于一次命中，即使一次命中者有类型权重）', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [
      entry('many.md', { description: '测试 策略 覆盖' }),
      entry('one.md', { description: '测试 无关内容', type: 'user' }),
    ],
    query: '测试 策略',
    recalledPaths: new Set(),
    limit: 5,
  });
  // many 命中 2 词 = 20 分；one 命中 1 词 + user 权重 5 = 15 分。两者都召回，但 many 在前。
  assert.deepEqual(selected, ['/mem/many.md', '/mem/one.md']);
});

test('选择：已召回的路径不再返回（跨轮去重）', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [entry('a.md', { description: '测试' }), entry('b.md', { description: '测试' })],
    query: '测试',
    recalledPaths: new Set(['/mem/a.md']),
    limit: 5,
  });
  assert.deepEqual(selected, ['/mem/b.md']);
});

test('选择：limit 生效，且 limit=0 返回空（不越界）', () => {
  const selector = new LexicalMemoryRecallSelector();
  const manifest = [entry('a.md', { description: '测试' }), entry('b.md', { description: '测试' })];
  assert.equal(selector.select({ manifest, query: '测试', recalledPaths: new Set(), limit: 1 }).length, 1);
  assert.deepEqual(selector.select({ manifest, query: '测试', recalledPaths: new Set(), limit: 0 }), []);
  assert.deepEqual(selector.select({ manifest, query: '测试', recalledPaths: new Set(), limit: -1 }), []);
});

test('选择：查询无有效词元时返回空', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [entry('a.md', { description: '测试' })],
    query: '   ',
    recalledPaths: new Set(),
    limit: 5,
  });
  assert.deepEqual(selected, []);
});

test('选择：中文长查询能命中短描述（单字 + 二元组切分，而非整句子串匹配）', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [entry('a.md', { description: '测试策略', type: 'project' })],
    // 若按整句比较，「测试策略是什么」永远匹配不上「测试策略」。
    query: '我们的测试策略是什么',
    recalledPaths: new Set(),
    limit: 5,
  });
  assert.deepEqual(selected, ['/mem/a.md']);
});

test('选择：英文用整词匹配，不做子串误命中', () => {
  const selector = new LexicalMemoryRecallSelector();
  const selected = selector.select({
    manifest: [entry('a.md', { description: 'database migration guide' })],
    // 'base' 不该命中 'database'：词元是整词，不是子串。
    query: 'base',
    recalledPaths: new Set(),
    limit: 5,
  });
  assert.deepEqual(selected, []);
});

test('选择：同样的输入反复调用结果一致（确定性，无模型）', () => {
  const selector = new LexicalMemoryRecallSelector();
  const manifest = [entry('a.md', { description: '测试 策略' }), entry('b.md', { description: '测试' })];
  const first = selector.select({ manifest, query: '测试 策略', recalledPaths: new Set(), limit: 5 });
  const second = selector.select({ manifest, query: '测试 策略', recalledPaths: new Set(), limit: 5 });
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// ⑤ 有界读取与陈旧标注
// ---------------------------------------------------------------------------

test('读取：正文在行数与字节上限内时原样返回，且未标记截断', () => {
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: '第一行\n第二行', mtimeMs: NOW } });
  const [memory] = readRecalledMemories({ fileSystem: fs, entries: [entry('a.md')], nowMs: NOW });
  assert.equal(memory?.content, '第一行\n第二行');
  assert.equal(memory?.truncatedLineCount, undefined);
  assert.equal(memory?.stale, false);
});

test('读取：超过行数上限时按行裁切并标记截断', () => {
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: 'l1\nl2\nl3\nl4', mtimeMs: NOW } });
  const [memory] = readRecalledMemories({
    fileSystem: fs,
    entries: [entry('a.md')],
    nowMs: NOW,
    limits: { contentLineLimit: 2 },
  });
  assert.equal(memory?.content, 'l1\nl2');
  assert.equal(memory?.truncatedLineCount, 2);
});

test('读取：超过字节上限时按完整行裁切（不切断多字节字符）', () => {
  // 每行 3 个汉字 = 9 字节；上限 20 字节 ⇒ 只能容纳 2 行（18 字节），第 3 行放不下。
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: '第一行\n第二行\n第三行', mtimeMs: NOW } });
  const [memory] = readRecalledMemories({
    fileSystem: fs,
    entries: [entry('a.md')],
    nowMs: NOW,
    limits: { contentByteLimit: 20 },
  });
  assert.equal(memory?.content, '第一行\n第二行');
  assert.equal(memory?.truncatedLineCount, 2);
  assert.ok(!memory!.content.includes('\uFFFD'), '不得产出替换字符');
});

test('读取：单行本身就超字节上限时返回空内容并标记截断（不切断）', () => {
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: '一二三四五六七八九十', mtimeMs: NOW } });
  const [memory] = readRecalledMemories({
    fileSystem: fs,
    entries: [entry('a.md')],
    nowMs: NOW,
    limits: { contentByteLimit: 5 },
  });
  assert.equal(memory?.content, '');
  assert.equal(memory?.truncatedLineCount, 0);
});

test('读取：超过陈旧阈值时标题带免责声明且 stale=true', () => {
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: '# a', mtimeMs: NOW - 50 * DAY } });
  const [memory] = readRecalledMemories({ fileSystem: fs, entries: [entry('a.md')], nowMs: NOW });
  assert.equal(memory?.stale, true);
  assert.match(memory!.header, /50 days old/);
  assert.match(memory!.header, /Verify against current code/);
  assert.match(memory!.header, /Memory: a\.md:/);
});

test('读取：未超阈值时标题只有路径，没有免责声明', () => {
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: '# a', mtimeMs: NOW - 1000 } });
  const [memory] = readRecalledMemories({ fileSystem: fs, entries: [entry('a.md')], nowMs: NOW });
  assert.equal(memory?.stale, false);
  assert.equal(memory?.header, 'Memory: a.md:');
});

test('读取：mtime 未来时间不产生负数天数（时钟偏移安全）', () => {
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: '# a', mtimeMs: NOW + 10 * DAY } });
  const [memory] = readRecalledMemories({ fileSystem: fs, entries: [entry('a.md')], nowMs: NOW });
  assert.equal(memory?.stale, false);
});

test('读取：空文件返回空内容而非崩溃', () => {
  const fs = buildFs({ '/mem/a.md': { head: '', whole: '', mtimeMs: NOW } });
  const [memory] = readRecalledMemories({ fileSystem: fs, entries: [entry('a.md')], nowMs: NOW });
  assert.equal(memory?.content, '');
  assert.equal(memory?.truncatedLineCount, undefined);
});

test('读取：CRLF 与 BOM 在正文里被归一化', () => {
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: '\uFEFFl1\r\nl2', mtimeMs: NOW } });
  const [memory] = readRecalledMemories({ fileSystem: fs, entries: [entry('a.md')], nowMs: NOW });
  assert.equal(memory?.content, 'l1\nl2');
});

test('读取：读不动的条目从结果里消失（不产出半条空记忆）', () => {
  const fs = buildFs({
    '/mem/good.md': { head: '# g', whole: 'g', mtimeMs: NOW },
    '/mem/bad.md': { head: '# b', whole: '', mtimeMs: NOW, throwOnWhole: true },
  });
  const recalled = readRecalledMemories({
    fileSystem: fs,
    entries: [entry('good.md'), entry('bad.md')],
    nowMs: NOW,
  });
  assert.deepEqual(recalled.map((m) => m.filename), ['good.md']);
});

test('读取：sizeBytes 反映完整文件大小（不是裁切后的大小）', () => {
  const fs = buildFs({ '/mem/a.md': { head: '# a', whole: 'l1\nl2\nl3', mtimeMs: NOW, sizeBytes: 9999 } });
  const [memory] = readRecalledMemories({
    fileSystem: fs,
    entries: [entry('a.md')],
    nowMs: NOW,
    limits: { contentLineLimit: 1 },
  });
  assert.equal(memory?.sizeBytes, 9999);
});

// ---------------------------------------------------------------------------
// ⑥ 格式化
// ---------------------------------------------------------------------------

test('格式化：仅第一条带「仅供参考」前缀（避免重复刷屏）', () => {
  const fs = buildFs({
    '/mem/a.md': { head: '# a', whole: 'A 正文', mtimeMs: NOW },
    '/mem/b.md': { head: '# b', whole: 'B 正文', mtimeMs: NOW },
  });
  const recalled = readRecalledMemories({
    fileSystem: fs,
    entries: [entry('a.md'), entry('b.md')],
    nowMs: NOW,
  });
  const text = formatRecalledMemories(recalled);
  assert.equal(text.match(/Retrieved for possible relevance/g)?.length, 1);
  assert.match(text, /Memory: a\.md:\n\nA 正文/);
  assert.match(text, /Memory: b\.md:\n\nB 正文/);
});

test('格式化：清单文本带类型标注与描述', () => {
  const text = formatMemoryManifest([
    { filePath: '/mem/a.md', filename: 'a.md', mtimeMs: NOW, description: '描述 A', type: 'user' },
    { filePath: '/mem/b.md', filename: 'b.md', mtimeMs: NOW },
  ]);
  assert.match(text, /- \[user\] a\.md \(/);
  assert.match(text, /: 描述 A/);
  assert.match(text, /- b\.md \(/);
});

// ---------------------------------------------------------------------------
// ⑦ 端到端：recallMemoriesForQuery
// ---------------------------------------------------------------------------

test('端到端：扫描 → 选择 → 读取，并把已召回路径并入 recalledPaths', () => {
  const fs = buildFs({
    '/mem/hit.md': {
      head: '---\ndescription: 测试策略\ntype: feedback\n---',
      whole: '测试相关正文',
      mtimeMs: NOW,
    },
    '/mem/miss.md': { head: '---\ndescription: 部署流程\ntype: user\n---', whole: '部署相关正文', mtimeMs: NOW },
  });
  const recalledPaths = new Set<string>();
  const recalled = recallMemoriesForQuery({
    fileSystem: fs,
    rootDir: '/mem',
    query: '测试',
    nowMs: NOW,
    recalledPaths,
  });
  assert.deepEqual(recalled.map((m) => m.filename), ['hit.md']);
  assert.deepEqual([...recalledPaths], ['/mem/hit.md']);
});

test('端到端：第二轮不会重复召回同一条', () => {
  const fs = buildFs({
    '/mem/a.md': { head: '---\ndescription: 测试策略\n---', whole: '测试正文', mtimeMs: NOW },
  });
  const recalledPaths = new Set<string>();
  const first = recallMemoriesForQuery({ fileSystem: fs, rootDir: '/mem', query: '测试', nowMs: NOW, recalledPaths });
  const second = recallMemoriesForQuery({ fileSystem: fs, rootDir: '/mem', query: '测试', nowMs: NOW, recalledPaths });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test('端到端：读取失败时不登记为已召回（下轮可重试）', () => {
  const fs = buildFs({
    '/mem/a.md': { head: '---\ndescription: 测试策略\n---', whole: '', mtimeMs: NOW, throwOnWhole: true },
  });
  const recalledPaths = new Set<string>();
  const recalled = recallMemoriesForQuery({ fileSystem: fs, rootDir: '/mem', query: '测试', nowMs: NOW, recalledPaths });
  assert.equal(recalled.length, 0);
  assert.equal(recalledPaths.size, 0);
});

test('端到端：可注入自定义选择器（模型驱动选择器的接缝）', () => {
  const fs = buildFs({
    '/mem/a.md': { head: '---\n---', whole: 'A', mtimeMs: NOW },
    '/mem/b.md': { head: '---\n---', whole: 'B', mtimeMs: NOW },
  });
  const injected: string[] = [];
  const selector: MemoryRecallSelector = {
    select(input) {
      // 断言接缝把完整的 manifest 与查询交给了选择器（这样上层才能接模型）。
      assert.equal(input.manifest.length, 2);
      assert.equal(input.query, '任意查询');
      injected.push('called');
      return ['/mem/b.md'];
    },
  };
  const recalled = recallMemoriesForQuery({
    fileSystem: fs,
    rootDir: '/mem',
    query: '任意查询',
    nowMs: NOW,
    recalledPaths: new Set(),
    selector,
  });
  assert.deepEqual(injected, ['called']);
  assert.deepEqual(recalled.map((m) => m.filename), ['b.md']);
});

test('端到端：选择器返回不存在的路径时被安全丢弃', () => {
  const fs = buildFs({ '/mem/a.md': { head: '---\n---', whole: 'A', mtimeMs: NOW } });
  const selector: MemoryRecallSelector = { select: () => ['/mem/幽灵.md', '/mem/a.md'] };
  const recalled = recallMemoriesForQuery({
    fileSystem: fs,
    rootDir: '/mem',
    query: 'x',
    nowMs: NOW,
    recalledPaths: new Set(),
    selector,
  });
  assert.deepEqual(recalled.map((m) => m.filename), ['a.md']);
});

test('端到端：目录不存在时返回空数组，不抛', () => {
  const recalled = recallMemoriesForQuery({
    fileSystem: new FakeFileSystem({}, {}),
    rootDir: '/nope',
    query: '测试',
    nowMs: NOW,
    recalledPaths: new Set(),
  });
  assert.deepEqual(recalled, []);
});

test('端到端：limit 透传到选择器（只能召回这么多条）', () => {
  const files: Record<string, { head: string; whole: string; mtimeMs: number }> = {};
  for (let index = 0; index < 8; index += 1) {
    // 每条都带可命中的描述，否则词面零命中会先被过滤掉、测不到 limit。
    files[`/mem/m${index}.md`] = {
      head: '---\ndescription: 测试策略\n---',
      whole: '测试正文',
      mtimeMs: NOW - index,
    };
  }
  const fs = buildFs(files);
  const recalled = recallMemoriesForQuery({
    fileSystem: fs,
    rootDir: '/mem',
    query: '测试',
    nowMs: NOW,
    recalledPaths: new Set(),
    limit: 3,
  });
  assert.equal(recalled.length, 3);
});

test('端到端：全部记忆都零词面命中时返回空（宁可不召回，不塞无关内容）', () => {
  const files: Record<string, { head: string; whole: string; mtimeMs: number }> = {};
  for (let index = 0; index < 4; index += 1) {
    files[`/mem/m${index}.md`] = { head: '---\ndescription: 部署流程\n---', whole: '部署正文', mtimeMs: NOW };
  }
  const recalled = recallMemoriesForQuery({
    fileSystem: buildFs(files),
    rootDir: '/mem',
    query: '测试',
    nowMs: NOW,
    recalledPaths: new Set(),
  });
  assert.deepEqual(recalled, []);
});

// ---------------------------------------------------------------------------
// ⑧ Node 文件系统适配器（真实临时目录）
// ---------------------------------------------------------------------------

test('Node 适配器：递归子目录、只读 .md、排除 MEMORY.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-memory-'));
  try {
    mkdirSync(join(root, 'topics'), { recursive: true });
    writeFileSync(join(root, 'a.md'), '---\ndescription: 顶层\n---\nA', 'utf8');
    writeFileSync(join(root, 'MEMORY.md'), '# 索引', 'utf8');
    writeFileSync(join(root, 'notes.txt'), 'not markdown', 'utf8');
    writeFileSync(join(root, 'topics', 'b.md'), '---\ntype: project\n---\nB', 'utf8');

    const scan = scanMemoryManifest({ fileSystem: new NodeMemoryFileSystem(), rootDir: root });
    assert.equal(scan.status, 'ok');
    assert.deepEqual(scan.entries.map((e) => e.filename).sort(), ['a.md', 'topics/b.md']);
    assert.equal(scan.entries.find((e) => e.filename === 'a.md')?.description, '顶层');
    assert.equal(scan.entries.find((e) => e.filename === 'topics/b.md')?.type, 'project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Node 适配器：符号链接文件被拒绝读取（不越出记忆目录）', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-memory-'));
  const outside = mkdtempSync(join(tmpdir(), 'awo-outside-'));
  try {
    writeFileSync(join(outside, 'secret.md'), '外部机密内容', 'utf8');
    symlinkSync(join(outside, 'secret.md'), join(root, 'link.md'));

    const fs = new NodeMemoryFileSystem();
    // 清单阶段：symlink 会被登记，但读取阶段必须抛（Node 适配器 lstat 判定）。
    assert.throws(() => fs.readWhole(join(root, 'link.md')), /符号链接/);

    // 端到端：该条从结果里消失，外部内容绝不进入上下文。
    const recalled = recallMemoriesForQuery({
      fileSystem: fs,
      rootDir: root,
      query: '机密',
      nowMs: Date.now(),
      recalledPaths: new Set(),
    });
    assert.deepEqual(recalled, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Node 适配器：超过单文件上限时拒绝读取', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-memory-'));
  try {
    writeFileSync(join(root, 'big.md'), 'x'.repeat(200), 'utf8');
    const fs = new NodeMemoryFileSystem({ maxFileBytes: 100 });
    assert.throws(() => fs.readWhole(join(root, 'big.md')), /上限/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Node 适配器：readHead 返回真实总行数（用于判截断）', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-memory-'));
  try {
    writeFileSync(join(root, 'a.md'), 'l1\nl2\nl3\nl4\nl5', 'utf8');
    const head = new NodeMemoryFileSystem().readHead(join(root, 'a.md'), 2);
    assert.equal(head.content, 'l1\nl2');
    assert.equal(head.totalLines, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Node 适配器：目录不存在时 listDirectory 抛出（由扫描层收敛为 missing）', () => {
  const fs = new NodeMemoryFileSystem();
  assert.throws(() => fs.listDirectory(join(tmpdir(), 'awo-不存在的目录-' + Date.now())));
  const scan = scanMemoryManifest({ fileSystem: fs, rootDir: join(tmpdir(), 'awo-不存在的目录-' + Date.now()) });
  assert.equal(scan.status, 'missing');
});

test('Node 适配器：空文件当普通文件读（不误判为链接）', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-memory-'));
  try {
    writeFileSync(join(root, 'empty.md'), '', 'utf8');
    const whole = new NodeMemoryFileSystem().readWhole(join(root, 'empty.md'));
    assert.equal(whole.content, '');
    assert.equal(whole.sizeBytes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
