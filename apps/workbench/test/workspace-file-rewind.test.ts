import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  MAX_REWIND_OPERATIONS,
  MISSING_CONTENT_SHA256,
  isShellToolName,
  isWorkspaceFileChangeRecord,
  type ContentHasher,
  type CurrentFileStateReader,
  type WorkspaceFileChangeRecord,
} from '../src/runtime/workspace-file-rewind-contract.js';
import { buildWorkspaceFileRewindPlan, describeFileRewindPlan } from '../src/runtime/workspace-file-rewind.js';

// ---------------------------------------------------------------------------
// 测试替身：规划器不读文件、不算哈希，两者都由端口注入，故这里全部是纯数据。
// 哈希用可读的前缀假实现而非真实 SHA-256 —— 断言里能直接看出「期望的是哪份内容」，
// 失败信息也可读。真实哈希只在一个专门的端口契约测试里用。
// ---------------------------------------------------------------------------

const fakeHasher: ContentHasher = {
  sha256: (content) => (content === null ? MISSING_CONTENT_SHA256 : `h:${content}`),
};

/** 文件表：`string` = 存在且是这份内容；`null` = 不存在；`{failed}` = 读失败。 */
type FileEntry = string | null | { failed: string };

function readerFrom(files: Readonly<Record<string, FileEntry>>): CurrentFileStateReader {
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

function record(
  path: string,
  beforeContent: string | null,
  afterContent: string | null,
  toolName = 'workspace_write_file',
  at = 1,
): WorkspaceFileChangeRecord {
  return { path, toolName, beforeContent, afterContent, at };
}

function planFor(records: readonly WorkspaceFileChangeRecord[], files: Readonly<Record<string, FileEntry>>) {
  return buildWorkspaceFileRewindPlan({ records, reader: readerFrom(files), hasher: fakeHasher });
}

// ---------------------------------------------------------------------------
// 空态与基本操作
// ---------------------------------------------------------------------------

test('空记录返回不可执行且三个列表为空', async () => {
  const plan = await planFor([], {});
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.safeFiles, []);
  assert.deepEqual(plan.unsafeFiles, []);
  assert.deepEqual(plan.ignoredFiles, []);
  assert.deepEqual(plan.operations, []);
});

test('单条更新记录产出还原操作且CAS期望值取记录的after', async () => {
  // 语义：文件原本是 old，被写成 fresh；磁盘现在就是 fresh。
  const plan = await planFor([record('a.md', 'old', 'fresh')], { 'a.md': 'fresh' });
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations.length, 1);
  const [operation] = plan.operations;
  assert.equal(operation.path, 'a.md');
  assert.equal(operation.action, 'restore');
  // 关键：CAS 期望值是记录的 **after**（"我上次写完之后的状态"），不是规划时读到的东西。
  assert.equal(operation.previousSha256, 'h:fresh');
  assert.equal(operation.nextContent, 'old');
  assert.equal(operation.nextSha256, 'h:old');
});

test('写入前不存在的文件产出删除操作且不带目标摘要', async () => {
  const plan = await planFor([record('new.md', null, 'created')], { 'new.md': 'created' });
  assert.equal(plan.canApply, true);
  const [operation] = plan.operations;
  assert.equal(operation.action, 'delete');
  assert.equal(operation.previousSha256, 'h:created');
  assert.equal(operation.nextContent, null);
  // delete 没有目标内容，故目标摘要必须是 null 而不是某个哨兵串 ——
  // 原生 delete 分支不接受 next_sha256。
  assert.equal(operation.nextSha256, null);
});

test('写入把文件删掉时回退为还原且CAS期望值是缺失哨兵', async () => {
  // 删除记录：before 有内容、after 为 null。磁盘上该文件确实已不存在。
  const plan = await planFor([record('gone.md', 'original', null)], { 'gone.md': null });
  assert.equal(plan.canApply, true);
  const [operation] = plan.operations;
  assert.equal(operation.action, 'restore', '删除的回退是还原');
  assert.equal(operation.previousSha256, MISSING_CONTENT_SHA256, '期望当前值 = 文件不存在');
  assert.equal(operation.nextContent, 'original');
  assert.equal(operation.nextSha256, 'h:original');
});

