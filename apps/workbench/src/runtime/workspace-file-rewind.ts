// 工作区文件回退 —— 纯规划器。
//
// 零 IO、零副作用：不读文件、不算哈希、不写文件。三者中前两者由调用方注入的端口提供，
// 第三个由调用方在拿到计划后执行。因此本模块可纯数据单测，边界条件不必 mock 文件系统。
//
// 设计依据见 `docs/design/workspace-file-rewind-cas-design.md`。三条关键约束：
// ① 回退的 CAS 期望值取自**检查点记录的 after 状态**，不是"规划时刚读到的内容"
//    （后者会让守卫退化成恒真）；
// ② 同一路径的多次写入必须**逆序**校验，否则第二条起必然误判为外部改动；
// ③ 任一文件不安全即**整次阻断**，不产出"部分可执行"的计划。

import {
  MAX_REWIND_OPERATIONS,
  MISSING_CONTENT_SHA256,
  isShellToolName,
  isWorkspaceFileChangeRecord,
  type ContentHasher,
  type CurrentFileStateReader,
  type FileRewindIgnoredFile,
  type FileRewindOperation,
  type FileRewindPlan,
  type FileRewindSafeFile,
  type FileRewindUnsafeFile,
  type FileRewindUnsafeReason,
  type WorkspaceFileChangeRecord,
} from './workspace-file-rewind-contract.js';

/** 某个路径在某一时刻的状态。`sha256` 恒有值（内容缺失时用哨兵）。 */
interface FileState {
  readonly content: string | null;
  readonly exists: boolean;
  readonly sha256: string;
}

/** 聚合到路径维度的报告条目。 */
interface Aggregate {
  readonly path: string;
  operationCount: number;
  readonly toolNames: Set<string>;
}

/** 安全路径的聚合：额外记住该路径的回退动作。 */
interface SafeAggregate extends Aggregate {
  /** 每次成功校验都会覆盖；逆序遍历使它最终停在**最早一条**的动作上，即回退动作。 */
  action: 'restore' | 'delete';
}

interface UnsafeAggregate extends Aggregate {
  reason: FileRewindUnsafeReason;
  message?: string;
  currentSha256?: string;
  expectedSha256?: string;
}

/** 无法解析的记录在报告里的占位路径。 */
const UNPARSEABLE_RECORD_PATH = '(unparseable-record)';

/** 非文件级的阻断（如超过单批上限）在报告里的占位路径，与 ZCode 的 `workspace` 同义。 */
const WORKSPACE_SCOPE_PATH = 'workspace';

export interface FileRewindPlanInput {
  /**
   * 变更记录，**必须按写入顺序（升序）传入**。
   *
   * 刻意不按 `at` 排序：时间戳可能并列、可能因系统时钟回拨而后退，而日志顺序
   * 就是因果顺序。排序会把"先写 A 再写 B"误判成"先写 B 再写 A"。
   */
  readonly records: readonly WorkspaceFileChangeRecord[];
  readonly reader: CurrentFileStateReader;
  readonly hasher: ContentHasher;
  /** 覆盖默认的 shell 工具判据；缺省用契约里的 `isShellToolName`。 */
  readonly isShellTool?: (toolName: string) => boolean;
}

/**
 * 规划一次工作区文件回退。
 *
 * 输入是**目标检查点之后**的全部变更记录（调用方负责切片）。
 * 输出是可审计的计划；`canApply` 为 `false` 时 `operations` 必为空数组。
 */
