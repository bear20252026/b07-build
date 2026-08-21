import type { AgentProfileId } from '@awo/protocol';
import type { WorkbenchAuthorityMode, WorkbenchTaskSnapshot } from '../../runtime/task-client';

export interface TaskTemplate { id: string; title: string; goal: string; profileId: AgentProfileId; authorityMode: WorkbenchAuthorityMode; }
export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  { id: 'implementation', title: '代码实现', goal: '为当前项目制定可恢复的实现计划，并标记需要人工确认的高风险步骤。', profileId: 'build', authorityMode: 'review' },
  { id: 'research', title: '研究报告', goal: '分析当前需求，整理事实、假设、引用与需要人工确认的结论。', profileId: 'reader', authorityMode: 'plan' },
  { id: 'delivery', title: '交付复核', goal: '梳理当前任务的受控文件与交付条件，列出需要在 Inspector 中复核的项目。', profileId: 'plan', authorityMode: 'review' },
];

/** P27 只读收尾状态；不将“有文件”或“有 ZIP”误报成可安全交付。 */
export function createTaskCloseoutProjection(input: { snapshot: WorkbenchTaskSnapshot; fileCount: number; deliveryCount: number; citationCount: number }): { ready: boolean; summary: string; checks: readonly { id: string; done: boolean; label: string }[] } {
  const blocked = Object.values(input.snapshot.nodeOutcomes).some((outcome) => outcome === 'blocked');
  const checks = [
    { id: 'terminal', done: input.snapshot.status === 'completed', label: '任务已完成' },
    { id: 'approval', done: !blocked, label: '不存在待审批步骤' },
    { id: 'files', done: input.fileCount > 0, label: '已产生受控文件' },
    { id: 'delivery', done: input.deliveryCount > 0, label: '已创建 ZIP 交付收据' },
    { id: 'citations', done: input.citationCount > 0, label: '存在可审查引用' },
  ] as const;
  const ready = checks.every((check) => check.done);
  return { ready, summary: ready ? '可在 Inspector 逐项审查后手动交付。' : '尚未满足全部收尾条件；请在 Inspector 中继续审查，系统不会自动交付。', checks };
}