test('删除记录遇上文件被重新创建时阻断', async () => {
  // 记录说"我删掉了它"，但磁盘上又有了 —— 说明有人重建了这个文件。
  const plan = await planFor([record('gone.md', 'original', null)], { 'gone.md': 'recreated' });
  assert.equal(plan.canApply, false);
  assert.equal(plan.unsafeFiles[0]!.reason, 'external_modified');
  assert.equal(plan.unsafeFiles[0]!.expectedSha256, MISSING_CONTENT_SHA256);
  assert.equal(plan.unsafeFiles[0]!.currentSha256, 'h:recreated');
});

test('新建后又被删除时回退动作为删除', async () => {
  // 完整生命周期：原本不存在 → 建 → 删。回退应回到"不存在"。
  const plan = await planFor(
    [record('tmp.md', null, 'body'), record('tmp.md', 'body', null)],
    { 'tmp.md': null },
  );
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations[0]!.action, 'delete');
  assert.equal(plan.operations[0]!.nextContent, null);
});

test('安全文件报告里的动作与操作一致', async () => {
  const plan = await planFor([record('a.md', 'old', 'fresh')], { 'a.md': 'fresh' });
  assert.deepEqual(plan.safeFiles, [
    { path: 'a.md', action: 'restore', operationCount: 1, toolNames: ['workspace_write_file'] },
  ]);
});

// ---------------------------------------------------------------------------
// 同一路径的多次写入：折叠 + 逆序校验
// ---------------------------------------------------------------------------

test('同一路径多次写入折叠为一条操作', async () => {
  // a.md: old → mid → fresh，磁盘现为 fresh。
  const plan = await planFor(
    [record('a.md', 'old', 'mid', 'workspace_write_file', 1), record('a.md', 'mid', 'fresh', 'workspace_apply_patch', 2)],
    { 'a.md': 'fresh' },
  );
  assert.equal(plan.canApply, true);
  // 原生 patch 批次不允许重复路径，故必须折叠成一条。
  assert.equal(plan.operations.length, 1);
  const [operation] = plan.operations;
  assert.equal(operation.previousSha256, 'h:fresh', 'CAS 期望值取最新一条的 after');
  assert.equal(operation.nextContent, 'old', '目标内容取最早一条的 before');
  assert.deepEqual(operation.toolNames, ['workspace_apply_patch', 'workspace_write_file']);
  assert.equal(plan.safeFiles[0]!.operationCount, 2);
});

test('逆序校验使得链式写入不会被误判为外部改动', async () => {
  // 这条测试是「必须逆序」的证明。若改成正序遍历：
  // 第一条的 after 是 mid，而磁盘是 fresh，会立刻误判 external_modified。
  const plan = await planFor(
    [record('a.md', 'old', 'mid'), record('a.md', 'mid', 'fresh')],
    { 'a.md': 'fresh' },
  );
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.unsafeFiles, []);
});

test('三段链式写入同样通过且目标是第一段之前的内容', async () => {
  const plan = await planFor(
    [record('a.md', 'v0', 'v1'), record('a.md', 'v1', 'v2'), record('a.md', 'v2', 'v3')],
    { 'a.md': 'v3' },
  );
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]!.nextContent, 'v0');
  assert.equal(plan.operations[0]!.previousSha256, 'h:v3');
});

test('同一路径最早一条是新建时回退动作为删除', async () => {
  const plan = await planFor(
    [record('a.md', null, 'first'), record('a.md', 'first', 'second')],
    { 'a.md': 'second' },
  );
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations[0]!.action, 'delete');
  assert.equal(plan.safeFiles[0]!.action, 'delete');
});

test('同一路径的计数不重复累加', async () => {
  const plan = await planFor(
    [record('a.md', 'v0', 'v1'), record('a.md', 'v1', 'v2'), record('a.md', 'v2', 'v3')],
    { 'a.md': 'v3' },
  );
  // 三次写入 ⇒ 计数 3，不能因为「成功路径」与「失败路径」两处各加一次而变成 6。
  assert.equal(plan.safeFiles[0]!.operationCount, 3);
});

// ---------------------------------------------------------------------------
// 阻断：四种不安全成因
// ---------------------------------------------------------------------------

