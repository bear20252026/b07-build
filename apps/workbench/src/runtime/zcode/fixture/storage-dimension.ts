// 一个文件=一种作用：storage 维度不变式夹具（同一 app 跨重挂载保持 / 不同身份隔离）。
//
// 上游出处：ZCode `packages/desktop/scripts/mcp-apps-host-fixture/storage-checks.ts`、
// `managed-checks.ts`、`chain-main.ts`（Apache-2.0）。上游用 Electron 持久化 partition
// `persist:plugin-sandbox-v2-<sha256(appIdentity)>` 让每个插件沙箱拿到稳定且持久的 origin，
// 并用 `window.storageRoundTrip(true/false)` 真实读写 localStorage + IndexedDB 断言
// 「跨重挂载保持」「跨身份隔离」。
//
// b07 没有 Electron partition（见 mcp-app-origin.ts 文件头），但**来源派生**这条不变式
// 在 b07 是真实存在的：`mcpapp://<由 appIdentity 派生的 host>/<instanceId>/index.html`。
// 存储按 origin（scheme + host）键控，故：
//   - 同一 app 身份 → 同一 host → 同一 origin → 跨重挂载保持；
//   - 不同 app / 不同 server / 不同 workspace 身份 → 不同 host → 不同 origin → 隔离。
// 本维度把这些不变式写成不依赖浏览器/Electron 的断言；真实 WebView2 里是否真持久化由
// 宿主夹具（mcp-app-fixture.html）在浏览器上下文另行目视确认。
//
// 读清楚的不变式（逐条来自上游源码）：
// 1. 同一 app 身份跨（重）挂载来源恒定：instanceId 只进路径，不进 origin。
// 2. 不同 app 身份来源互不相同（隔离）。
// 3. 每改变一个身份维度（server / workspace）都必须得到新来源（上游 chain「同一 surface
//    在不同 server/workspace 身份下隔离浏览器存储」）。
// 4. partition 命名只认本方案前缀，他方 partition 不误伤。
// 5. 孤儿识别：只清理无活跃 app 的本方案 partition。
// 6. 文档 URL 形态按平台分流，per-app 来源区别于旧的共享 localhost 来源。
// 7. 沙箱属性不得给 allow-same-origin——应用停留在不透明源，读不到宿主存储。

import { buildMcpAppSandbox, validateMcpAppManifest } from '@awo/protocol';
import {
  MCP_APP_SANDBOX_PARTITION_PREFIX,
  deriveMcpAppSandboxLabel,
  deriveMcpAppSandboxPartition,
  findOrphanMcpAppSandboxPartitions,
  isMcpAppSandboxPartition,
} from '../mcp-app-origin';
import { mcpAppDocumentUrl, mcpAppDocumentUrlForApp } from '../mcp-app-document-client';
import {
  expect,
  expectDeepEqual,
  expectEqual,
  type McpAppFixtureCheck,
  type McpAppFixtureDimension,
} from './dimension-report';

/**
 * 取 URL 的来源串。`mcpapp://` 是非特殊 scheme，`new URL(...).origin` 会返回 "null"，
 * 故统一用 `protocol + host` 表达来源（对 http/https 与自定义协议都成立）。
 */
function documentOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/** 一个身份示例：由 server / workspace / app 三段拼成（对齐上游「appIdentity 来自可信来源」）。 */
function appIdentity(workspace: string, server: string, app: string): string {
  return `${workspace}#${server}#${app}`;
}

