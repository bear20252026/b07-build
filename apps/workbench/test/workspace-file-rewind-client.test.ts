import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MISSING_CONTENT_SHA256, type ContentHasher, type CurrentFileStateReader } from '../src/runtime/workspace-file-rewind-contract.js';
import {
  FILE_REWIND_JOURNAL_INCOMPLETE_CODE,
  createTauriWorkspaceFileStateReader,
  createWebCryptoContentHasher,
  planToPatchOperations,
  applyFileRewindPlan,
  previewWorkspaceFileRewind,
} from '../src/runtime/workspace-file-rewind-client.js';
import {
  appendWorkspaceFileChange,
  workspaceFileJournalKey,
  type WorkspaceFileJournalStorage,
} from '../src/runtime/workspace-file-journal.js';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

function memoryStorage(initial: Record<string, string> = {}): WorkspaceFileJournalStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    read: (key) => (key in data ? data[key]! : null),
    write: (key, value) => {
      data[key] = value;
    },
  };
}

const fakeHasher: ContentHasher = {
  sha256: (content) => (content === null ? MISSING_CONTENT_SHA256 : `h:${content}`),
};

function readerFrom(files: Readonly<Record<string, string | null | { failed: string }>>): CurrentFileStateReader {
  return {
    read: async (path) => {
      if (!(path in files)) return { exists: false, content: null };
      const entry = files[path]!;
      if (typeof entry === 'string') return { exists: true, content: entry };
      if (entry === null) return { exists: false, content: null };
      return entry;
    },
  };
}

const CONVERSATION = 'c1';

// ---------------------------------------------------------------------------
// 预览：日志 → 计划
// ---------------------------------------------------------------------------

test('空日志得到空计划', async () => {
  const plan = await previewWorkspaceFileRewind({
    storage: memoryStorage(),
    conversationId: CONVERSATION,
    reader: readerFrom({}),
    hasher: fakeHasher,
  });
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsafeFiles, []);
});

test('正常日志得到可执行计划', async () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, { path: 'a.md', toolName: 'workspace_write_file', beforeContent: 'old', afterContent: 'new' }, 1);
  const plan = await previewWorkspaceFileRewind({
    storage,
    conversationId: CONVERSATION,
    reader: readerFrom({ 'a.md': 'new' }),
    hasher: fakeHasher,
  });
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]!.previousSha256, 'h:new');
  assert.equal(plan.operations[0]!.nextContent, 'old');
});

test('日志有洞时阻断且不产出任何操作', async () => {
  const storage = memoryStorage();
  // 直接构造一份"丢过记录"的日志：这是历史不完整的信号。
  storage.data[workspaceFileJournalKey(CONVERSATION)] = JSON.stringify({
    version: 2,
    nextSequence: 2,
    records: [{ path: 'a.md', toolName: 'workspace_write_file', beforeContent: 'old', afterContent: 'new', at: 1, sequence: 1 }],
    dropped: 3,
    unjournalable: false,
  });
  const plan = await previewWorkspaceFileRewind({
    storage,
    conversationId: CONVERSATION,
    reader: readerFrom({ 'a.md': 'new' }), // 就算磁盘状态完全匹配
    hasher: fakeHasher,
  });
  // 也不能拿有洞的历史去还原：那份历史会漏掉本该还原的文件，
  // 而用户会看到"回退成功"——比明确拒绝更危险。
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.unsafeFiles.length, 1);
  assert.equal(plan.unsafeFiles[0]!.reason, FILE_REWIND_JOURNAL_INCOMPLETE_CODE);
  assert.match(plan.unsafeFiles[0]!.message ?? '', /3 条/);
});

test('日志作废时阻断并说明原因', async () => {
  const storage = memoryStorage();
  storage.data[workspaceFileJournalKey(CONVERSATION)] = JSON.stringify({
    version: 1,
    records: [],
    dropped: 0,
    unjournalable: true,
  });
  const plan = await previewWorkspaceFileRewind({
    storage,
    conversationId: CONVERSATION,
    reader: readerFrom({}),
    hasher: fakeHasher,
  });
  assert.equal(plan.canApply, false);
  assert.equal(plan.unsafeFiles[0]!.reason, FILE_REWIND_JOURNAL_INCOMPLETE_CODE);
  assert.match(plan.unsafeFiles[0]!.message ?? '', /作废/);
});