test('磁盘内容与记录after不符时整次阻断并给出两侧摘要', async () => {
  // 记录说写成了 fresh，但磁盘上是别人改过的 other。
  const plan = await planFor([record('a.md', 'old', 'fresh')], { 'a.md': 'other' });
  assert.equal(plan.canApply, false);
  assert.equal(plan.unsafeFiles.length, 1);
  const [unsafe] = plan.unsafeFiles;
  assert.equal(unsafe.path, 'a.md');
  assert.equal(unsafe.reason, 'external_modified');
  assert.equal(unsafe.currentSha256, 'h:other');
  assert.equal(unsafe.expectedSha256, 'h:fresh');
});

test('文件被删除也算外部改动', async () => {
  const plan = await planFor([record('a.md', 'old', 'fresh')], { 'a.md': null });
  assert.equal(plan.canApply, false);
  assert.equal(plan.unsafeFiles[0]!.reason, 'external_modified');
  assert.equal(plan.unsafeFiles[0]!.currentSha256, MISSING_CONTENT_SHA256);
});

test('读不到当前状态时整次阻断', async () => {
  const plan = await planFor([record('a.md', 'old', 'fresh')], { 'a.md': { failed: '权限不足' } });
  assert.equal(plan.canApply, false);
  assert.equal(plan.unsafeFiles[0]!.reason, 'file_read_failed');
  assert.equal(plan.unsafeFiles[0]!.message, '权限不足');
});

test('非法记录判为不可用记录', async () => {
  const broken = { path: 'a.md', toolName: 'workspace_write_file', at: 1 } as unknown as WorkspaceFileChangeRecord;
  const plan = await planFor([broken], {});
  assert.equal(plan.canApply, false);
  assert.equal(plan.unsafeFiles[0]!.reason, 'unsupported_record');
});

test('连路径都拿不到时用占位路径报告而不是静默丢弃', async () => {
  const plan = await planFor([null as unknown as WorkspaceFileChangeRecord], {});
  assert.equal(plan.unsafeFiles.length, 1, '一条坏记录必须出现在报告里');
  assert.equal(plan.unsafeFiles[0]!.path, '(unparseable-record)');
  assert.equal(plan.unsafeFiles[0]!.reason, 'unsupported_record');
});

test('不安全的路径会从安全集里剔除', async () => {
  // 同一路径：后一条能通过校验、更早那条的前置状态对不上。
  // 逆序遍历时先通过（进入安全集），随后被推翻 —— 必须从安全集移除。
  const plan = await planFor(
    [record('a.md', 'v0', 'v1'), record('a.md', 'v1', 'v2')],
    { 'a.md': 'v1' }, // 磁盘停在 v1：后一条（v1→v2）的 after 对不上 ⇒ 阻断
  );
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.safeFiles, []);
  assert.equal(plan.unsafeFiles[0]!.reason, 'external_modified');
});

test('先通过后被更早一条推翻的路径也会从安全集剔除', async () => {
  // 这条才真正走到「剔除」那一步：最新一条校验通过（于是进了安全集），
  // 更早一条的 after 与模拟状态对不上（日志不自洽），必须把它从安全集踢出去。
  //
  // 日志不自洽是**可达**的：记录经 localStorage 往返，可能被截断、被旧版本写坏、
  // 或被并发标签页交错写入。此时不能拿算出来的目标去覆盖文件 —— 那个目标
  // 建立在自相矛盾的输入上。
  const plan = await planFor(
    [record('a.md', 'x', 'y'), record('a.md', 'b', 'c')], // 链条断裂：y ≠ b
    { 'a.md': 'c' }, // 最新一条（b→c）的 after 与磁盘一致，先通过
  );
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.safeFiles, [], '被推翻的路径必须从安全集剔除');
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.unsafeFiles.length, 1);
  assert.equal(plan.unsafeFiles[0]!.path, 'a.md');
  assert.equal(plan.unsafeFiles[0]!.reason, 'external_modified');
  // 该路径上的两条记录都要计数，否则报告会低估这条路径被写了几次。
  assert.equal(plan.unsafeFiles[0]!.operationCount, 2);
});

test('任一文件不安全时操作列表为空即使另一个文件安全', async () => {
  const plan = await planFor(
    [record('ok.md', 'old', 'fresh'), record('bad.md', 'old', 'fresh')],
    { 'ok.md': 'fresh', 'bad.md': 'tampered' },
  );
  assert.equal(plan.canApply, false);
  // 部分回退会让工作区进入一个从未存在过的中间状态，故整次阻断。
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.unsafeFiles.length, 1);
  assert.equal(plan.unsafeFiles[0]!.path, 'bad.md');
  // 但**安全文件仍要如实列出**：报告的价值在于说清"本来可以回退哪些、被哪一个挡住了"，
  // 把安全文件也一并抹掉会让用户以为所有文件都有问题。
  assert.deepEqual(plan.safeFiles.map((file) => file.path), ['ok.md']);
});

