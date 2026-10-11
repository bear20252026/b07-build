import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkspaceIndex,
  projectMapContextText,
  readWorkspaceProjectMap,
  searchResultText,
  searchWorkspaceFiles,
  workspaceIndexErrorText,
  type WorkspaceProjectMap,
} from '../src/runtime/workspace-index';

// 直接桩掉 Tauri 桥接：索引命令的调用形态（参数名、必填性）本身就是契约的一部分。
const invokeCalls: { readonly cmd: string; readonly args: Record<string, unknown> }[] = [];
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'workspace_build_index') return { rootLabel: 'C:\\repo', fileCount: 120, directoryCount: 30, entryCount: 150, truncated: false, ignoreRulesActive: true, builtAtMs: 1, reusedCache: false, durationMs: 12 };
      if (cmd === 'workspace_project_map') return { text: 'dir  src/\nfile src/app.ts (1.0 KB)', fileCount: 120, directoryCount: 30, truncated: false, truncatedIndex: false, ignoreRulesActive: true };
      if (cmd === 'workspace_search_files') return { query: String(args.query ?? ''), hits: [], scanned: 120, truncatedIndex: false };
      throw new Error(`unexpected command: ${cmd}`);
    },
  },
};

test('建立索引默认不强制重扫，只有显式 force 才重扫', async () => {
  invokeCalls.length = 0;
  await buildWorkspaceIndex();
  assert.deepEqual(invokeCalls[0]?.args, { force: false });
  await buildWorkspaceIndex(true);
  assert.deepEqual(invokeCalls[1]?.args, { force: true });
});

test('搜索把 limit 透传，不传则不发该字段', async () => {
  invokeCalls.length = 0;
  await searchWorkspaceFiles('app');
  assert.deepEqual(invokeCalls[0]?.args, { query: 'app' });
  await searchWorkspaceFiles('app', 5);
  assert.deepEqual(invokeCalls[1]?.args, { query: 'app', limit: 5 });
});

test('项目地图被包成有边界的引用块，不与用户正文混淆', async () => {
  invokeCalls.length = 0;
  const map = await readWorkspaceProjectMap();
  const text = projectMapContextText(map);
  assert.match(text, /--- 当前工作区的项目地图/);
  assert.match(text, /--- 项目地图结束 ---/);
  // 地图本身不含文件内容，只能出现路径与体积。
  assert.match(text, /src\/app\.ts/);
  assert.equal(/fn main|console\.log/.test(text), false);
});

test('地图被预算截断时必须如实说明还有目录没列出', () => {
  const map: WorkspaceProjectMap = { text: 'dir  src/', fileCount: 900, directoryCount: 50, truncated: true, truncatedIndex: false, ignoreRulesActive: true };
  assert.match(projectMapContextText(map), /还有目录没有列出/);
  const complete: WorkspaceProjectMap = { ...map, truncated: false };
  assert.equal(/还有目录没有列出/.test(projectMapContextText(complete)), false);
});

test('空地图不注入上下文，避免给模型一段无意义的空块', () => {
  const map: WorkspaceProjectMap = { text: '   ', fileCount: 0, directoryCount: 0, truncated: false, truncatedIndex: false, ignoreRulesActive: false };
  assert.equal(projectMapContextText(map), '');
});

test('搜索命中渲染成可直接引用的清单', () => {
  const text = searchResultText({
    query: 'app',
    hits: [
      { path: 'src/app.ts', name: 'app.ts', kind: 'file', byteSize: 2048, score: 800 },
      { path: 'apps', name: 'apps', kind: 'directory', byteSize: 0, score: 600 },
    ],
    scanned: 120,
    truncatedIndex: false,
  });
  assert.match(text, /命中 2 条 \/ 扫描 120 条/);
  assert.match(text, /1\. src\/app\.ts（文件，2\.0 KB）/);
  assert.match(text, /2\. apps\/（目录）/);
});

test('索引被截断时命中清单要说明“未命中不等于不存在”', () => {
  const text = searchResultText({ query: 'app', hits: [{ path: 'src/app.ts', name: 'app.ts', kind: 'file', byteSize: 1, score: 800 }], scanned: 120, truncatedIndex: true });
  assert.match(text, /未命中不代表文件不存在/);
});

test('没有命中时给出可操作的下一步，而不是让模型凭空编路径', () => {
  const text = searchResultText({ query: 'nope', hits: [], scanned: 120, truncatedIndex: false });
  assert.match(text, /没有找到/);
  assert.match(text, /workspace_list_files/);
  assert.equal(/命中/.test(text), false);
});

test('空格查询不被当成有效搜索', () => {
  assert.match(searchResultText({ query: '   ', hits: [], scanned: 0, truncatedIndex: false }), /缺少 query/);
});

test('索引错误翻译成可执行的提示，绝不假装看到了项目内容', () => {
  assert.match(workspaceIndexErrorText('workspace-root-not-selected'), /选择工作区文件夹/);
  assert.match(workspaceIndexErrorText({ message: 'workspace-root-unavailable' }), /不可访问/);
  assert.match(workspaceIndexErrorText('brand-new-code'), /不要假装看到了项目内容/);
  assert.equal(/成功|已完成/.test(workspaceIndexErrorText('workspace-root-not-selected')), false);
});
