import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FILE_CHANGE_RECORDS,
  MAX_RECORDED_CONTENT_CHARS,
} from '../src/runtime/workspace-file-rewind-contract.js';
import {
  appendWorkspaceFileChange,
  clearWorkspaceFileJournal,
  createWorkspaceFileRecorder,
  readWorkspaceFileJournal,
  workspaceFileJournalKey,
  type WorkspaceFileChangeInput,
  type WorkspaceFileJournalStorage,
} from '../src/runtime/workspace-file-journal.js';

// ---------------------------------------------------------------------------
// 测试替身：内存存储。日志模块本身零 IO，全部经注入的端口。
// ---------------------------------------------------------------------------

interface MemoryStorage extends WorkspaceFileJournalStorage {
  readonly data: Record<string, string>;
}

function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    read: (key) => (key in data ? data[key]! : null),
    write: (key, value) => {
      data[key] = value;
    },
  };
}

/** 永远写不进去的存储：模拟 localStorage 配额写满。 */
function failingStorage(): WorkspaceFileJournalStorage {
  return { read: () => null, write: () => { throw new Error('QuotaExceededError'); } };
}

const CONVERSATION = 'conversation-1';

function change(
  path: string,
  beforeContent: string | null,
  afterContent: string | null,
  toolName = 'workspace_write_file',
): WorkspaceFileChangeInput {
  return { path, toolName, beforeContent, afterContent };
}

function seed(storage: MemoryStorage, value: unknown): void {
  storage.data[workspaceFileJournalKey(CONVERSATION)] = JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// 基本存取
// ---------------------------------------------------------------------------

test('空存储读出空快照', () => {
  const snapshot = readWorkspaceFileJournal(memoryStorage(), CONVERSATION);
  assert.deepEqual(snapshot.records, []);
  assert.equal(snapshot.droppedCount, 0);
  assert.equal(snapshot.unjournalable, false);
});

test('追加后能原样读回', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('a.md', 'old', 'new'), 123);
  const snapshot = readWorkspaceFileJournal(storage, CONVERSATION);
  assert.deepEqual(snapshot.records, [
    { path: 'a.md', toolName: 'workspace_write_file', beforeContent: 'old', afterContent: 'new', at: 123, sequence: 1 },
  ]);
  assert.equal(snapshot.droppedCount, 0);
  assert.equal(snapshot.unjournalable, false);
});

test('顺序即因果：读回顺序与追加顺序一致', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('a.md', 'v0', 'v1'), 1);
  appendWorkspaceFileChange(storage, CONVERSATION, change('b.md', null, 'x'), 2);
  appendWorkspaceFileChange(storage, CONVERSATION, change('a.md', 'v1', 'v2'), 3);
  const paths = readWorkspaceFileJournal(storage, CONVERSATION).records.map((item) => `${item.path}:${item.afterContent}`);
  assert.deepEqual(paths, ['a.md:v1', 'b.md:x', 'a.md:v2']);
});

test('新建与删除两侧都可为null', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('created.md', null, 'body'), 1);
  appendWorkspaceFileChange(storage, CONVERSATION, change('deleted.md', 'body', null), 2);
  const [created, deleted] = readWorkspaceFileJournal(storage, CONVERSATION).records;
  assert.equal(created!.beforeContent, null);
  assert.equal(created!.afterContent, 'body');
  assert.equal(deleted!.beforeContent, 'body');
  assert.equal(deleted!.afterContent, null);
});

test('不同会话的日志互不影响', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, 'c1', change('a.md', 'old', 'new'), 1);
  appendWorkspaceFileChange(storage, 'c2', change('b.md', 'old', 'new'), 2);
  assert.deepEqual(readWorkspaceFileJournal(storage, 'c1').records.map((item) => item.path), ['a.md']);
  assert.deepEqual(readWorkspaceFileJournal(storage, 'c2').records.map((item) => item.path), ['b.md']);
});

test('清空后读出空快照', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('a.md', 'old', 'new'), 1);
  clearWorkspaceFileJournal(storage, CONVERSATION);
  const snapshot = readWorkspaceFileJournal(storage, CONVERSATION);
  assert.deepEqual(snapshot.records, []);
  assert.equal(snapshot.unjournalable, false);
});