// ---------------------------------------------------------------------------
// shell 工具：忽略但不阻断
// ---------------------------------------------------------------------------

test('shell工具的记录归入忽略且不阻断回退', async () => {
  const plan = await planFor(
    [record('a.md', 'old', 'fresh'), record('scratch.txt', null, 'x', 'bash', 2)],
    { 'a.md': 'fresh' },
  );
  assert.equal(plan.canApply, true, 'shell 记录不该阻断');
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]!.path, 'a.md');
  assert.deepEqual(plan.ignoredFiles, [
    { path: 'scratch.txt', reason: 'shell_ignored', operationCount: 1, toolNames: ['bash'] },
  ]);
});

test('只有shell记录时不可执行但不是阻断', async () => {
  const plan = await planFor([record('x', null, 'y', 'bash')], {});
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.unsafeFiles, [], '忽略不等于阻断');
  assert.equal(plan.ignoredFiles.length, 1);
});

// ---------------------------------------------------------------------------
// 单批上限
// ---------------------------------------------------------------------------

test('超过单批上限时整次拒绝且不截断', async () => {
  const count = MAX_REWIND_OPERATIONS + 1;
  const records: WorkspaceFileChangeRecord[] = [];
  const files: Record<string, FileEntry> = {};
  for (let index = 0; index < count; index += 1) {
    records.push(record(`f${index}.md`, 'old', 'fresh', 'workspace_write_file', index));
    files[`f${index}.md`] = 'fresh';
  }
  const plan = await planFor(records, files);
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.operations, [], '不得截断成前 32 条 —— 那是部分回退');
  const capped = plan.unsafeFiles.find((file) => file.reason === 'too_many_operations');
  assert.ok(capped, '必须给出超限原因');
  assert.equal(capped.path, 'workspace');
  assert.match(capped.message ?? '', new RegExp(String(count)));
});

test('恰好达到上限时可以通过', async () => {
  const records: WorkspaceFileChangeRecord[] = [];
  const files: Record<string, FileEntry> = {};
  for (let index = 0; index < MAX_REWIND_OPERATIONS; index += 1) {
    records.push(record(`f${index}.md`, 'old', 'fresh', 'workspace_write_file', index));
    files[`f${index}.md`] = 'fresh';
  }
  const plan = await planFor(records, files);
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations.length, MAX_REWIND_OPERATIONS);
});

// ---------------------------------------------------------------------------
// 端口契约与排序
// ---------------------------------------------------------------------------

test('哈希端口可以是同步实现', async () => {
  // 真实实现走 WebCrypto（异步），但端口允许同步 —— 否则纯数据测试要处处 await。
  const plan = await buildWorkspaceFileRewindPlan({
    records: [record('a.md', 'old', 'fresh')],
    reader: readerFrom({ 'a.md': 'fresh' }),
    hasher: { sha256: (content) => `sync:${content ?? 'nil'}` },
  });
  assert.equal(plan.operations[0]!.previousSha256, 'sync:fresh');
});

test('真实sha256端口满足端口契约', async () => {
  const hasher: ContentHasher = {
    sha256: async (content) =>
      content === null
        ? MISSING_CONTENT_SHA256
        : createHash('sha256').update(content).digest('hex'),
  };
  const plan = await buildWorkspaceFileRewindPlan({
    records: [record('a.md', 'old', 'fresh')],
    reader: readerFrom({ 'a.md': 'fresh' }),
    hasher,
  });
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations[0]!.previousSha256, createHash('sha256').update('fresh').digest('hex'));
});

test('报告按路径排序以保证输出稳定', async () => {
  const plan = await planFor(
    [record('z.md', 'old', 'fresh', 'workspace_write_file', 3), record('a.md', 'old', 'fresh', 'workspace_write_file', 1)],
    { 'z.md': 'fresh', 'a.md': 'fresh' },
  );
  assert.deepEqual(plan.safeFiles.map((file) => file.path), ['a.md', 'z.md']);
  assert.deepEqual(plan.operations.map((operation) => operation.path), ['a.md', 'z.md']);
});

