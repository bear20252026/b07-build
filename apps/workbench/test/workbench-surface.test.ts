import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkbenchSurface } from '../src/components/layout/workbench-surface.js';

test('工作区无论是否保留旧 task/run，始终解析为轻量聊天首页', () => {
  assert.equal(resolveWorkbenchSurface({ activePage: 'workspace', hasTaskSnapshot: false }), 'chat-home');
  assert.equal(resolveWorkbenchSurface({ activePage: 'workspace', hasTaskSnapshot: true }), 'chat-home');
});

test('只有显式任务页且存在受控 task/run 时才显示任务详情', () => {
  assert.equal(resolveWorkbenchSurface({ activePage: 'task', hasTaskSnapshot: false }), 'settings');
  assert.equal(resolveWorkbenchSurface({ activePage: 'task', hasTaskSnapshot: true }), 'task-page');
});

test('复杂管理页保持为显式设置态，不受任务存在与否影响', () => {
  for (const activePage of ['models', 'connections', 'operations', 'capabilities', 'security'] as const) {
    assert.equal(resolveWorkbenchSurface({ activePage, hasTaskSnapshot: false }), 'settings');
    assert.equal(resolveWorkbenchSurface({ activePage, hasTaskSnapshot: true }), 'settings');
  }
});
