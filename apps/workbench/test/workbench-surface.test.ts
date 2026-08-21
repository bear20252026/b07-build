import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkbenchSurface } from '../src/components/layout/workbench-surface.js';

test('无 task/run 或任务成果时，工作区解析为轻量聊天首页', () => {
  assert.equal(resolveWorkbenchSurface({ activePage: 'workspace', hasTaskSnapshot: false, taskFileCount: 0, deliveryCount: 0 }), 'chat-home');
});

test('仅当已有受控 task/run 或 task/run 成果时，工作区才展开任务与 Inspector 布局', () => {
  assert.equal(resolveWorkbenchSurface({ activePage: 'workspace', hasTaskSnapshot: true, taskFileCount: 0, deliveryCount: 0 }), 'task-workbench');
  assert.equal(resolveWorkbenchSurface({ activePage: 'workspace', hasTaskSnapshot: false, taskFileCount: 1, deliveryCount: 0 }), 'task-workbench');
  assert.equal(resolveWorkbenchSurface({ activePage: 'workspace', hasTaskSnapshot: false, taskFileCount: 0, deliveryCount: 1 }), 'task-workbench');
});

test('每个复杂管理页都保持为显式设置态，不受任务或文件计数影响', () => {
  for (const activePage of ['models', 'connections', 'operations', 'capabilities', 'security'] as const) {
    assert.equal(resolveWorkbenchSurface({ activePage, hasTaskSnapshot: true, taskFileCount: 4, deliveryCount: 2 }), 'settings');
  }
});
