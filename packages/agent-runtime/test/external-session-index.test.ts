// 一个文件=一种作用：外部来源会话增量反向索引的单元测试（全部走临时目录，不出网、不碰真实用户目录）。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createJsonLinesExternalSessionSource,
  ExternalSessionIndexer,
  ExternalSessionIndexError,
  externalSessionContentIdentity,
  externalSessionIdentity,
  InMemoryExternalSessionIndexStore,
  JsonLinesExternalSessionSource,
  normalizeRelativePath,
  parseJsonLinesSession,
  type ExternalSessionCandidate,
  type ExternalSessionReadResult,
  type ExternalSessionSourceAdapter,
} from '../src/index.js';

/** 生成一个最小 JSON Lines 会话文件内容。 */
function sessionContent(sessionId: string, texts: readonly string[], title?: string): string {
  const lines = [JSON.stringify({ type: 'session', sessionId, ...(title ? { title } : {}) })];
  for (const text of texts) lines.push(JSON.stringify({ type: 'message', role: 'user', text }));
  return `${lines.join('\n')}\n`;
}

/** 写入会话文件并可指定修改时间（epoch ms）。 */
function writeSession(root: string, relativePath: string, content: string, modifiedAtMs?: number): string {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  if (modifiedAtMs !== undefined) {
    const seconds = modifiedAtMs / 1000;
    utimesSync(full, seconds, seconds);
  }
  return full;
}

/** 记录 discover 收到的 since 参数，用于断言游标续跑。 */
class RecordingSource implements ExternalSessionSourceAdapter {
  readonly sinceArgs: (number | undefined)[] = [];

  constructor(private readonly inner: ExternalSessionSourceAdapter) {}

  get id(): string {
    return this.inner.id;
  }

  get rootDir(): string {
    return this.inner.rootDir;
  }

  discover(sinceMs?: number): Promise<readonly ExternalSessionCandidate[]> {
    this.sinceArgs.push(sinceMs);
    return this.inner.discover(sinceMs);
  }

  read(filePath: string): Promise<ExternalSessionReadResult> {
    return this.inner.read(filePath);
  }
}