const checks: readonly McpAppFixtureCheck[] = [
  {
    name: '同一 app 身份跨重挂载来源恒定（instanceId 只进路径，存储按来源键控故保持）',
    run: () => {
      const identity = appIdentity('workspace:/w', 'server:fixture', 'app:mcpapp-demo-notes');
      const firstMount = documentOrigin(mcpAppDocumentUrlForApp('inst-1', identity, true));
      const secondMount = documentOrigin(mcpAppDocumentUrlForApp('inst-2', identity, true));
      expectEqual(firstMount, secondMount, '两次挂载（不同 instanceId）必须共用同一来源');
      expectEqual(
        deriveMcpAppSandboxLabel(identity),
        deriveMcpAppSandboxLabel(identity),
        '标签派生必须幂等',
      );
      expectEqual(
        new URL(mcpAppDocumentUrlForApp('inst-2', identity, true)).pathname,
        '/inst-2/index.html',
        'instanceId 仍在路径上，路由语义不变',
      );
    },
  },
  {
    name: '不同 app 身份来源互不相同（隔离）',
    run: () => {
      const identities = [
        appIdentity('workspace:/w', 'server:fixture', 'app:a'),
        appIdentity('workspace:/w', 'server:fixture', 'app:b'),
        appIdentity('workspace:/w', 'server:other', 'app:a'),
        appIdentity('workspace:/w2', 'server:fixture', 'app:a'),
      ];
      const origins = identities.map((identity) => documentOrigin(mcpAppDocumentUrlForApp('inst', identity, true)));
      expectEqual(new Set(origins).size, identities.length, '不同身份必须得到互不相同的来源');
    },
  },
  {
    name: '每改变一个身份维度（server / workspace）都必须得到新来源',
    run: () => {
      // 上游 chain：连接命令、参数、资源、surface 完全相同，每次只改变一个身份维度。
      const surface = 'same-surface';
      const variants = [
        appIdentity('workspace:/w', 'server:fixture', 'app:demo'),
        appIdentity('workspace:/w-other', 'server:fixture', 'app:demo'),
        appIdentity('workspace:/w', 'server:fixture-other', 'app:demo'),
      ];
      const origins = variants.map((identity) => documentOrigin(mcpAppDocumentUrlForApp(surface, identity, true)));
      expectEqual(new Set(origins).size, variants.length, '只改一个身份维度也必须得到新来源');
    },
  },
  {
    name: 'partition 命名与识别：只认本方案前缀，他方 partition 不误伤',
    run: () => {
      const identity = appIdentity('workspace:/w', 'server:fixture', 'app:demo');
      const partition = deriveMcpAppSandboxPartition(identity);
      expect(
        partition.startsWith(MCP_APP_SANDBOX_PARTITION_PREFIX),
        '派生 partition 必须带本方案前缀',
      );
      expect(isMcpAppSandboxPartition(partition), '派生 partition 必须被本方案识别');
      expect(
        !isMcpAppSandboxPartition('persist:zcode-embedded-browser'),
        '他方 partition 不得被识别为本方案',
      );
    },
  },
  {
    name: '孤儿识别：只清理无活跃 app 的本方案 partition，去重且不误伤他方',
    run: () => {
      const live = deriveMcpAppSandboxPartition('app-live');
      const orphan = deriveMcpAppSandboxPartition('app-gone');
      const result = findOrphanMcpAppSandboxPartitions(
        [orphan, live, 'persist:foreign', orphan],
        ['app-live'],
      );
      expectDeepEqual(result, [orphan], '只清理无活跃 app 的本方案 partition');
      expectDeepEqual(
        findOrphanMcpAppSandboxPartitions([live], ['app-live']),
        [],
        '活跃 app 的 partition 不得被清理',
      );
    },
  },
  {
    name: '文档 URL 形态按平台分流，per-app 来源区别于共享 localhost 来源',
    run: () => {
      const identity = appIdentity('workspace:/w', 'server:fixture', 'app:demo');
      const label = deriveMcpAppSandboxLabel(identity);
      expectEqual(
        mcpAppDocumentUrlForApp('inst-1', identity, false),
        `mcpapp://${label}.localhost/inst-1/index.html`,
        '非 Windows 走自定义协议',
      );
      expectEqual(
        mcpAppDocumentUrlForApp('inst-1', identity, true),
        `http://mcpapp.${label}.localhost/inst-1/index.html`,
        'Windows/WebView2 必须落在 wry 拦截前缀 http://mcpapp. 之内',
      );
      expect(
        documentOrigin(mcpAppDocumentUrlForApp('inst-1', identity, true))
          !== documentOrigin(mcpAppDocumentUrl('inst-1', true)),
        'per-app 来源必须区别于共享 localhost 来源，二者不得互相串存储',
      );
    },
  },
  {
    name: '沙箱属性不得给 allow-same-origin（应用停留在不透明源，读不到宿主存储）',
    run: () => {
      const admission = validateMcpAppManifest(
        {
          schemaVersion: 1,
          id: 'mcpapp-demo-notes',
          serverId: 'demo',
          displayName: '笔记',
          htmlResourceUri: 'ui://demo/notes',
          requestedToolNames: ['read_note'],
        },
        { id: 'demo', declaredTools: [{ name: 'read_note' }] },
      );
      expect(admission.ok, '夹具 manifest 必须通过准入');
      if (!admission.ok) return;
      const sandbox = buildMcpAppSandbox(admission.admission.manifest);
      expect(
        !sandbox.sandboxAttributes.includes('allow-same-origin'),
        '不得给 allow-same-origin（否则应用可读宿主存储）',
      );
      expect(sandbox.sandboxAttributes.includes('allow-scripts'), 'allow-scripts 是运行前提');
      expect(
        !sandbox.sandboxAttributes.includes('allow-popups')
          && !sandbox.sandboxAttributes.includes('allow-top-navigation'),
        '不得给弹窗与顶层导航',
      );
      expect(sandbox.contentSecurityPolicy.includes("default-src 'none'"), '网络默认全禁');
      expect(
        !sandbox.contentSecurityPolicy.includes('connect-src'),
        '未声明 apiOrigins 时不得开 connect-src',
      );
    },
  },
];

/** storage 维度：可被 CI 逐项运行，也可被 WebView2 夹具整段运行。 */
export const STORAGE_DIMENSION: McpAppFixtureDimension = {
  id: 'storage',
  title: 'storage：同一 app 跨重挂载保持 / 不同身份隔离',
  checks,
};
