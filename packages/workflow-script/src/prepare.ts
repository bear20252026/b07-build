// 运行前必须知道的全部事情，一次问清。
//
// 驱动层（真正派活、跑命令的那一层）在**执行任何效应之前**需要三样东西：
// 脚本能不能过类型检查、它会做哪些有副作用的站点、以及这次运行还剩多少额度。
// 把这三件事拼成一个返回值，是为了让"能不能跑"只有一个判定点 ——
// 分散在调用方各处拼装时，最容易漏掉的恰恰是额度那一项，而它漏掉的后果是
// **效应已经发生之后才发现超限**。

import { createWorkflowProgram, type WorkflowDiagnostic, type WorkflowProgram } from './compile.js';
import { checkCaps, emptyJournal, type WorkflowJournal, type WorkflowRunCaps } from './journal.js';
import { collectSites, type WorkflowSite, type WorkflowSiteDiagnostic } from './sites.js';

/** 运行前的准备结果。 */
export interface PreparedWorkflowRun {
  /** 能否开始执行：类型检查干净、站点收集干净、额度够。 */
  readonly ok: boolean;
  /** 类型检查的程序（站点收集已经用过它）。 */
  readonly program: WorkflowProgram;
  /** 脚本里的效应站点，按源码位置排序。 */
  readonly sites: readonly WorkflowSite[];
  /** 全部诊断：类型检查的在前，站点收集的在后（按各自的自然顺序）。 */
  readonly diagnostics: readonly (WorkflowDiagnostic | WorkflowSiteDiagnostic)[];
}

/**
 * 准备一次运行。
 *
 * `journal` 传**上一轮的**记录。**不传也照样判额度** —— 静态站点数是否超额与历史无关，
 * 而"忘了传 journal 于是完全没闸门"正是最容易漏掉的那条路径（漏掉的后果是效应已经
 * 发生之后才发现超限）。没有历史时按空 journal 算。
 */
export function prepareWorkflowRun(
  source: string,
  options: { readonly journal?: WorkflowJournal; readonly caps?: WorkflowRunCaps } = {},
): PreparedWorkflowRun {
  const program = createWorkflowProgram(source);
  // 类型检查不过就不要往下走了：站点收集在语法/类型错乱时会给出误导性的结果
  // （例如把一个拼错的名字当成"不是效应"，于是它不在确认清单里）。
  if (program.diagnostics.length > 0) {
    return { ok: false, program, sites: [], diagnostics: program.diagnostics };
  }
  const table = collectSites(program);
  const journal = options.journal ?? emptyJournal('（未提供）');
  const capDiagnostics = checkCaps(table.sites, journal, options.caps ?? { maxEffects: 1000 });
  const diagnostics = [...table.diagnostics, ...capDiagnostics];
  return { ok: diagnostics.length === 0, program, sites: table.sites, diagnostics };
}

/**
 * 给用户看的确认清单：这次运行会做哪些**有副作用**的事。
 *
 * 只列效应站点（ask / world-run / world-read），不列 actor：创建一个子代理本身
 * 不改变外部世界，把它列进"会做什么"会让清单变噪音，而噪音会让用户不再细看。
 */
export function describeEffects(sites: readonly WorkflowSite[]): readonly string[] {
  return sites
    .filter((site) => site.kind !== 'actor')
    .map((site) => {
      const kind = site.kind === 'ask' ? '派活' : site.kind === 'world-run' ? '跑命令' : '读工作区';
      return `${kind} ${site.id}（第 ${site.line} 行）：${site.label}`;
    });
}