test('忽略与不安全报告同样排序', async () => {
  const plan = await planFor(
    [record('z.txt', null, 'x', 'bash', 1), record('a.txt', null, 'x', 'bash', 2), record('m.md', 'old', 'fresh', 'workspace_write_file', 3)],
    { 'm.md': 'tampered' },
  );
  assert.deepEqual(plan.ignoredFiles.map((file) => file.path), ['a.txt', 'z.txt']);
});

test('可由调用方覆盖shell工具判据', async () => {
  const plan = await buildWorkspaceFileRewindPlan({
    records: [record('a.md', 'old', 'fresh', 'my_custom_tool')],
    reader: readerFrom({ 'a.md': 'fresh' }),
    hasher: fakeHasher,
    isShellTool: (toolName) => toolName === 'my_custom_tool',
  });
  assert.equal(plan.ignoredFiles.length, 1);
  assert.deepEqual(plan.operations, []);
});

// ---------------------------------------------------------------------------
// 摘要文案
// ---------------------------------------------------------------------------

test('没有改动时的摘要为空态文案', async () => {
  const plan = await planFor([], {});
  assert.equal(describeFileRewindPlan(plan), '没有需要回退的文件改动。');
});

test('可执行摘要列出文件与动作', async () => {
  const plan = await planFor(
    [record('a.md', 'old', 'fresh'), record('new.md', null, 'created')],
    { 'a.md': 'fresh', 'new.md': 'created' },
  );
  const text = describeFileRewindPlan(plan);
  assert.match(text, /可回退 2 个文件/);
  assert.match(text, /a\.md：还原到检查点时的内容/);
  assert.match(text, /new\.md：删除（该文件在检查点时还不存在）/);
});

test('阻断摘要说明未做任何改动并给出原因', async () => {
  const plan = await planFor([record('a.md', 'old', 'fresh')], { 'a.md': 'other' });
  const text = describeFileRewindPlan(plan);
  assert.match(text, /回退被阻断，未做任何改动/);
  assert.match(text, /external_modified/);
});

test('忽略文件在摘要里被如实标注不会还原', async () => {
  const plan = await planFor([record('a.md', 'old', 'fresh'), record('s.txt', null, 'x', 'bash', 2)], { 'a.md': 'fresh' });
  const text = describeFileRewindPlan(plan);
  assert.match(text, /s\.txt：未追踪（shell_ignored），不会还原/);
});

// ---------------------------------------------------------------------------
// 契约层判据
// ---------------------------------------------------------------------------

test('shell工具判据覆盖bash与terminal但不误伤普通工具', () => {
  for (const name of ['bash', 'Bash', 'shell', 'terminal', 'run_terminal_cmd', 'zcode_process_shell']) {
    assert.equal(isShellToolName(name), true, `${name} 应判为 shell 类`);
  }
  for (const name of ['workspace_write_file', 'workspace_apply_patch', 'read_file', 'shelly']) {
    assert.equal(isShellToolName(name), false, `${name} 不应判为 shell 类`);
  }
});

test('缺少beforeContent字段与显式null是两件事', () => {
  const base = { path: 'a.md', toolName: 't', afterContent: 'x', at: 1 };
  assert.equal(isWorkspaceFileChangeRecord({ ...base, beforeContent: null }), true, 'null 是合法值：当时没有这个文件');
  assert.equal(isWorkspaceFileChangeRecord(base), false, '字段缺失是记录损坏，不能当成 null');
  assert.equal(isWorkspaceFileChangeRecord({ ...base, beforeContent: 1 }), false);
  assert.equal(isWorkspaceFileChangeRecord({ ...base, path: '   ' }), false);
  assert.equal(isWorkspaceFileChangeRecord({ ...base, afterContent: undefined }), false);
  assert.equal(isWorkspaceFileChangeRecord(null), false);
  assert.equal(isWorkspaceFileChangeRecord('a.md'), false);
});

test('记录顺序按传入顺序而非时间戳', async () => {
  // 时间戳故意倒置：日志顺序才是因果顺序，按 at 排序会把因果颠倒。
  const plan = await planFor(
    [record('a.md', 'old', 'mid', 'workspace_write_file', 999), record('a.md', 'mid', 'fresh', 'workspace_write_file', 1)],
    { 'a.md': 'fresh' },
  );
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations[0]!.nextContent, 'old');
  assert.equal(plan.operations[0]!.previousSha256, 'h:fresh');
});