test('预览不修改日志存储', async () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, { path: 'a.md', toolName: 't', beforeContent: 'old', afterContent: 'new' }, 1);
  const before = storage.data[workspaceFileJournalKey(CONVERSATION)];
  await previewWorkspaceFileRewind({ storage, conversationId: CONVERSATION, reader: readerFrom({ 'a.md': 'new' }), hasher: fakeHasher });
  assert.equal(storage.data[workspaceFileJournalKey(CONVERSATION)], before);
});

// ---------------------------------------------------------------------------
// 映射到原生 patch 操作
// ---------------------------------------------------------------------------

test('还原操作映射为原生update且字段名转换为snake_case', async () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, { path: 'a.md', toolName: 't', beforeContent: 'old', afterContent: 'new' }, 1);
  const plan = await previewWorkspaceFileRewind({ storage, conversationId: CONVERSATION, reader: readerFrom({ 'a.md': 'new' }), hasher: fakeHasher });
  const operations = planToPatchOperations(plan);
  assert.deepEqual(operations, [
    { kind: 'update', path: 'a.md', previous_sha256: 'h:new', next_content: 'old', next_sha256: 'h:old' },
  ]);
});

test('删除操作映射为原生delete且不带next字段', async () => {
  const storage = memoryStorage();
  // 新建后回退 ⇒ 原生侧是 delete。
  appendWorkspaceFileChange(storage, CONVERSATION, { path: 'new.md', toolName: 't', beforeContent: null, afterContent: 'body' }, 1);
  const plan = await previewWorkspaceFileRewind({ storage, conversationId: CONVERSATION, reader: readerFrom({ 'new.md': 'body' }), hasher: fakeHasher });
  const operations = planToPatchOperations(plan);
  assert.deepEqual(operations, [{ kind: 'delete', path: 'new.md', previous_sha256: 'h:body' }]);
  // 原生 delete 分支不接受 next_sha256 / next_content。
  assert.equal('next_sha256' in operations[0]!, false);
  assert.equal('next_content' in operations[0]!, false);
});

test('阻断的计划映射为空操作列表', async () => {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, CONVERSATION, { path: 'a.md', toolName: 't', beforeContent: 'old', afterContent: 'new' }, 1);
  const plan = await previewWorkspaceFileRewind({ storage, conversationId: CONVERSATION, reader: readerFrom({ 'a.md': 'tampered' }), hasher: fakeHasher });
  assert.equal(plan.canApply, false);
  assert.deepEqual(planToPatchOperations(plan), []);
});

// ---------------------------------------------------------------------------
// IO 适配器
// ---------------------------------------------------------------------------

test('Tauri读取器在成功时返回内容', async () => {
  const reader = createTauriWorkspaceFileStateReader(async (command, args) => {
    assert.equal(command, 'workspace_read_file');
    assert.deepEqual(args, { path: 'a.md' });
    return { content: 'hello', path: 'a.md', byteSize: 5 };
  });
  assert.deepEqual(await reader.read('a.md'), { exists: true, content: 'hello' });
});

test('Tauri读取器把文件不存在判为合法的缺失状态', async () => {
  const reader = createTauriWorkspaceFileStateReader(async () => {
    throw 'workspace-file-not-found';
  });
  // 文件不存在是**合法的当前状态**（回退可能正是要删掉它），不能当成读失败。
  assert.deepEqual(await reader.read('gone.md'), { exists: false, content: null });
});

test('Tauri读取器把其它错误判为读失败', async () => {
  const reader = createTauriWorkspaceFileStateReader(async () => {
    throw 'workspace-file-too-large';
  });
  const state = await reader.read('big.md');
  assert.ok('failed' in state);
  assert.equal(state.failed, 'workspace-file-too-large');
});

test('Tauri读取器对形状不符的返回判为读失败', async () => {
  const reader = createTauriWorkspaceFileStateReader(async () => ({ nope: true }));
  const state = await reader.read('a.md');
  assert.ok('failed' in state);
});

test('WebCrypto摘要器对null返回缺失哨兵', async () => {
  const hasher = createWebCryptoContentHasher();
  assert.equal(await hasher.sha256(null), MISSING_CONTENT_SHA256);
});

test('WebCrypto摘要器与node的sha256一致', async () => {
  const hasher = createWebCryptoContentHasher();
  const value = await hasher.sha256('hello');
  assert.equal(value, createHash('sha256').update('hello').digest('hex'));
});

// ---------------------------------------------------------------------------
// 按检查点位置切片：**只回退那一刻之后**的改动。
//
// 这是本模块最容易犯的错：把整份日志都退回去，在"回到中途某个检查点"时会把更早的
// 改动一起撤掉，而多退不可逆。设计文档写的是"用户要回到的是检查点那一刻"，
// 但旧实现传的是整份日志 —— 第一次接线就会回退过头。
// ---------------------------------------------------------------------------