test('录制器绑定会话后可直接注入写入路径', () => {
  const storage = memoryStorage();
  const recorder = createWorkspaceFileRecorder(storage, CONVERSATION);
  recorder(change('a.md', 'old', 'new'));
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).records.length, 1);
});

// ---------------------------------------------------------------------------
// 容量：丢最旧、不作废
// ---------------------------------------------------------------------------

test('超过条数上限时丢弃最旧并如实计入droppedCount', () => {
  const storage = memoryStorage();
  for (let index = 0; index < MAX_FILE_CHANGE_RECORDS + 3; index += 1) {
    appendWorkspaceFileChange(storage, CONVERSATION, change(`f${index}.md`, 'old', 'new'), index);
  }
  const snapshot = readWorkspaceFileJournal(storage, CONVERSATION);
  assert.equal(snapshot.records.length, MAX_FILE_CHANGE_RECORDS);
  assert.equal(snapshot.droppedCount, 3, '丢掉的条数必须如实报出');
  // 丢的是最旧的：最新一条必须在，最早一条必须不在。
  assert.equal(snapshot.records.at(-1)!.path, `f${MAX_FILE_CHANGE_RECORDS + 2}.md`);
  assert.equal(snapshot.records[0]!.path, 'f3.md');
  // 丢最旧不是"有洞"之外的另一种选择：丢最新会让用户最想撤销的改动反而不可回退。
  assert.equal(snapshot.unjournalable, false);
});

test('droppedCount在多次追加间累积', () => {
  const storage = memoryStorage();
  for (let index = 0; index < MAX_FILE_CHANGE_RECORDS + 1; index += 1) {
    appendWorkspaceFileChange(storage, CONVERSATION, change(`f${index}.md`, 'old', 'new'), index);
  }
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).droppedCount, 1);
  appendWorkspaceFileChange(storage, CONVERSATION, change('extra.md', 'old', 'new'), 999);
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).droppedCount, 2);
});

// ---------------------------------------------------------------------------
// 不完整信号：作废而非留洞
// ---------------------------------------------------------------------------

test('单条过大时整份日志作废而不是留洞', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('ok.md', 'old', 'new'), 1);
  const huge = 'x'.repeat(MAX_RECORDED_CONTENT_CHARS + 1);
  appendWorkspaceFileChange(storage, CONVERSATION, change('huge.md', 'old', huge), 2);
  const snapshot = readWorkspaceFileJournal(storage, CONVERSATION);
  // 留洞的日志比没有日志更危险：那会让回退以为"历史完整"，从而产出一个漏掉文件的
  // "安全"计划。故宁可整份作废。
  assert.equal(snapshot.unjournalable, true);
  assert.deepEqual(snapshot.records, []);
});

test('beforeContent过大同样作废', () => {
  const storage = memoryStorage();
  const huge = 'x'.repeat(MAX_RECORDED_CONTENT_CHARS + 1);
  appendWorkspaceFileChange(storage, CONVERSATION, change('huge.md', huge, null), 1);
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
});

test('空路径的记录使日志作废', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('   ', 'old', 'new'), 1);
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
});

test('配额写失败时作废而不是静默丢弃', () => {
  const storage = failingStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('a.md', 'old', 'new'), 1);
  // 写不进去也不能装作记下了 —— 读取方看到的是"空且已作废"。
  const snapshot = readWorkspaceFileJournal(storage, CONVERSATION);
  assert.deepEqual(snapshot.records, []);
});

test('已作废的日志不再接受追加', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('bad.md', 'old', 'x'.repeat(MAX_RECORDED_CONTENT_CHARS + 1)), 1);
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
  appendWorkspaceFileChange(storage, CONVERSATION, change('good.md', 'old', 'new'), 2);
  // 追加不能把"曾经有过洞"这件事洗掉。
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
  assert.deepEqual(readWorkspaceFileJournal(storage, CONVERSATION).records, []);
});

// ---------------------------------------------------------------------------
// 不可信存储
// ---------------------------------------------------------------------------

test('非法JSON判为作废', () => {
  const storage = memoryStorage();
  storage.data[workspaceFileJournalKey(CONVERSATION)] = '{ not json';
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
});

