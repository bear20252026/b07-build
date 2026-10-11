import assert from 'node:assert/strict';
import test from 'node:test';
import { executeWorkspaceTool, parseToolArguments, workspaceToolErrorText, WORKSPACE_TOOLS } from '../src/runtime/workspace-tools';

test('工具声明符合客户端校验规则', () => {
  assert.equal(WORKSPACE_TOOLS.length, 4);
  for (const tool of WORKSPACE_TOOLS) {
    // 客户端 stream() 会按这条规则拒绝工具名。
    assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/, `工具名不合法：${tool.name}`);
    assert.ok(tool.description.trim().length > 0);
    assert.equal(Array.isArray(tool.parameters), false);
    assert.equal(tool.parameters.type, 'object');
  }
  assert.deepEqual(WORKSPACE_TOOLS.map((tool) => tool.name), ['workspace_search_files', 'workspace_list_files', 'workspace_read_file', 'workspace_write_file']);
});

test('写文件必须声明必填参数，避免模型凭空写入', () => {
  const write = WORKSPACE_TOOLS.find((tool) => tool.name === 'workspace_write_file');
  assert.deepEqual(write?.parameters.required, ['path', 'content']);
});

test('搜索工具必须要求 query，否则模型会拿它当“列全部”用', () => {
  const search = WORKSPACE_TOOLS.find((tool) => tool.name === 'workspace_search_files');
  assert.deepEqual(search?.parameters.required, ['query']);
  // 描述里必须明确压过 recursive 列目录，否则模型会退化成铺满上下文的老路子。
  assert.match(search?.description ?? '', /优先/);
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

test('没有审批入口时绝不写入，也不假装成功', async () => {
  const message = await executeWorkspaceTool('workspace_write_file', '{"path":"a.rs","content":"new"}');
  assert.match(message, /需要用户确认/);
  assert.match(message, /未写入任何内容/);
  assert.equal(/已写入/.test(message), false);
});

// 直接桩掉 Tauri 桥接，这样能把「先读原文 → 问人 → 才写」这条真实路径跑完。
const invokeCalls: { readonly cmd: string; readonly args: Record<string, unknown> }[] = [];
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'workspace_read_file') return { path: args.path, content: 'old content', byteSize: 11, truncated: false };
      if (cmd === 'workspace_write_file') return { path: args.path, content: args.content, byteSize: String(args.content).length, truncated: false };
      if (cmd === 'workspace_search_files') {
        const query = String(args.query ?? '');
        return { query, hits: query.includes('app') ? [{ path: 'src/app.ts', name: 'app.ts', kind: 'file', byteSize: 2048, score: 800 }] : [], scanned: 1234, truncatedIndex: false };
      }
      throw new Error(`unexpected command: ${cmd}`);
    },
  },
};

test('用户拒绝时不写入，并如实告知模型', async () => {
  invokeCalls.length = 0;
  const message = await executeWorkspaceTool('workspace_write_file', '{"path":"a.rs","content":"new"}', async () => false);
  assert.match(message, /用户拒绝/);
  assert.match(message, /未修改任何内容/);
  // 必须明确要求模型不要再绕路重试。
  assert.match(message, /不要再换别的方式/);
  assert.equal(invokeCalls.some((call) => call.cmd === 'workspace_write_file'), false, '被拒绝后绝不能真的写');
});

test('用户批准后写入，且先读原文再写', async () => {
  invokeCalls.length = 0;
  const message = await executeWorkspaceTool('workspace_write_file', '{"path":"a.rs","content":"new"}', async (request) => {
    // 审批人必须能看到改动前的原文，否则无法判断该不该放行。
    assert.equal(request.previous, 'old content');
    assert.equal(request.next, 'new');
    return true;
  });
  assert.match(message, /已写入 a\.rs/);
  assert.deepEqual(invokeCalls.map((call) => call.cmd), ['workspace_read_file', 'workspace_write_file']);
});

test('目标内容与原文完全相同时跳过写入，不惊动用户', async () => {
  invokeCalls.length = 0;
  let asked = false;
  const message = await executeWorkspaceTool('workspace_write_file', '{"path":"a.rs","content":"old content"}', async () => { asked = true; return true; });
  assert.match(message, /完全一致/);
  assert.equal(asked, false);
  assert.equal(invokeCalls.some((call) => call.cmd === 'workspace_write_file'), false);
});

test('搜索命中时返回带体积的路径清单，供模型直接引用读取', async () => {
  invokeCalls.length = 0;
  const message = await executeWorkspaceTool('workspace_search_files', '{"query":"app","limit":5}');
  assert.match(message, /命中 1 条/);
  assert.match(message, /src\/app\.ts/);
  assert.match(message, /2\.0 KB/);
  assert.deepEqual(invokeCalls[0]?.args, { query: 'app', limit: 5 });
});

test('搜索无命中时给出下一步而不是让模型瞎猜路径', async () => {
  const message = await executeWorkspaceTool('workspace_search_files', '{"query":"zzz"}');
  assert.match(message, /没有找到/);
  assert.match(message, /workspace_list_files/);
});

test('搜索缺 query 时直接拒绝，不允许它退化成列全部', async () => {
  assert.match(await executeWorkspaceTool('workspace_search_files', '{}'), /缺少 query/);
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