export async function buildWorkspaceFileRewindPlan(input: FileRewindPlanInput): Promise<FileRewindPlan> {
  const shellTool = input.isShellTool ?? isShellToolName;
  const digest = async (content: string | null): Promise<string> => {
    const value = await input.hasher.sha256(content);
    return typeof value === 'string' && value ? value : MISSING_CONTENT_SHA256;
  };

  const unsafeByPath = new Map<string, UnsafeAggregate>();
  const ignoredByPath = new Map<string, Aggregate>();
  const safeByPath = new Map<string, SafeAggregate>();

  /** 记录一次不安全的成因。**计数与工具名在此处统一累加**，调用方不得重复累加。 */
  const markUnsafe = (
    path: string,
    toolName: string,
    reason: FileRewindUnsafeReason,
    extra: { message?: string; currentSha256?: string; expectedSha256?: string } = {},
  ): void => {
    const existing = unsafeByPath.get(path);
    if (existing) {
      existing.operationCount += 1;
      existing.toolNames.add(toolName);
      // 原因**不覆盖**：最先发现的成因最有诊断价值（后续往往只是它的连带结果）。
      existing.message ??= extra.message;
      existing.currentSha256 ??= extra.currentSha256;
      existing.expectedSha256 ??= extra.expectedSha256;
      return;
    }
    unsafeByPath.set(path, {
      path,
      operationCount: 1,
      toolNames: new Set([toolName]),
      reason,
      ...extra,
    });
  };

  const bumpIgnored = (path: string, toolName: string): void => {
    const existing = ignoredByPath.get(path);
    if (existing) {
      existing.operationCount += 1;
      existing.toolNames.add(toolName);
      return;
    }
    ignoredByPath.set(path, { path, operationCount: 1, toolNames: new Set([toolName]) });
  };

  // ── ① 校验并分类记录 ──────────────────────────────────────────────
  // 记录经 localStorage 往返，形状不可信：逐字段校验，非法即判 unsupported_record
  // （而不是抛异常或静默丢弃 —— 静默丢弃会让"有一条记录坏了"凭空消失）。
  const candidates: WorkspaceFileChangeRecord[] = [];
  /** 每条路径上的记录总数（含被判为非法的），用于把报告里的计数修到真实值。 */
  const totalOperationsByPath = new Map<string, number>();
  const bumpTotal = (path: string): void => {
    totalOperationsByPath.set(path, (totalOperationsByPath.get(path) ?? 0) + 1);
  };
  for (const raw of input.records) {
    if (!isWorkspaceFileChangeRecord(raw)) {
      const guess = (raw as { path?: unknown } | null)?.path;
      const path = typeof guess === 'string' && guess.trim() ? guess : UNPARSEABLE_RECORD_PATH;
      bumpTotal(path);
      markUnsafe(path, '', 'unsupported_record', { message: '记录形状非法，无法用于回退。' });
      continue;
    }
    bumpTotal(raw.path);
    if (shellTool(raw.toolName)) {
      // shell 类工具的改动不经 CAS，系统无从知道它改了什么 —— 不阻断，但如实报告。
      bumpIgnored(raw.path, raw.toolName);
      continue;
    }
    candidates.push(raw);
  }

  // ── ② 逆序校验 + 模拟 ────────────────────────────────────────────
  // `initialByPath` 保存每个路径**磁盘上的真实状态**（由最新一条记录的 CAS 校验确认），
  // `simulated` 随逆序遍历逐步回退，循环结束时持有**最早的 before**（= 回退目标）。
  const initialByPath = new Map<string, FileState>();
  const simulated = new Map<string, FileState>();
  const safePaths = new Set<string>();

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const record = candidates[index]!;
    const { path, toolName } = record;

    // 已经判定不安全的路径，其更早的操作不再校验，但**仍要计数**——
    // 报告里的 operationCount 是"这条路径被写了多少次"，少算会误导。
    if (unsafeByPath.has(path)) {
      markUnsafe(path, toolName, unsafeByPath.get(path)!.reason);
      continue;
    }

    let current = simulated.get(path);
    if (!current) {
      const read = await input.reader.read(path);
      if ('failed' in read) {
        markUnsafe(path, toolName, 'file_read_failed', { message: read.failed });
        continue;
      }
      current = { content: read.content, exists: read.exists, sha256: await digest(read.content) };
      initialByPath.set(path, current);
    }

    const expectedSha256 = await digest(record.afterContent);
    if (current.sha256 !== expectedSha256) {
      // 磁盘上的内容不等于"我上次写完之后的状态" ⇒ 该文件在检查点之后被动过。
      // 此时覆盖会静默丢弃别人的改动，故整次阻断。
      markUnsafe(path, toolName, 'external_modified', {
        currentSha256: current.sha256,
        expectedSha256,
        message: '该文件在检查点之后被改动过，回退会覆盖这些改动。',
      });
      continue;
    }

    const nextContent = record.beforeContent;
    simulated.set(path, {
      content: nextContent,
      exists: nextContent !== null,
      sha256: await digest(nextContent),
    });
    safePaths.add(path);

    const nextAction: 'restore' | 'delete' = nextContent !== null ? 'restore' : 'delete';
    const existingSafe = safeByPath.get(path);
    if (existingSafe) {
      existingSafe.operationCount += 1;
      existingSafe.toolNames.add(toolName);
      // 逆序遍历下最后写入的就是**最早一条**，故这里覆盖得到的是正确的回退动作。
      existingSafe.action = nextAction;
    } else {
      safeByPath.set(path, {
        path,
        operationCount: 1,
        toolNames: new Set([toolName]),
        action: nextAction,
      });
    }
  }

  // 判定为不安全的路径必须从安全集里剔除：它可能在校验通过后才被更早的操作推翻，
  // 两者会同时存在于两个 Map 里。
  for (const path of unsafeByPath.keys()) safeByPath.delete(path);

  // 不安全路径的 `operationCount` 要报告"这条路径一共被写了几次"，而不是"有几条
  // 记录触发了不安全判定"——后者会低估（例如最新一条通过、更早一条被推翻时只有 1）。
  // 报告是用来判断影响面的，低估会让用户以为只动过一两次。
  for (const [path, unsafe] of unsafeByPath) {
    if (path === WORKSPACE_SCOPE_PATH) continue; // 非文件级的阻断没有对应的记录数
    unsafe.operationCount = Math.max(unsafe.operationCount, totalOperationsByPath.get(path) ?? 0);
  }

  // ── ③ 折叠成每路径一条操作 ───────────────────────────────────────
  // 原生 patch 批次**不允许重复路径**，故同一路径的多次写入折叠成一条：
  // CAS 期望值取最新一条的 after（磁盘现状），目标内容取最早一条的 before。
  const operations: FileRewindOperation[] = [];
  for (const path of [...safePaths].sort()) {
    const initial = initialByPath.get(path);
    const target = simulated.get(path);
    const safe = safeByPath.get(path);
    if (!initial || !target || !safe) continue;
    operations.push({
      path,
      action: safe.action,
      previousSha256: initial.sha256,
      nextContent: target.content,
      nextSha256: target.exists ? target.sha256 : null,
      toolNames: [...safe.toolNames].sort(),
    });
  }

  // 超过单批上限：整次拒绝，**不截断**（截断等于部分回退，见设计文档 §3.2）。
  if (operations.length > MAX_REWIND_OPERATIONS) {
    markUnsafe(WORKSPACE_SCOPE_PATH, '', 'too_many_operations', {
      message: `待回退文件数 ${operations.length} 超过单批上限 ${MAX_REWIND_OPERATIONS}；已整次拒绝，未做任何部分回退。`,
    });
  }

  const safeFiles = [...safeByPath.values()].map(toSafeFile).sort(byPath);
  const unsafeFiles = [...unsafeByPath.values()].map(toUnsafeFile).sort(byPath);
  const ignoredFiles = [...ignoredByPath.values()].map(toIgnoredFile).sort(byPath);
  const blocked = unsafeFiles.length > 0;

  return {
    canApply: safeFiles.length > 0 && !blocked,
    safeFiles,
    unsafeFiles,
    ignoredFiles,
    operations: blocked ? [] : operations,
  };
}

