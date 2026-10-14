// 一个文件=一种作用：MCP App 文档来源客户端的验收测试（R4-01）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpAppDocumentUrl, releaseMcpAppDocument, stageMcpAppDocument, type McpAppDocumentDeps } from '../src/runtime/zcode/mcp-app-document-client';

// 客户端有原生运行时守卫；测试环境手动声明 Tauri 桥存在。
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async () => undefined,
  },
};

test('URL 形态按平台分流，instanceId 在路径上（Windows 宿主信息不参与路由）', () => {
  assert.equal(mcpAppDocumentUrl('app-x', false), 'mcpapp://localhost/app-x/index.html');
  assert.equal(mcpAppDocumentUrl('app-x', true), 'http://mcpapp.localhost/app-x/index.html');
});

test('暂存走原生命令并携带 CSP；桥抛错向上传播（宿主回退 srcdoc）', async () => {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const deps: McpAppDocumentDeps = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return undefined;
    },
  };
  await stageMcpAppDocument('app-x', '<html></html>', "default-src 'none'", deps);
  assert.deepEqual(calls, [{ cmd: 'mcpapp_stage_document', args: { instanceId: 'app-x', html: '<html></html>', contentSecurityPolicy: "default-src 'none'" } }]);
  await assert.rejects(
    stageMcpAppDocument('app-x', '<html></html>', "default-src 'none'", {
      invoke: async () => {
        throw new Error('mcpapp-native-unavailable');
      },
    }),
    /mcpapp-native-unavailable/,
  );
});

test('释放：透传原生命令（幂等语义在原生侧），错误向上传播由卸载路径吞掉', async () => {
  let released: string | undefined;
  const deps: McpAppDocumentDeps = {
    invoke: async (cmd, args) => {
      assert.equal(cmd, 'mcpapp_release_document');
      released = String(args.instanceId);
      return undefined;
    },
  };
  await releaseMcpAppDocument('app-x', deps);
  assert.equal(released, 'app-x');
  await assert.rejects(
    releaseMcpAppDocument('app-y', {
      invoke: async () => {
        throw new Error('gone');
      },
    }),
    /gone/,
  );
});
