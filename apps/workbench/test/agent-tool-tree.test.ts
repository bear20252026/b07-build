// 一个文件=一种作用：Agent 工具调用层级树的验收测试（移植自 ZCode toolCallTree 语义）。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areAgentToolCallsRenderEqual,
  buildAgentToolCallTree,
  reconcileAgentToolCallTree,
  type AgentToolCall,
} from '../src/runtime/agent-tool-tree';

function call(overrides: Partial<AgentToolCall> & { toolId: string }): AgentToolCall {
  return {
    toolName: 'workspace_read_file',
    title: overrides.toolId,
    status: 'completed',
    ...overrides,
  };
}

test('层级构建：子工具调用按 parentToolUseId 挂到父节点下', () => {
  const tree = buildAgentToolCallTree([
    call({ toolId: 'a', toolName: 'agent_run', title: '子任务' }),
    call({ toolId: 'a1', parentToolUseId: 'a', toolName: 'workspace_read_file', title: '读文件' }),
    call({ toolId: 'a1-1', parentToolUseId: 'a1', toolName: 'workspace_search_files', title: '搜索' }),
    call({ toolId: 'b', toolName: 'workspace_write_file', title: '写文件' }),
  ]);
  assert.equal(tree.length, 2);
  const [a, b] = tree;
  assert.equal(a!.toolCall.toolId, 'a');
  assert.equal(a!.childToolCalls.length, 1);
  assert.equal(a!.childToolCalls[0]!.toolCall.toolId, 'a1');
  assert.equal(a!.childToolCalls[0]!.childToolCalls[0]!.toolCall.toolId, 'a1-1');
  assert.equal(b!.toolCall.toolId, 'b');
  assert.equal(b!.childToolCalls.length, 0);
});

test('孤儿回退：parent id 不存在或指向自己时回退 root，记录不消失', () => {
  const tree = buildAgentToolCallTree([
    call({ toolId: 'orphan', parentToolUseId: 'no-such-parent', title: '孤儿' }),
    call({ toolId: 'self', parentToolUseId: 'self', title: '自指' }),
    call({ toolId: 'real', title: '正常' }),
  ]);
  assert.deepEqual(tree.map((node) => node.toolCall.toolId).sort(), ['orphan', 'real', 'self']);
});

test('环检测（b07 差异点）：父子互相成环时双双回退 root，不再静默消失', () => {
  // 上游行为：a.parent=b、b.parent=a → 各自挂进对方 childToolCalls，root 为空，记录全部丢失。
  const tree = buildAgentToolCallTree([
    call({ toolId: 'a', parentToolUseId: 'b', title: '环A' }),
    call({ toolId: 'b', parentToolUseId: 'a', title: '环B' }),
    call({ toolId: 'c', title: '正常' }),
  ]);
  assert.deepEqual(tree.map((node) => node.toolCall.toolId).sort(), ['a', 'b', 'c']);
});

test('reconcile 引用稳定：语义未变的流式重渲染保留旧 toolCall 与节点引用', () => {
  const first = buildAgentToolCallTree([
    call({ toolId: 'a', title: '任务', input: { path: 'x.ts' } }),
    call({ toolId: 'a1', parentToolUseId: 'a', title: '读文件', status: 'running' }),
  ]);
  const a1Before = first[0]!.childToolCalls[0]!;

  // 流式 chunk：字段内容一致但引用全新（模拟每轮重建的记录数组）。
  const second = reconcileAgentToolCallTree([
    call({ toolId: 'a', title: '任务', input: { path: 'x.ts' } }),
    call({ toolId: 'a1', parentToolUseId: 'a', title: '读文件', status: 'running' }),
  ], first);
  assert.equal(second, first, '整树引用不变');
  assert.equal(second[0]!.childToolCalls[0], a1Before, '子节点引用不变');

  // 语义变化（状态推进）：该节点换新引用，其余保持。
  const third = reconcileAgentToolCallTree([
    call({ toolId: 'a', title: '任务', input: { path: 'x.ts' } }),
    call({ toolId: 'a1', parentToolUseId: 'a', title: '读文件', status: 'completed' }),
  ], second);
  assert.equal(third[0]!.toolCall, second[0]!.toolCall, '未变化的父节点保持旧引用');
  assert.equal(third[0]!.childToolCalls[0]!.toolCall.status, 'completed');
  assert.notEqual(third[0]!.childToolCalls[0], a1Before, '变化的节点换新引用');
});

test('render-equal：深度对象在预算内判等，超预算（500 层）判不等', () => {
  const base = call({ toolId: 'a' });
  const deep = (level: number): unknown => {
    let value: unknown = 'leaf';
    for (let index = 0; index < level; index += 1) {
      value = { nested: value };
    }
    return value;
  };
  const within = { ...base, output: deep(100) };
  assert.equal(areAgentToolCallsRenderEqual(within, { ...within, output: deep(100) }), true);
  assert.equal(areAgentToolCallsRenderEqual(within, { ...within, output: deep(600) }), false);
  assert.equal(areAgentToolCallsRenderEqual(within, { ...within, status: 'failed' }), false);
});
