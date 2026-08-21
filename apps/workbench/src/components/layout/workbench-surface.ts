import type { WorkbenchPage } from './workbench-page';

export type WorkbenchSurface = 'chat-home' | 'project-page' | 'task-page' | 'settings';

export interface ResolveWorkbenchSurfaceInput {
  activePage: WorkbenchPage;
  hasTaskSnapshot: boolean;
}

/**
 * P22 的页面职责判定。
 *
 * 聊天首页始终是轻量任务入口；任务详情必须由显式 `task` 页面意图和已有 task/run 同时决定。
 * 设置由其它显式页面意图唯一决定。该纯函数不读取 Gateway、文件或持久化状态。
 */
export function resolveWorkbenchSurface({ activePage, hasTaskSnapshot }: ResolveWorkbenchSurfaceInput): WorkbenchSurface {
  if (activePage === 'workspace') return 'chat-home';
  if (activePage === 'projects') return 'project-page';
  if (activePage === 'task' && hasTaskSnapshot) return 'task-page';
  return 'settings';
}
