import type { WorkbenchTaskSnapshot } from '../../runtime/task-client';

export type TaskPageBlockId = 'intent' | 'execution' | 'review' | 'outcomes';

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
        id: 'execution',
        label: 'EXECUTION',
        title: status === 'completed' ? '运行已完成' : status === 'failed' ? '运行需恢复' : status === 'blocked' ? '运行等待审批' : '运行状态受控',
        description: totalNodes > 0 ? `${completedCount}/${totalNodes} 个节点完成${failedCount ? `，${failedCount} 个失败` : ''}${blockedCount ? `，${blockedCount} 个等待确认` : ''}。` : '本机运行账本尚未记录可展示的节点。',
        tone: status === 'completed' ? 'success' : status === 'failed' ? 'danger' : status === 'blocked' ? 'warning' : 'active',
      },
      {
        id: 'review',
        label: 'REVIEW',
        title: blockedCount > 0 ? '存在待确认步骤' : '活动与恢复记录',
        description: blockedCount > 0 ? '高风险或受控步骤仍需要人工审批；该块不会代替审批。' : `${input.eventCount} 条只读活动事件可供审查；事件不代表可重放的副作用。`,
        tone: blockedCount > 0 ? 'warning' : 'neutral',
      },
      {
        id: 'outcomes',
        label: 'OUTCOMES',
        title: input.taskFileCount ? `${input.taskFileCount} 个受控文件` : '尚无受控文件',
        description: input.deliveryCount ? `${input.deliveryCount} 个 ZIP 交付收据可在检查器审查。` : '文件产生后，可在检查器逐项审查并由用户明确创建 ZIP。',
        tone: input.taskFileCount ? 'success' : 'neutral',
      },
    ],
  };
}
