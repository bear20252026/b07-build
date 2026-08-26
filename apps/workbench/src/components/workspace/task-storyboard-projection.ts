import type { WorkbenchTaskSnapshot } from '../../runtime/task-client';

export type TaskStoryboardTone = 'neutral' | 'active' | 'attention' | 'complete' | 'danger';

export interface TaskStoryboardBlock {
  id: 'context' | 'execution' | 'review' | 'deliverables';
  eyebrow: string;
  title: string;
  description: string;
  meta: string;
  tone: TaskStoryboardTone;
}

export interface TaskStoryboardProjection {
  heading: string;
  description: string;
  blocks: readonly TaskStoryboardBlock[];
}

export interface CreateTaskStoryboardProjectionInput {
  snapshot: WorkbenchTaskSnapshot | undefined;
  eventCount: number;
  taskFileCount: number;
  deliveryCount: number;
}

function progressMeta(snapshot: WorkbenchTaskSnapshot): string {
  const stats = snapshot.stats;
  if (!stats) return `第 ${snapshot.attempt} 次尝试`;
  return `${stats.completedNodes}/${stats.totalNodes} 个步骤完成`;
}

function executionTone(snapshot: WorkbenchTaskSnapshot): TaskStoryboardTone {
  if (snapshot.status === 'failed') return 'danger';
  if (snapshot.status === 'completed') return 'complete';
  if (snapshot.status === 'blocked') return 'attention';
  return snapshot.status === 'running' ? 'active' : 'neutral';
}

/**
 * P19 的唯一任务故事板投影。
 *
 * 它仅从 Workbench 已持有且经过 本机能力服务 校验的摘要 DTO 中派生文案；不读取文件内容、
 * 不包含 goal、URL、凭据、绝对路径或任何可以改变任务状态的操作。
 */
export function createTaskStoryboardProjection({
  snapshot,
  eventCount,
  taskFileCount,
  deliveryCount,
}: CreateTaskStoryboardProjectionInput): TaskStoryboardProjection {
  if (!snapshot) {
    return {
      heading: '任务故事板',
      description: '提交一个目标后，这里会把受控执行、待确认事项与专属成果组织为可审查的工作块。',
      blocks: [
        {
          id: 'context',
          eyebrow: 'CONTEXT',
          title: '等待任务意图',
          description: '工作台只会在你明确提交目标后创建任务。',
          meta: '未创建任务',
          tone: 'neutral',
        },
        {
          id: 'execution',
          eyebrow: 'EXECUTION',
          title: '尚无运行记录',
          description: '不会在后台自动开始 Agent 运行或调用模型。',
          meta: '0 个活动事件',
          tone: 'neutral',
        },
        {
          id: 'review',
          eyebrow: 'REVIEW',
          title: '没有待处理的决策',
          description: '需要人工确认时，状态会在这里和运行快照中同时显示。',
          meta: '无待审批项',
          tone: 'neutral',
        },
        {
          id: 'deliverables',
          eyebrow: 'DELIVERABLES',
          title: '等待受控产物',
          description: '任务文件和 ZIP 交付包会在右侧检查器中按 task/run 范围审查。',
          meta: '0 个文件 · 0 个交付包',
          tone: 'neutral',
        },
      ],
    };
  }

  const blockedCount = snapshot.stats?.blockedNodes ?? (snapshot.status === 'blocked' ? 1 : 0);
  const failedCount = snapshot.stats?.failedNodes ?? (snapshot.status === 'failed' ? 1 : 0);
  const review = snapshot.status === 'blocked'
    ? {
      title: '等待明确确认',
      description: '该任务暂停在受控边界；请先在运行快照中检查，再决定是否批准或恢复。',
      meta: `${blockedCount} 个步骤被阻止`,
      tone: 'attention' as const,
    }
    : snapshot.status === 'failed'
      ? {
        title: '需要人工复核',
        description: '运行未完成；恢复操作仍必须由操作者在运行快照中明确发起。',
        meta: `${failedCount} 个步骤失败`,
        tone: 'danger' as const,
      }
      : {
        title: '无需额外确认',
        description: '审批和恢复入口只会在受控运行状态需要时显示。',
        meta: snapshot.status === 'completed' ? '已完成审查路径' : '运行持续受控',
        tone: snapshot.status === 'completed' ? 'complete' as const : 'neutral' as const,
      };

  return {
    heading: '任务故事板',
    description: '将本次任务的状态、执行、人工决策和交付结果置于同一阅读顺序；所有内容均来自本机 本机能力服务 已验证的脱敏摘要。',
    blocks: [
      {
        id: 'context',
        eyebrow: 'CONTEXT',
        title: '当前受控任务',
        description: `第 ${snapshot.attempt} 次运行尝试，采用受限权限模式并保留可恢复状态。`,
        meta: snapshot.authorityMode ?? 'review',
        tone: 'neutral',
      },
      {
        id: 'execution',
        eyebrow: 'EXECUTION',
        title: snapshot.status === 'running' ? '正在受控执行' : snapshot.status === 'completed' ? '运行已完成' : snapshot.status === 'failed' ? '运行需要复核' : snapshot.status === 'blocked' ? '运行已暂停' : '等待执行',
        description: '活动时间线保留可解释事件；它不能重放副作用或自行触发下一步。',
        meta: `${progressMeta(snapshot)} · ${eventCount} 个活动事件`,
        tone: executionTone(snapshot),
      },
      {
        id: 'review',
        eyebrow: 'REVIEW',
        title: review.title,
        description: review.description,
        meta: review.meta,
        tone: review.tone,
      },
      {
        id: 'deliverables',
        eyebrow: 'DELIVERABLES',
        title: taskFileCount > 0 ? '已有可审查成果' : '尚未产生任务文件',
        description: taskFileCount > 0 ? '文件、代码、差异与显式 ZIP 交付均在右侧 Inspector 中按需打开。' : '生成文件前不会预建文件系统目录或自动打包空内容。',
        meta: `${taskFileCount} 个文件 · ${deliveryCount} 个交付包`,
        tone: taskFileCount > 0 || deliveryCount > 0 ? 'complete' : 'neutral',
      },
    ],
  };
}