/** 写三条改动：a.md 两次、b.md 一次，序号 1..3。 */
function threeChanges() {
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, 'conv', { path: 'a.md', toolName: 'workspace_write_file', beforeContent: null, afterContent: 'v1' }, 1);
  appendWorkspaceFileChange(storage, 'conv', { path: 'a.md', toolName: 'workspace_write_file', beforeContent: 'v1', afterContent: 'v2' }, 2);
  appendWorkspaceFileChange(storage, 'conv', { path: 'b.md', toolName: 'workspace_write_file', beforeContent: null, afterContent: 'b1' }, 3);
  return storage;
}

test('从检查点位置切片：只回退该位置之后的改动', async () => {
  // 检查点建在"a.md 已写成 v1"之后（nextSequence = 2），所以只需回退序号 2、3。
  const plan = await previewWorkspaceFileRewind({
    storage: threeChanges(),
    conversationId: 'conv',
    reader: readerFrom({ 'a.md': 'v2', 'b.md': 'b1' }),
    hasher: fakeHasher,
    fromSequence: 2,
  });
  assert.equal(plan.canApply, true);
  // a.md 应回到 v1（而不是删除 —— 删除是"回到会话开始"才该发生的事）。
  const a = plan.operations.find((operation) => operation.path === 'a.md');
  assert.equal(a?.nextContent, 'v1');
});

test('省略fromSequence等于回到会话开始', async () => {
  // 合法用法（"这轮改动我全都不要了"），但与"回到某个检查点"不是一回事。
  const plan = await previewWorkspaceFileRewind({
    storage: threeChanges(),
    conversationId: 'conv',
    reader: readerFrom({ 'a.md': 'v2', 'b.md': 'b1' }),
    hasher: fakeHasher,
  });
  assert.equal(plan.canApply, true);
  // a.md 回到"不存在"，b.md 被删除。
  const a = plan.operations.find((operation) => operation.path === 'a.md');
  assert.equal(a?.action, 'delete');
});

test('位置之后没有改动时计划为空', async () => {
  const plan = await previewWorkspaceFileRewind({
    storage: threeChanges(),
    conversationId: 'conv',
    reader: readerFrom({ 'a.md': 'v2', 'b.md': 'b1' }),
    hasher: fakeHasher,
    fromSequence: 4,
  });
  // "无事可做"是正常结果（已处于目标状态），必须与"被拦下"区分开。
  assert.equal(plan.nothingToDo, true);
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.operations, []);
});

test('够不到检查点位置时阻断而不是少退', async () => {
  // 现存最早记录是序号 2（序号 1 被丢过）：目标位置 2 之后虽然还有记录，
  // 但"把现有的都退了"会漏掉序号 1 那次改动对 a.md 的影响 ——
  // 用户看到"回退成功"，工作区却没回到那一刻。
  const storage = memoryStorage();
  appendWorkspaceFileChange(storage, 'conv', { path: 'a.md', toolName: 'workspace_write_file', beforeContent: 'v1', afterContent: 'v2' }, 2);
  const seeded = JSON.parse(storage.data[workspaceFileJournalKey('conv')]!) as { records: { sequence: number }[] };
  // 手工造出"头部被丢过"的日志：现存最早记录的序号是 2，说明序号 1 那段已经不在了。
  storage.data[workspaceFileJournalKey('conv')] = JSON.stringify({
    version: 2,
    nextSequence: 3,
    records: seeded.records.map((record) => ({ ...record, sequence: 2 })),
    dropped: 0,
    unjournalable: false,
  });
  // 目标位置 1：现存最早记录是 2，中间那段（序号 1）不在。
  const plan = await previewWorkspaceFileRewind({
    storage,
    conversationId: 'conv',
    reader: readerFrom({ 'a.md': 'v2' }),
    hasher: fakeHasher,
    fromSequence: 1,
  });
  assert.equal(plan.canApply, false);
  assert.equal(plan.unsafeFiles[0]?.reason, FILE_REWIND_JOURNAL_INCOMPLETE_CODE);
  assert.deepEqual(plan.operations, []);
});

