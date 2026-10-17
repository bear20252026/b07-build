// journal：把效应记下来，使续跑的运行**不重跑**已经做过的事。
//
// ## 为什么这是本模块的正确性核心
//
// 工作流跑的是真实副作用：派给子代理的活、跑出去的命令。中途失败后重跑，如果"已经跑过的
// 命令又跑了一遍"，后果可能不可逆（部署、推送、发消息）。所以"续跑复用记录"不是优化，
// 是正确性要求。
//
// ZCode 的 facade 文档把这条写进了每个 API 的说明里（"its result is recorded: a resumed
// run reuses the recorded result instead of running the command again"）。本模块把那句话
// 变成可执行的判定。
//
// ## 四条不变式（每一条都对应一个静默失败）
//
// 1. **键必须包含"第几次"**。循环里的站点会执行多次（`for (… ) await world.run(…)`），
//    只用站点身份做键会让第二次执行**复用第一次的结果** —— 一条命令跑两次只算一次。
// 2. **attempt 从 1 开始，且只有一个地方负责递增**。0 基与 1 基混用会让续跑找不到记录，
//    于是**重跑**效应。这是最危险的一种：它看起来只是"少了一次复用"。
// 3. **只追加，不覆盖**。续跑时若允许写入同一个键，历史就能被改写 ——
//    而"历史"正是续跑赖以判断的全部依据。
// 4. **上限在**执行前**判**。事后再数已经晚了：效应已经发生。
//
// ## 与 ZCode 的差别
//
// ZCode 的 journal 落在 SQLite 里，并有 amend-resume（改脚本后按站点身份匹配旧工作）。
// b07 这一层只做**纯判定**：什么样的键、能不能复用、能不能追加、超没超上限。
// 落盘是驱动层的事（本包无 IO），amend-resume 未移植（它需要"站点身份跨版本对齐"，
// 而那要求内容寻址的身份，与按种类计数的身份是两套东西）。

import type { WorkflowSite, WorkflowSiteDiagnostic } from './sites.js';

/** journal 的结构版本。换结构必须换版本号，否则旧记录会被按新语义解释。 */
export const WORKFLOW_JOURNAL_SCHEMA_VERSION = 1 as const;

/** 一条已记录的效应结果。 */
export interface WorkflowJournalRecord {
  /** 站点身份（`ask#1` / `world-run#2` …），来自站点表。 */
  readonly siteId: string;
  /** 同一个站点的**第几次**执行，从 1 开始。 */
  readonly attempt: number;
  /** 结果载荷；形状由站点种类决定。 */
  readonly result: unknown;
}

/** 一次运行的 journal。 */
export interface WorkflowJournal {
  readonly schemaVersion: typeof WORKFLOW_JOURNAL_SCHEMA_VERSION;
  /** 本次运行的 id。续跑是同一个 id 的新一次尝试。 */
  readonly runId: string;
  readonly records: readonly WorkflowJournalRecord[];
}

/** 复用判定的结果。 */
export type JournalLookup =
  | { readonly kind: 'recorded'; readonly result: unknown }
  | { readonly kind: 'missing' };

/** 上限声明。 */
export interface WorkflowRunCaps {
  /** 本次运行最多执行多少次效应（含同一站点的重复执行）。 */
  readonly maxEffects: number;
}

/** 超上限的稳定码。 */
export const EFFECT_BUDGET_EXCEEDED_CODE = 'workflow-effect-budget-exceeded' as const;

/** 一个空 journal。 */
export function emptyJournal(runId: string): WorkflowJournal {
  return { schemaVersion: WORKFLOW_JOURNAL_SCHEMA_VERSION, runId, records: [] };
}

/**
 * 一条记录的键。
 *
 * 包含 `attempt` 是**必须**的，见文件头不变式 1。用 `@` 分隔而不是拼接：
 * 站点身份本身含 `#`，拼在一起会让 `ask#1` + `2` 与 `ask#12` + `` 撞键。
 */
export function journalKey(siteId: string, attempt: number): string {
  return `${siteId}@${attempt}`;
}

/** 这条记录合法吗（供读取不可信存储时校验）。 */
export function isValidJournalRecord(value: unknown): value is WorkflowJournalRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<WorkflowJournalRecord>;
  if (typeof record.siteId !== 'string' || !record.siteId.trim()) return false;
  // attempt 必须是**正整数**：0、负数、小数都说明写入方把计数搞错了，
  // 而"计数错了"正是让续跑重跑效应的那条路径。
  return typeof record.attempt === 'number' && Number.isSafeInteger(record.attempt) && record.attempt >= 1;
}

