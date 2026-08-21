import type { WorkbenchPage } from './workbench-page';

export type WorkbenchCommandAction =
  | Readonly<{ kind: 'navigate'; page: WorkbenchPage }>
  | Readonly<{ kind: 'focus-task-composer' }>
  | Readonly<{ kind: 'focus-task-inspector' }>;

export interface WorkbenchCommand {
  id: string;
  group: 'navigate' | 'task' | 'settings';
  label: string;
  description: string;
  keywords: readonly string[];
  action: WorkbenchCommandAction;
}

/**
 * P23 仅包含本地导航/焦点意图的命令目录。
 *
 * 命令面板不是自动化入口：这里没有 Shell、文件、Provider、审批、SQLite 或网络动作；父组件
 * 只能将 action 分派到已有的前端导航或焦点回调。
 */
export function createWorkbenchCommandCatalog(input: { hasActiveTask: boolean }): readonly WorkbenchCommand[] {
  const commands: WorkbenchCommand[] = [
    { id: 'navigate-chat', group: 'navigate', label: '返回聊天首页', description: '回到轻量任务输入与建议任务', keywords: ['chat', 'home', 'workspace', '聊天', '首页', '工作区'], action: { kind: 'navigate', page: 'workspace' } },
    { id: 'focus-composer', group: 'task', label: '聚焦任务输入框', description: '只聚焦本地编辑器，不提交任务', keywords: ['new', 'task', 'composer', '输入', '新任务'], action: { kind: 'focus-task-composer' } },
    { id: 'navigate-models', group: 'settings', label: '打开模型连接', description: '进入第三方 API 三步连接设置', keywords: ['models', 'provider', 'api', '模型', '连接'], action: { kind: 'navigate', page: 'models' } },
    { id: 'navigate-connections', group: 'settings', label: '打开已连接模型', description: '查看连接状态和显式测试', keywords: ['connection', 'probe', '已连接', '模型状态'], action: { kind: 'navigate', page: 'connections' } },
    { id: 'navigate-operations', group: 'settings', label: '打开运行记录', description: '查看检查点、产出账本与只读轨迹', keywords: ['run', 'checkpoint', '记录', '运行'], action: { kind: 'navigate', page: 'operations' } },
    { id: 'navigate-capabilities', group: 'settings', label: '打开扩展与能力', description: '查看扩展、本地模型与控制面摘要', keywords: ['extension', 'capabilities', '扩展', '能力'], action: { kind: 'navigate', page: 'capabilities' } },
    { id: 'navigate-security', group: 'settings', label: '打开安全与系统', description: '查看只读安全审计与发布证据', keywords: ['security', 'audit', '安全', '审计'], action: { kind: 'navigate', page: 'security' } },
  ];

  if (input.hasActiveTask) {
    commands.splice(2, 0,
      { id: 'navigate-current-task', group: 'task', label: '打开当前任务页', description: '查看当前 task/run 的类型化工作块', keywords: ['task', 'current', '任务页', '当前任务'], action: { kind: 'navigate', page: 'task' } },
      { id: 'focus-task-inspector', group: 'task', label: '审查当前任务成果', description: '只聚焦右侧检查器，不加载或执行文件', keywords: ['files', 'delivery', 'inspector', '成果', '文件', '交付'], action: { kind: 'focus-task-inspector' } },
    );
  }

  return commands;
}
