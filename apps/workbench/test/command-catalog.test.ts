import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchCommandCatalog } from '../src/components/layout/command-catalog.js';
import { projectWorkbenchCommands } from '../src/components/layout/command-projection.js';

test('无当前任务时，命令目录只提供本地聊天、编辑器与设置导航', () => {
  const commands = createWorkbenchCommandCatalog({ hasActiveTask: false });

  assert.equal(commands.some((command) => command.id === 'navigate-current-task'), false);
  assert.equal(commands.some((command) => command.id === 'focus-task-inspector'), false);
  assert.deepEqual(new Set(commands.map((command) => command.action.kind)), new Set(['navigate', 'focus-task-composer']));
});

test('当前任务存在时，命令目录才显式添加任务页和 Inspector 聚焦动作', () => {
  const commands = createWorkbenchCommandCatalog({ hasActiveTask: true });
  const taskPage = commands.find((command) => command.id === 'navigate-current-task');
  const inspector = commands.find((command) => command.id === 'focus-task-inspector');

  assert.deepEqual(taskPage?.action, { kind: 'navigate', page: 'task' });
  assert.deepEqual(inspector?.action, { kind: 'focus-task-inspector' });
});

test('命令投影可按中英文关键字检索并保持导航、任务、设置三组稳定顺序', () => {
  const commands = createWorkbenchCommandCatalog({ hasActiveTask: true });

  assert.deepEqual(projectWorkbenchCommands(commands, '模型').map((group) => [group.group, group.commands.map((command) => command.id)]), [['settings', ['navigate-models', 'navigate-connections', 'navigate-capabilities']]]);
  assert.deepEqual(projectWorkbenchCommands(commands, 'task').map((group) => group.group), ['task']);
  assert.equal(projectWorkbenchCommands(commands, '不存在的命令').length, 0);
});