/**
 * 查这条效应是否已经做过。
 *
 * 这是"续跑不重跑"的**唯一判定点**：驱动层每次要执行效应前都问这里，
 * 拿到 `recorded` 就复用、拿到 `missing` 才执行。
 */
export function recordedResult(journal: WorkflowJournal, siteId: string, attempt: number): JournalLookup {
  const record = journal.records.find((item) => item.siteId === siteId && item.attempt === attempt);
  return record ? { kind: 'recorded', result: record.result } : { kind: 'missing' };
}

/**
 * 追加一条记录。**只追加，不覆盖**。
 *
 * 返回 `appended: false` 表示这个键已经存在 —— 调用方应当把它当成**错误**处理
 * （那意味着同一次效应被记录了两遍，而两遍的内容未必相同）。这里不抛，
 * 是为了让调用方决定怎么报告。
 */
export function appendRecord(
  journal: WorkflowJournal,
  siteId: string,
  attempt: number,
  result: unknown,
): { readonly journal: WorkflowJournal; readonly appended: boolean } {
  if (recordedResult(journal, siteId, attempt).kind === 'recorded') {
    return { journal, appended: false };
  }
  return {
    journal: {
      ...journal,
      records: [...journal.records, { siteId, attempt, result }],
    },
    appended: true,
  };
}

/** 每个站点已经记录了几次。用于界面展示"续跑会复用多少"。 */
export function journalSummary(
  journal: WorkflowJournal,
  sites: readonly WorkflowSite[],
): readonly { readonly site: WorkflowSite; readonly attempts: number }[] {
  return sites.map((site) => ({
    site,
    attempts: journal.records.filter((record) => record.siteId === site.id).length,
  }));
}

/**
 * 已经用掉多少次效应额度。
 *
 * 只数**效应站点**的记录：站点表里的 `actor` 是"创建一个子代理"，
 * 它本身不产生外部副作用（真正的活在 ask 上），所以不占额度。
 */
export function usedEffects(journal: WorkflowJournal, sites: readonly WorkflowSite[]): number {
  const effectSiteIds = new Set(
    sites.filter((site) => site.kind !== 'actor').map((site) => site.id),
  );
  return journal.records.filter((record) => effectSiteIds.has(record.siteId)).length;
}

/**
 * 在**开始执行之前**判上限。
 *
 * 事后再数已经晚了 —— 效应已经发生。所以这里只做两件能在运行前做完的事：
 * ① 静态站点数就已经超了额度（脚本里写着 200 个效应，额度是 50）；
 * ② 已经用掉的额度已经到顶（续跑时上一轮就用完了）。
 *
 * 运行中每执行一次效应仍要再判一次（那是驱动层的事，用 `usedEffects` 算差值）。
 */
export function checkCaps(
  sites: readonly WorkflowSite[],
  journal: WorkflowJournal,
  caps: WorkflowRunCaps,
): readonly WorkflowSiteDiagnostic[] {
  if (!Number.isSafeInteger(caps.maxEffects) || caps.maxEffects < 1) {
    return [{ code: EFFECT_BUDGET_EXCEEDED_CODE, message: '效应额度必须是正整数。', line: 1, column: 1 }];
  }
  const effectSites = sites.filter((site) => site.kind !== 'actor');
  if (effectSites.length > caps.maxEffects) {
    return [
      {
        code: EFFECT_BUDGET_EXCEEDED_CODE,
        message: `脚本里有 ${effectSites.length} 个效应站点，超过本次运行的额度 ${caps.maxEffects}；整个运行被拒绝（不是拒绝某一次调用）。`,
        line: effectSites[caps.maxEffects]?.line ?? 1,
        column: effectSites[caps.maxEffects]?.column ?? 1,
      },
    ];
  }
  const used = usedEffects(journal, sites);
  if (used >= caps.maxEffects) {
    return [
      {
        code: EFFECT_BUDGET_EXCEEDED_CODE,
        message: `本次运行的效应额度 ${caps.maxEffects} 已用尽（已执行 ${used} 次）；继续执行会被拒绝。`,
        line: 1,
        column: 1,
      },
    ];
  }
  return [];
}

/** 剩余额度。驱动层每执行一次效应后重新算，用来在运行中把闸门关上。 */
export function remainingEffects(
  journal: WorkflowJournal,
  sites: readonly WorkflowSite[],
  caps: WorkflowRunCaps,
): number {
  return Math.max(0, caps.maxEffects - usedEffects(journal, sites));
}
