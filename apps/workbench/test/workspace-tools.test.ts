import assert from 'node:assert/strict';
import test from 'node:test';
import { executeWorkspaceTool, parseToolArguments, workspaceToolErrorText, WORKSPACE_TOOLS } from '../src/runtime/workspace-tools';

test('工具声明符合客户端校验规则', () => {
  assert.equal(WORKSPACE_TOOLS.length, 3);
  for (const tool of WORKSPACE_TOOLS) {
    // 客户端 stream() 会按这条规则拒绝工具名。
    assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/, `工具名不合法：${tool.name}`);
    assert.ok(tool.description.trim().length > 0);
    assert.equal(Array.isArray(tool.parameters), false);
    assert.equal(tool.parameters.type, 'object');
  }
  assert.deepEqual(WORKSPACE_TOOLS.map((tool) => tool.name), ['workspace_list_files', 'workspace_read_file', 'workspace_write_file']);
});

test('写文件必须声明必填参数，避免模型凭空写入', () => {
  const write = WORKSPACE_TOOLS.find((tool) => tool.name === 'workspace_write_file');
  assert.deepEqual(write?.parameters.required, ['path', 'content']);
});

test('参数解析能接受空串、对象，并拒绝非对象', () => {
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments('{"path":"a.rs"}'), { path: 'a.rs' });
  assert.equal(parseToolArguments('[1,2]'), undefined);
  assert.equal(parseToolArguments('not json'), undefined);
});

test('未知工具与非法参数返回可读错误而不是抛出', async () => {
  assert.match(await executeWorkspaceTool('rm_everything', '{}'), /未知工具/);
  assert.match(await executeWorkspaceTool('workspace_read_file', '{oops'), /参数不是合法 JSON/);
});

test('拒绝写入空内容：清空文件是最容易误伤的操作', async () => {
  const message = await executeWorkspaceTool('workspace_write_file', '{"path":"a.rs","content":""}');
  assert.match(message, /拒绝写入空内容/);
});

test('错误码翻译成可执行的提示，绝不含糊其辞', () => {
  const text = workspaceToolErrorText('workspace-root-not-selected');
  assert.match(text, /工作区/);
  // 最关键的一点：不能让模型以为操作成功了。
  assert.equal(/成功|已完成/.test(text), false);
  assert.match(workspaceToolErrorText('workspace-file-not-found'), /不能凭空创建/);
});

test('未知错误也不伪装成成功', () => {
  assert.match(workspaceToolErrorText('something-new'), /工具执行失败/);
  assert.match(workspaceToolErrorText({ message: 'workspace-path-absolute' }), /相对路径/);
});