/** 读盘被闸门阻塞的适配器，用于制造「两个发现者并发」的竞态。 */
class GatedSource implements ExternalSessionSourceAdapter {
  constructor(
    private readonly inner: ExternalSessionSourceAdapter,
    private readonly gate: Promise<void>,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get rootDir(): string {
    return this.inner.rootDir;
  }

  discover(sinceMs?: number): Promise<readonly ExternalSessionCandidate[]> {
    return this.inner.discover(sinceMs);
  }

  async read(filePath: string): Promise<ExternalSessionReadResult> {
    await this.gate;
    return this.inner.read(filePath);
  }
}

const BASE_MTIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('增量：新增写入、未变跳过、已改覆盖（同一会话仍只有一条记录）', async () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    writeSession(root, 'a.jsonl', sessionContent('ext-a', ['hello']), BASE_MTIME);
    writeSession(root, 'b.jsonl', sessionContent('ext-b', ['hi']), BASE_MTIME + 1_000);

    const store = new InMemoryExternalSessionIndexStore();
    const source = createJsonLinesExternalSessionSource({ id: 'ext-src', rootDir: root });
    const indexer = new ExternalSessionIndexer({ source, store });

    // 1) 新增
    const first = await indexer.synchronize({ full: true });
    assert.equal(first.discovered, 2);
    assert.equal(first.indexed, 2);
    assert.equal(first.skippedUnchanged, 0);
    assert.equal(store.list().length, 2);
    const beforeA = store.list().find((record) => record.relativePath === 'a.jsonl');
    assert.equal(beforeA?.messageCount, 1);
    assert.equal(beforeA?.status, 'indexed');

    // 2) 未变（全量重扫，size+mtime 相同 → 不读盘、不写库）
    const second = await indexer.synchronize({ full: true });
    assert.equal(second.indexed, 0);
    assert.equal(second.skippedUnchanged, 2);
    assert.equal(store.list().length, 2);

    // 3) 已改：改内容并推进 mtime → 覆盖同一条记录
    writeSession(root, 'a.jsonl', sessionContent('ext-a', ['hello', 'again']), BASE_MTIME + 2_000);
    const third = await indexer.synchronize({ full: true });
    assert.equal(third.indexed, 1);
    assert.equal(third.skippedUnchanged, 1);
    assert.equal(store.list().length, 2, '内容更新必须是覆盖，不能新增第二条');
    const afterA = store.list().find((record) => record.relativePath === 'a.jsonl');
    assert.equal(afterA?.messageCount, 2);
    assert.equal(afterA?.sessionId, beforeA?.sessionId, '会话主键（文件级身份）必须稳定');
    assert.notEqual(afterA?.sessionKey, beforeA?.sessionKey, '内容变化后稳定身份（含摘要）必须变化');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('幂等：重复索引同一内容不产生重复记录（稳定身份 = 来源 id + 归一化路径 + 内容摘要）', async () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    writeSession(root, 'x.jsonl', sessionContent('ext-x', ['only']), BASE_MTIME);
    const store = new InMemoryExternalSessionIndexStore();
    const source = createJsonLinesExternalSessionSource({ id: 'ext-src', rootDir: root });
    const indexer = new ExternalSessionIndexer({ source, store });

    const first = await indexer.synchronize({ full: true });
    const second = await indexer.synchronize({ full: true });
    const third = await indexer.synchronize({ full: true });

    assert.equal(first.indexed, 1);
    assert.equal(second.indexed, 0);
    assert.equal(third.indexed, 0);
    assert.equal(store.list().length, 1);

    const record = store.list()[0]!;
    assert.equal(record.sessionId, externalSessionIdentity('ext-src', 'x.jsonl'));
    assert.equal(
      record.sessionKey,
      externalSessionContentIdentity('ext-src', 'x.jsonl', record.contentDigest!),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('游标续跑：水位随扫描推进，第二轮只写入新增文件', async () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    writeSession(root, 'a.jsonl', sessionContent('ext-a', ['one']), BASE_MTIME);
    const store = new InMemoryExternalSessionIndexStore();
    const source = new RecordingSource(createJsonLinesExternalSessionSource({ id: 'ext-src', rootDir: root }));
    const indexer = new ExternalSessionIndexer({ source, store });

    const first = await indexer.synchronize({ full: true });
    assert.equal(first.indexed, 1);
    assert.equal(first.watermarkMs, BASE_MTIME);
    assert.equal(source.sinceArgs[0], undefined, '全量首轮不传水位');
    assert.equal(store.loadCursor('ext-src')?.watermarkMs, BASE_MTIME);

    // 新增一个更晚的文件；不带参数续跑 → 以水位为 since
    writeSession(root, 'b.jsonl', sessionContent('ext-b', ['two']), BASE_MTIME + 5_000);
    const second = await indexer.synchronize();
    assert.equal(source.sinceArgs[1], BASE_MTIME, '续跑必须以上一轮水位为 since');
    assert.equal(second.indexed, 1, '只有新增文件被写入');
    assert.equal(second.skippedUnchanged, 1, '边界文件按 >= 重新发现但被幂等跳过');
    assert.equal(second.watermarkMs, BASE_MTIME + 5_000);
    assert.equal(store.loadCursor('ext-src')?.lastProcessedCount, 2);

    // 再续跑一轮：水位已推进到最新文件，本轮无写入
    const third = await indexer.synchronize();
    assert.equal(source.sinceArgs[2], BASE_MTIME + 5_000);
    assert.equal(third.indexed, 0);
    assert.equal(third.discovered, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('竞态：两个发现者并发索引同一文件，只落一条记录（先占位后读）', async () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    writeSession(root, 'race.jsonl', sessionContent('ext-race', ['a', 'b', 'c']), BASE_MTIME);

    const store = new InMemoryExternalSessionIndexStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createJsonLinesExternalSessionSource({ id: 'ext-src', rootDir: root });
    const indexer = new ExternalSessionIndexer({ source: new GatedSource(inner, gate), store });

    const first = indexer.synchronize({ full: true });
    const second = indexer.synchronize({ full: true });
    // 让两个同步都进入「已占位、正在读盘」的状态，再放行。
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [reportA, reportB] = await Promise.all([first, second]);

    assert.equal(store.list().length, 1, '同一会话只能有一条记录');
    assert.equal(store.list()[0]?.status, 'indexed');
    assert.equal(store.list()[0]?.messageCount, 3);
    assert.equal(reportA.discovered, 1);
    assert.equal(reportB.discovered, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('竞态：文件监听器（synchronizeFile）与全量同步并发，仍只有一条记录', async () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    const filePath = writeSession(root, 'watcher.jsonl', sessionContent('ext-w', ['x', 'y']), BASE_MTIME);

    const store = new InMemoryExternalSessionIndexStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createJsonLinesExternalSessionSource({ id: 'ext-src', rootDir: root });
    const indexer = new ExternalSessionIndexer({ source: new GatedSource(inner, gate), store });

    const sweep = indexer.synchronize({ full: true });
    const watched = indexer.synchronizeFile(filePath);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [, fileResult] = await Promise.all([sweep, watched]);

    assert.equal(store.list().length, 1);
    assert.equal(fileResult.indexed, true);
    assert.equal(store.list()[0]?.messageCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fail closed：损坏文件被跳过且不留半条记录', async () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    writeSession(root, 'broken.jsonl', `${JSON.stringify({ type: 'session', sessionId: 'ext-broken' })}\n{not json\n`);
    writeSession(root, 'good.jsonl', sessionContent('ext-good', ['fine']), BASE_MTIME);

    const store = new InMemoryExternalSessionIndexStore();
    const source = createJsonLinesExternalSessionSource({ id: 'ext-src', rootDir: root });
    const indexer = new ExternalSessionIndexer({ source, store });

    const report = await indexer.synchronize({ full: true });
    assert.equal(report.indexed, 1);
    assert.equal(report.skippedInvalid, 1);
    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.diagnostics[0]?.code, 'external_session_file_corrupt');
    assert.equal(report.diagnostics[0]?.path, 'broken.jsonl');
    assert.equal(store.list().length, 1, '损坏文件不得留下任何记录（含占位）');
    assert.equal(store.load(externalSessionIdentity('ext-src', 'broken.jsonl')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fail closed：超大文件与未知记录类型各自产出稳定诊断码', async () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    writeSession(root, 'huge.jsonl', sessionContent('ext-huge', ['x'.repeat(200)]), BASE_MTIME);
    writeSession(root, 'weird.jsonl', `${JSON.stringify({ type: 'session', sessionId: 'ext-weird' })}\n${JSON.stringify({ type: 'unknown-record' })}\n`, BASE_MTIME + 1);

    const store = new InMemoryExternalSessionIndexStore();
    const source = createJsonLinesExternalSessionSource({ id: 'ext-src', rootDir: root, maxBytes: 100 });
    const indexer = new ExternalSessionIndexer({ source, store });

    const report = await indexer.synchronize({ full: true });
    assert.equal(report.indexed, 0);
    assert.equal(report.skippedInvalid, 2);
    const codes = report.diagnostics.map((diagnostic) => diagnostic.code).sort();
    assert.deepEqual(codes, ['external_session_file_too_large', 'external_session_source_unsupported']);
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('越界校验：适配器 read 拒绝逃出根目录的路径', async () => {
  const root = makeTempRoot('awo-ext-session-');
  const outside = makeTempRoot('awo-ext-outside-');
  try {
    const outsideFile = join(outside, 'evil.jsonl');
    writeFileSync(outsideFile, sessionContent('ext-evil', ['x']), 'utf8');
    const source = new JsonLinesExternalSessionSource({ id: 'ext-src', rootDir: root });

    await assert.rejects(
      () => source.read(outsideFile),
      (error: unknown) => error instanceof ExternalSessionIndexError && error.code === 'external_session_path_escaped',
    );
    await assert.rejects(
      () => source.read(join(root, '..', 'evil.jsonl')),
      (error: unknown) => error instanceof ExternalSessionIndexError && error.code === 'external_session_path_escaped',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('越界校验：索引器拒绝越界或相对路径不一致的候选，且不调用 read', async () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    let readCalls = 0;
    const hostile: ExternalSessionSourceAdapter = {
      id: 'ext-hostile',
      rootDir: root,
      async discover(): Promise<readonly ExternalSessionCandidate[]> {
        return [
          { filePath: join(root, '..', 'escape.jsonl'), relativePath: '../escape.jsonl', sizeBytes: 1, modifiedAtMs: 1 },
          { filePath: join(root, 'ok.jsonl'), relativePath: 'mismatch.jsonl', sizeBytes: 1, modifiedAtMs: 2 },
        ];
      },
      async read(): Promise<ExternalSessionReadResult> {
        readCalls += 1;
        throw new Error('read 不应被调用');
      },
    };

    const store = new InMemoryExternalSessionIndexStore();
    const indexer = new ExternalSessionIndexer({ source: hostile, store });
    const report = await indexer.synchronize({ full: true });

    assert.equal(readCalls, 0);
    assert.equal(report.skippedInvalid, 2);
    assert.equal(report.indexed, 0);
    assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.code), [
      'external_session_path_escaped',
      'external_session_path_escaped',
    ]);
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('解析层：归一化形状与各 fail-closed 分支', () => {
  const normalized = parseJsonLinesSession(
    `${JSON.stringify({ type: 'session', sessionId: 's-1', title: '标题', createdAt: 1, updatedAt: 2 })}\n\n${JSON.stringify({ type: 'message', role: 'assistant', text: 'hi', at: 3 })}\n`,
    { path: 'demo.jsonl' },
  );
  assert.equal(normalized.externalSessionId, 's-1');
  assert.equal(normalized.title, '标题');
  assert.equal(normalized.messages.length, 1);
  assert.deepEqual(normalized.messages[0], { role: 'assistant', text: 'hi', at: 3 });

  const corruptCases: readonly [string, string][] = [
    [`${JSON.stringify({ type: 'message', role: 'user', text: 'x' })}\n`, 'external_session_file_corrupt'],
    [`${JSON.stringify({ type: 'session', sessionId: '' })}\n`, 'external_session_file_corrupt'],
    [`${JSON.stringify({ type: 'session', sessionId: 's' })}\n${JSON.stringify({ type: 'session', sessionId: 't' })}\n`, 'external_session_file_corrupt'],
    [`${JSON.stringify({ type: 'session', sessionId: 's' })}\n${JSON.stringify({ type: 'message', role: 'user' })}\n`, 'external_session_file_corrupt'],
    [`${JSON.stringify({ type: 'session', sessionId: 's' })}\n${JSON.stringify({ type: 'message', role: 'robot', text: 'x' })}\n`, 'external_session_source_unsupported'],
  ];
  for (const [raw, code] of corruptCases) {
    assert.throws(
      () => parseJsonLinesSession(raw, { path: 'demo.jsonl' }),
      (error: unknown) => error instanceof ExternalSessionIndexError && error.code === code,
      `期望 ${code}`,
    );
  }
});

test('归一化相对路径：越界与根目录自身返回 undefined', () => {
  const root = makeTempRoot('awo-ext-session-');
  try {
    assert.equal(normalizeRelativePath(root, join(root, 'a', 'b.jsonl')), 'a/b.jsonl');
    assert.equal(normalizeRelativePath(root, join(root, '..', 'x.jsonl')), undefined);
    assert.equal(normalizeRelativePath(root, root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
