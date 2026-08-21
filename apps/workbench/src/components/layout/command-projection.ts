import type { WorkbenchCommand } from './command-catalog';

export interface CommandGroupProjection {
  group: WorkbenchCommand['group'];
  label: string;
  commands: readonly WorkbenchCommand[];
}

const GROUP_LABEL: Readonly<Record<WorkbenchCommand['group'], string>> = {
  navigate: '导航',
  task: '当前任务',
  settings: '设置',
};

/** 只对已声明的本地导航命令做大小写不敏感检索；不读取输入之外的状态。 */
export function projectWorkbenchCommands(commands: readonly WorkbenchCommand[], query: string): readonly CommandGroupProjection[] {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = commands.filter((command) => !normalized || [command.label, command.description, ...command.keywords]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));
  const groups: WorkbenchCommand['group'][] = ['navigate', 'task', 'settings'];

  return groups
    .map((group) => ({ group, label: GROUP_LABEL[group], commands: matches.filter((command) => command.group === group) }))
    .filter((group) => group.commands.length > 0);
}