test('结构版本不符判为作废', () => {
  const storage = memoryStorage();
  seed(storage, { version: 3, nextSequence: 1, records: [], dropped: 0, unjournalable: false });
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
});

test('v1日志判为作废（记录没有序号，无法切片）', () => {
  // 按错误的范围回退会漏文件，而用户以为回到了那一刻。故整份作废而不是勉强兼容。
  // 代价可接受：本功能此前没有任何界面入口，不存在依赖 v1 的真实用户。
  const storage = memoryStorage();
  seed(storage, { version: 1, records: [], dropped: 0, unjournalable: false });
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
});

test('records不是数组判为作废', () => {
  const storage = memoryStorage();
  seed(storage, { version: 1, records: 'nope', dropped: 0, unjournalable: false });
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
});

test('非对象判为作废', () => {
  const storage = memoryStorage();
  seed(storage, 42);
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).unjournalable, true);
});

test('字段非法的记录计入droppedCount而不被当作合法记录', () => {
  const storage = memoryStorage();
  seed(storage, {
    version: 2,
    nextSequence: 6,
    records: [
      { path: 'ok.md', toolName: 'workspace_write_file', beforeContent: 'old', afterContent: 'new', at: 1, sequence: 1 },
      { path: 'no-tool.md', beforeContent: 'old', afterContent: 'new', at: 2, sequence: 2 },
      { path: '   ', toolName: 't', beforeContent: null, afterContent: 'x', at: 3, sequence: 3 },
      { path: 'undef-before.md', toolName: 't', afterContent: 'x', at: 4, sequence: 4 },
      { path: 'no-sequence.md', toolName: 't', beforeContent: null, afterContent: 'x', at: 5 },
      'garbage',
      null,
    ],
    dropped: 0,
    unjournalable: false,
  });
  const snapshot = readWorkspaceFileJournal(storage, CONVERSATION);
  assert.deepEqual(snapshot.records.map((item) => item.path), ['ok.md']);
  // 6 条非法：缺 toolName / 空 path / 缺 beforeContent / 缺 sequence / 'garbage' / null。
  assert.equal(snapshot.droppedCount, 6);
});

test('存储读取抛异常时判为作废而不是崩', () => {
  const storage: WorkspaceFileJournalStorage = {
    read: () => {
      throw new Error('storage unavailable');
    },
    write: () => {},
  };
  const snapshot = readWorkspaceFileJournal(storage, CONVERSATION);
  assert.deepEqual(snapshot.records, []);
  assert.equal(snapshot.unjournalable, true);
});

test('存储里已有的dropped计数被保留并累加', () => {
  const storage = memoryStorage();
  seed(storage, { version: 2, nextSequence: 1, records: [], dropped: 7, unjournalable: false });
  appendWorkspaceFileChange(storage, CONVERSATION, change('a.md', 'old', 'new'), 1);
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).droppedCount, 7);
});

test('读取不修改存储（纯读）', () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('a.md', 'old', 'new'), 1);
  const before = storage.data[workspaceFileJournalKey(CONVERSATION)];
  readWorkspaceFileJournal(storage, CONVERSATION);
  readWorkspaceFileJournal(storage, CONVERSATION);
  assert.equal(storage.data[workspaceFileJournalKey(CONVERSATION)], before);
});

test('清空日志后序号不复位', () => {
  // 若清空连序号一起复位，建在清空之前的检查点会把之后的新记录判成"发生在它之前"，
  // 于是回退范围变成空 —— 用户以为回到了那一刻，其实什么都没退。
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, change('a.md', null, 'x'), 1);
  appendWorkspaceFileChange(storage, CONVERSATION, change('b.md', null, 'y'), 2);
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).nextSequence, 3);
  clearWorkspaceFileJournal(storage, CONVERSATION);
  const cleared = readWorkspaceFileJournal(storage, CONVERSATION);
  assert.deepEqual(cleared.records, []);
  assert.equal(cleared.nextSequence, 3, '清空的是记录，不是时间轴');
  appendWorkspaceFileChange(storage, CONVERSATION, change('c.md', null, 'z'), 3);
  assert.equal(readWorkspaceFileJournal(storage, CONVERSATION).records[0]?.sequence, 3, '新记录接着原来的序号');
});
