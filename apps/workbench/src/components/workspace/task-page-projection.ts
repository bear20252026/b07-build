import type { WorkbenchTaskSnapshot } from '../../runtime/task-client';

export type TaskPageBlockId = 'intent' | 'plan' | 'approval' | 'execution' | 'evidence' | 'files' | 'delivery' | 'closeout';

export interface TaskPageBlock {
  id: TaskPageBlockId;
  label: string;
  title: string;
  description: string;
  tone: 'neutral' | 'active' | 'warning' | 'success' | 'danger';
}

export interface TaskPageProjection {
  heading: string;
  description: string;
  blocks: readonly TaskPageBlock[];
}

/**
 * P22 任务页的纯只读投影。
 *
 * 该模块只消费已经水合的 task/run metadata；它不生成任务、不可恢复运行、不可批准节点，
 * 也不泄露 task/run 标识、文件内容、哈希或任何 Provider/凭据字段。
 */
export function createTaskPageProjection(input: {
  snapshot: WorkbenchTaskSnapshot;
  activeGoal: string | undefined;
  eventCount: number;
  taskFileCount: number;
  deliveryCount: number;
  evidenceCount: number;
}): TaskPageProjection {
  const status = input.snapshot.status;
  const blockedCount = input.snapshot.stats?.blockedNodes ?? Object.values(input.snapshot.nodeOutcomes).filter((outcome) => outcome === 'blocked').length;
  const failedCount = input.snapshot.stats?.failedNodes ?? Object.values(input.snapshot.nodeOutcomes).filter((outcome) => outcome === 'failed').length;
  const completedCount = input.snapshot.stats?.completedNodes ?? Object.values(input.snapshot.nodeOutcomes).filter((outcome) => outcome === 'ok').length;
  const totalNodes = input.snapshot.stats?.totalNodes ?? Object.keys(input.snapshot.nodeOutcomes).length;

  return {
    heading: input.activeGoal?.trim() || '当前受控任务',
    description: `第 ${input.snapshot.attempt} 次运行尝试；该页面只汇集当前 task/run 的脱敏上下文。`,
    blocks: [
      {
        id: 'intent',
        label: 'INTENT',
        title: '任务目标',
        description: input.activeGoal?.trim() ? '用户已明确提交该目标；后续操作仍遵循当前权限模式与审批。' : '任务目标由本机任务账本保存；此页不重新提交或扩展目标。',
        tone: 'neutral',
      },
      {
        id: 'plan',
        label: 'PLAN',
        title: totalNodes ? `${totalNodes} 个受控执行节点` : '等待受控计划节点',
        description: totalNodes ? '计划节点由本机运行时记录；任务页不新增节点或扩大执行范围。' : '计划生成后会以只读摘要显示在此处。',
        tone: totalNodes ? 'neutral' : 'active',
      },
      {
        id: 'approval',
        label: 'APPROVAL',
        title: blockedCount > 0 ? `${blockedCount} 个待人工确认步骤` : '当前无待确认步骤',
        description: blockedCount > 0 ? '只有用户明确批准后，现有受控运行才可继续。' : '权限与审批仍以 task/run 账本为准。',
        tone: blockedCount > 0 ? 'warning' : 'neutral',
      },
      {
        id: 'execution',
        label: 'EXECUTION',
        title: status === 'completed' ? '运行已完成' : status === 'failed' ? '运行需恢复' : status === 'blocked' ? '运行等待审批' : '运行状态受控',
        description: totalNodes > 0 ? `${completedCount}/${totalNodes} 个节点完成${failedCount ? `，${failedCount} 个失败` : ''}${blockedCount ? `，${blockedCount} 个等待确认` : ''}。` : '本机运行账本尚未记录可展示的节点。',
        tone: status === 'completed' ? 'success' : status === 'failed' ? 'danger' : status === 'blocked' ? 'warning' : 'active',
      },
      {
        id: 'evidence',
        label: 'EVIDENCE',
        title: input.evidenceCount ? `${input.evidenceCount} 条可审查运行证据` : '尚无运行证据',
        description: input.evidenceCount ? '证据引用只描述受控产物，不暴露文件正文、绝对路径或凭据。' : `${input.eventCount} 条只读活动事件可供审查；事件不代表可重放的副作用。`,
        tone: input.evidenceCount ? 'success' : 'neutral',
      },
      {
        id: 'files',
        label: 'FILES',
        title: input.taskFileCount ? `${input.taskFileCount} 个受控文件` : '尚无受控文件',
        description: '文件正文、代码和版本差异仅在 Inspector 中按需打开。',
        tone: input.taskFileCount ? 'success' : 'neutral',
      },
      {
        id: 'delivery',
        label: 'DELIVERY',
        title: input.deliveryCount ? `${input.deliveryCount} 个 ZIP 交付收据` : '尚未创建 ZIP 交付收据',
        description: 'ZIP 必须由用户明确创建，并且不自动下载、解压或运行。',
        tone: input.deliveryCount ? 'success' : 'neutral',
      },
      {
        id: 'closeout',
        label: 'CLOSEOUT',
        title: status === 'completed' && !blockedCount ? '可继续人工收尾审查' : '尚未满足收尾条件',
        description: '收尾条件由任务状态、审批、文件、交付与证据共同决定，绝不自动交付。',
        tone: status === 'completed' && !blockedCount ? 'success' : 'warning',
      },
    ],
  };
}
