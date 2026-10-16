// 工作区文件变更日志 —— 按会话记录每次成功写入的 before/after 内容。
//
// ## 为什么需要它
//
// `use-direct-conversations.ts` 的检查点只存**对话快照**，回退对话不还原文件。
// 要还原文件，就必须在写入发生时把"改动前后分别是什么"记下来 —— 而这份信息
// **只在写入的那一刻存在**：`workspace-tools.ts` 在批准时手上就有原文与新文，
// 落盘之后就再也拿不回来了（除非去翻 git，而工作区未必是 git 仓库）。
//
// 因此本模块挂在**写入成功之后**：记录捕获是写入路径的副产品，不是事后扫描。
//
// ## 不变式
//
// 1. **只在写入成功之后记录**。失败或回滚的写入不得留痕 —— 留痕会让回退去"还原"
//    一个从未发生过的状态。
// 2. **顺序即因果**。记录按追加顺序存储，规划器据此逆序校验；因此不得重排、不得去重。
// 3. **不完整就作废，不留洞**。日志有洞比没有日志更危险：没有日志等于"回退不可用"，
//    有洞的日志等于"我们以为知道全部，其实不知道"。故一旦出现无法记录的写入
//    （单条过大、配额写失败、结构损坏），本会话的日志整体作废（`unjournalable`）。
// 4. **内容来自不可信存储**。读取时逐字段校验（`isWorkspaceFileChangeRecord`），
//    非法记录计入 `droppedCount` 而不是被当成合法记录。
//
// 与 `workspace-file-rewind.ts` 的分工：本模块只管**存取**，判定与规划全在那边。

import {
  MAX_FILE_CHANGE_RECORDS,
  MAX_RECORDED_CONTENT_CHARS,
  isWorkspaceFileChangeRecord,
  type WorkspaceFileChangeRecord,
} from './workspace-file-rewind-contract.js';

/** 存储端口。注入而非直接摸 `window`：本模块要能在 Node 里纯数据单测。 */
export interface WorkspaceFileJournalStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/** 一次待记录的文件变更。字段与 `WorkspaceFileChangeRecord` 相同，去掉时间戳。 */
export interface WorkspaceFileChangeInput {
  readonly path: string;
  readonly toolName: string;
  /** 写入前的内容；`null` 表示写入前文件不存在。 */
  readonly beforeContent: string | null;
  /** 写入后的内容；`null` 表示这次写入把文件删掉了。 */
  readonly afterContent: string | null;
}

/** 供写入路径注入的回调。与 `WorkspaceWriteApprover` 同款：可选、可缺席。 */
export type WorkspaceFileChangeRecorder = (change: WorkspaceFileChangeInput) => void;

/** 读取结果。`droppedCount` 与 `unjournalable` 都是**不完整信号**，调用方必须据此阻断回退。 */
export interface WorkspaceFileJournalSnapshot {
  readonly records: readonly WorkspaceFileChangeRecord[];
  /** 因结构非法或超出容量上限而被丢弃的记录数。 */
  readonly droppedCount: number;
  /** 本会话的日志已作废（曾出现无法记录的写入）。 */
  readonly unjournalable: boolean;
}

export const WORKSPACE_FILE_JOURNAL_KEY_PREFIX = 'awo.workspace-file-journal.v1.';

interface StoredJournal {
  readonly version: 1;
  readonly records: readonly unknown[];
  readonly dropped: number;
  readonly unjournalable: boolean;
}

export function workspaceFileJournalKey(conversationId: string): string {
  return `${WORKSPACE_FILE_JOURNAL_KEY_PREFIX}${conversationId}`;
}

function emptyStored(): StoredJournal {
  return { version: 1, records: [], dropped: 0, unjournalable: false };
}

/**
 * 读回原始存储结构。
 *
 * 存储内容不可信（可被手改、被旧版本写坏、被并发标签页交错写）：形状不对时
 * **不猜测**，直接返回空日志并置 `unjournalable` —— 猜错的代价是"按错误的
 * 历史去还原文件"。
 */
function readStored(storage: WorkspaceFileJournalStorage, conversationId: string): StoredJournal {
  let raw: string | null;
  try {
    raw = storage.read(workspaceFileJournalKey(conversationId));
  } catch {
    return { ...emptyStored(), unjournalable: true };
  }
  if (raw === null) return emptyStored();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...emptyStored(), unjournalable: true };
  }
  if (!parsed || typeof parsed !== 'object') return { ...emptyStored(), unjournalable: true };
  const candidate = parsed as Partial<StoredJournal>;
  if (candidate.version !== 1 || !Array.isArray(candidate.records)) {
    return { ...emptyStored(), unjournalable: true };
  }
  const dropped = typeof candidate.dropped === 'number' && candidate.dropped >= 0 ? candidate.dropped : 0;
  return {
    version: 1,
    records: candidate.records,
    dropped,
    unjournalable: candidate.unjournalable === true,
  };
}

