// 动态工作流脚本 —— 纯包，无 IO。
//
// 分工（与 ZCode `@zcode/dynamic-workflow` 的边界一致）：
// - `facade`：模型可写面的唯一事实源（嵌入式 `.d.ts`）。
// - `compile`：对着 facade 做类型检查，位置换算回作者坐标。
// - `sites`：把脚本里的效应静态枚举成**稳定身份**的站点表。
// - `journal`：续跑不重跑已做过的效应；额度在执行前判。
// - `prepare`：运行前必须知道的全部事情，一次问清。
//
// 不在这里做的事（也刻意不做）：派活、跑命令、落盘。那是驱动层的事，
// 而驱动层需要真实 IO —— 本包保持纯粹，才能被完整地单测。

export { WORKFLOW_FACADE_DTS, WORKFLOW_FACADE_FILE_NAME } from './facade.js';

export {
  WORKFLOW_FUNCTION_NAME,
  WORKFLOW_SCRIPT_FILE_NAME,
  createWorkflowProgram,
  facadeDiagnostics,
  toAuthorLocation,
  type WorkflowDiagnostic,
  type WorkflowProgram,
} from './compile.js';

export {
  NON_LITERAL_COMMAND_CODE,
  collectSites,
  type WorkflowSite,
  type WorkflowSiteDiagnostic,
  type WorkflowSiteKind,
  type WorkflowSiteTable,
} from './sites.js';

export {
  EFFECT_BUDGET_EXCEEDED_CODE,
  WORKFLOW_JOURNAL_SCHEMA_VERSION,
  appendRecord,
  checkCaps,
  emptyJournal,
  isValidJournalRecord,
  journalKey,
  journalSummary,
  recordedResult,
  remainingEffects,
  usedEffects,
  type JournalLookup,
  type WorkflowJournal,
  type WorkflowJournalRecord,
  type WorkflowRunCaps,
} from './journal.js';

export { describeEffects, prepareWorkflowRun, type PreparedWorkflowRun } from './prepare.js';