// ---------------------------------------------------------------------------
// 落盘：必须走与普通补丁**同一条**审批 + stage + commit 路径。
//
// 回退是破坏性动作，另起一套的后果不是"多写代码"，而是审批语义分叉 ——
// 某天两边在"拒绝时是否整批放弃""留痕是否只记真正落盘的"上走偏，
// 就留下一条绕过确认的写入路径，而两条路各自的测试都还是绿的。
// ---------------------------------------------------------------------------

const rewindInvokeCalls: { readonly cmd: string; readonly args: Record<string, unknown> }[] = [];
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      rewindInvokeCalls.push({ cmd, args });
      if (cmd === 'workspace_stage_patch_batch') return 'token-1';
      if (cmd === 'workspace_commit_patch') {
        const staged = (rewindInvokeCalls.filter((call) => call.cmd === 'workspace_stage_patch_batch').at(-1)?.args.request as { operations: { kind: string; path: string }[] }).operations;
        return {
          applied: staged.map((operation) => ({ kind: operation.kind, path: operation.path, byteSize: 3 })),
          rolledBack: [],
          rollbackErrors: [],
        };
      }
      throw `unexpected-command:${cmd}`;
    },
  },
};

/** 造一份"可回退"的计划：a.md 从 v2 回到 v1。 */
async function applicablePlan() {
  return previewWorkspaceFileRewind({
    storage: threeChanges(),
    conversationId: 'conv',
    reader: readerFrom({ 'a.md': 'v2', 'b.md': 'b1' }),
    hasher: fakeHasher,
    fromSequence: 2,
  });
}

test('无事可做时不调用原生也不打扰用户', async () => {
  rewindInvokeCalls.length = 0;
  const plan = await previewWorkspaceFileRewind({
    storage: threeChanges(), conversationId: 'conv', reader: readerFrom({ 'a.md': 'v2', 'b.md': 'b1' }), hasher: fakeHasher, fromSequence: 9,
  });
  const message = await applyFileRewindPlan({ plan, approve: async () => true });
  assert.match(message, /无需改动/);
  assert.deepEqual(rewindInvokeCalls, [], '无事可做时不该碰原生');
});

test('计划被阻断时整次放弃且不调用原生', async () => {
  rewindInvokeCalls.length = 0;
  const blocked = await previewWorkspaceFileRewind({
    storage: threeChanges(), conversationId: 'conv',
    // 磁盘与记录对不上 = 外部改动 → 阻断。
    reader: readerFrom({ 'a.md': '被外部改过', 'b.md': 'b1' }),
    hasher: fakeHasher, fromSequence: 2,
  });
  assert.equal(blocked.canApply, false);
  const message = await applyFileRewindPlan({ plan: blocked, approve: async () => true });
  assert.match(message, /整次阻断/);
  assert.deepEqual(rewindInvokeCalls, [], '阻断时不该碰原生');
});

test('可回退时逐文件审批后 stage+commit', async () => {
  rewindInvokeCalls.length = 0;
  const approvals: string[] = [];
  const message = await applyFileRewindPlan({
    plan: await applicablePlan(),
    approve: async (request) => { approvals.push(request.path); return true; },
  });
  assert.match(message, /已回退 2 个文件操作/);
  // 每个文件都问过一次。
  assert.deepEqual(approvals.sort(), ['a.md', 'b.md']);
  assert.deepEqual(rewindInvokeCalls.map((call) => call.cmd), ['workspace_stage_patch_batch', 'workspace_commit_patch']);
});

test('审批被拒时绝不 stage', async () => {
  rewindInvokeCalls.length = 0;
  const message = await applyFileRewindPlan({
    plan: await applicablePlan(),
    // 第一个文件就拒绝。
    approve: async () => false,
  });
  assert.match(message, /用户拒绝对/);
  assert.match(message, /整批补丁不会写入/);
  assert.deepEqual(rewindInvokeCalls, [], '拒绝后不得触碰原生写入');
});

test('审批请求带上会丢掉的内容而不是空串', async () => {
  // 确认框要让用户看到"这次会丢掉什么"。previous 为空串时，界面会把
  // "改动前是空的"与"其实有内容"显示成一样 —— 确认框就成了走过场。
  rewindInvokeCalls.length = 0;
  const seen: { path: string; previous: string; next: string }[] = [];
  await applyFileRewindPlan({
    plan: await applicablePlan(),
    approve: async (request) => { seen.push({ path: request.path, previous: request.previous, next: request.next }); return true; },
  });
  const a = seen.find((item) => item.path === 'a.md');
  assert.equal(a?.previous, 'v2', '应展示磁盘上将被覆盖的内容');
  assert.equal(a?.next, 'v1', '应展示要写回的内容');
});