function writeStored(
  storage: WorkspaceFileJournalStorage,
  conversationId: string,
  journal: StoredJournal,
): boolean {
  try {
    storage.write(workspaceFileJournalKey(conversationId), JSON.stringify(journal));
    return true;
  } catch {
    // 配额写满或存储不可用：不能让"写不进去"表现为"没有改动"，故由调用方作废整份日志。
    return false;
  }
}

/** 单条记录是否可入日志。过大的内容无法保证可还原，故拒收。 */
function isJournalable(change: WorkspaceFileChangeInput): boolean {
  if (!change.path.trim()) return false;
  if (change.afterContent !== null && change.afterContent.length > MAX_RECORDED_CONTENT_CHARS) return false;
  if (change.beforeContent !== null && change.beforeContent.length > MAX_RECORDED_CONTENT_CHARS) return false;
  return true;
}

/**
 * 读取某会话的文件变更日志。
 *
 * `records` 只含**通过校验**的记录；被丢弃的数量由 `droppedCount` 如实报出。
 * 调用方只要看到 `droppedCount > 0` 或 `unjournalable` 为真，就**必须阻断回退**
 * （不能拿一份不完整的历史去还原文件）。
 */
export function readWorkspaceFileJournal(
  storage: WorkspaceFileJournalStorage,
  conversationId: string,
): WorkspaceFileJournalSnapshot {
  const stored = readStored(storage, conversationId);
  const records: WorkspaceFileChangeRecord[] = [];
  let droppedCount = stored.dropped;
  for (const raw of stored.records) {
    if (isWorkspaceFileChangeRecord(raw)) records.push(raw);
    else droppedCount += 1;
  }
  return { records, droppedCount, unjournalable: stored.unjournalable };
}

/**
 * 追加一条文件变更记录。**只在写入成功之后调用**。
 *
 * 超出条数上限时丢弃最旧的记录并累加 `droppedCount`：丢弃最旧的会丢掉最早的
 * 历史，而丢弃最新的会让最近的改动无法回退 —— 后者更糟，因为用户最可能想撤销
 * 的就是刚刚发生的事。
 */
export function appendWorkspaceFileChange(
  storage: WorkspaceFileJournalStorage,
  conversationId: string,
  change: WorkspaceFileChangeInput,
  now: number = Date.now(),
): void {
  const stored = readStored(storage, conversationId);

  if (stored.unjournalable) return; // 已作废的日志不再追加：追加只会掩盖"曾经有过洞"。

  if (!isJournalable(change)) {
    // 不留洞：整份作废。见文件头不变量 3。
    writeStored(storage, conversationId, { ...emptyStored(), unjournalable: true });
    return;
  }

  const record: WorkspaceFileChangeRecord = {
    path: change.path,
    toolName: change.toolName,
    beforeContent: change.beforeContent,
    afterContent: change.afterContent,
    at: now,
  };

  const records = [...stored.records, record];
  let dropped = stored.dropped;
  while (records.length > MAX_FILE_CHANGE_RECORDS) {
    records.shift();
    dropped += 1;
  }

  if (!writeStored(storage, conversationId, { version: 1, records, dropped, unjournalable: false })) {
    // 写不进去（配额满）：作废，而不是静默丢弃这条 —— 静默丢弃就是一个洞。
    writeStored(storage, conversationId, { ...emptyStored(), unjournalable: true });
  }
}

/** 清空某会话的日志。用于"回退已完成"或用户主动丢弃历史。 */
export function clearWorkspaceFileJournal(
  storage: WorkspaceFileJournalStorage,
  conversationId: string,
): void {
  try {
    storage.write(workspaceFileJournalKey(conversationId), JSON.stringify(emptyStored()));
  } catch {
    /* 清不掉也不该让调用方崩：下次读取会因结构非法而自然作废。 */
  }
}

/** 造一个绑定到某会话的录制器，供 `executeWorkspaceTool` 注入。 */
export function createWorkspaceFileRecorder(
  storage: WorkspaceFileJournalStorage,
  conversationId: string,
): WorkspaceFileChangeRecorder {
  return (change) => appendWorkspaceFileChange(storage, conversationId, change);
}

/** 基于 `window.localStorage` 的存储实现。不可用时降级为"什么都记不下"。 */
export function createLocalStorageWorkspaceFileJournalStorage(): WorkspaceFileJournalStorage {
  return {
    read(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(key, value) {
      window.localStorage.setItem(key, value);
    },
  };
}
