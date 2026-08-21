import type { WorkbenchPage } from './workbench-page';

export type WorkbenchSurface = 'chat-home' | 'task-workbench' | 'settings';

export interface ResolveWorkbenchSurfaceInput {
  activePage: WorkbenchPage;
  hasTaskSnapshot: boolean;
  taskFileCount: number;
  deliveryCount: number;
}

/**
 * P20 的页面职责判定。
 *
 * Settings 由显式页面意图唯一决定。聊天页只有在已存在受控 task/run 或 task/run 专属成果时
 * 才扩展为任务工作台并显示 Inspector；这避免无任务首屏预先展示空文件系统或运维面板。
 */
export function resolveWorkbenchSurface({
  activePage,
  hasTaskSnapshot,
  taskFileCount,
  deliveryCount,
}: ResolveWorkbenchSurfaceInput): WorkbenchSurface {
  if (activePage !== 'workspace') return 'settings';
  return hasTaskSnapshot || taskFileCount > 0 || deliveryCount > 0 ? 'task-workbench' : 'chat-home';
}