/** 计划的稳定可读摘要。供 UI 与日志共用，避免两处各写一套措辞。 */
export function describeFileRewindPlan(plan: FileRewindPlan): string {
  if (plan.safeFiles.length === 0 && plan.unsafeFiles.length === 0 && plan.ignoredFiles.length === 0) {
    return '没有需要回退的文件改动。';
  }
  const lines: string[] = [];
  lines.push(plan.canApply ? `可回退 ${plan.safeFiles.length} 个文件。` : '回退被阻断，未做任何改动。');
  for (const file of plan.safeFiles) {
    const verb = file.action === 'delete' ? '删除（该文件在检查点时还不存在）' : '还原到检查点时的内容';
    lines.push(`- ${file.path}：${verb}`);
  }
  for (const file of plan.unsafeFiles) {
    lines.push(`- ${file.path}：被阻断（${file.reason}）${file.message ? ` ${file.message}` : ''}`);
  }
  for (const file of plan.ignoredFiles) {
    lines.push(`- ${file.path}：未追踪（${file.reason}），不会还原`);
  }
  return lines.join('\n');
}

function toSafeFile(entry: SafeAggregate): FileRewindSafeFile {
  return {
    path: entry.path,
    action: entry.action,
    operationCount: entry.operationCount,
    toolNames: [...entry.toolNames].sort(),
  };
}

function toUnsafeFile(entry: UnsafeAggregate): FileRewindUnsafeFile {
  return {
    path: entry.path,
    reason: entry.reason,
    operationCount: entry.operationCount,
    toolNames: [...entry.toolNames].sort(),
    ...(entry.message ? { message: entry.message } : {}),
    ...(entry.currentSha256 ? { currentSha256: entry.currentSha256 } : {}),
    ...(entry.expectedSha256 ? { expectedSha256: entry.expectedSha256 } : {}),
  };
}

function toIgnoredFile(entry: Aggregate): FileRewindIgnoredFile {
  return {
    path: entry.path,
    reason: 'shell_ignored',
    operationCount: entry.operationCount,
    toolNames: [...entry.toolNames].sort(),
  };
}

function byPath(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path);
}
