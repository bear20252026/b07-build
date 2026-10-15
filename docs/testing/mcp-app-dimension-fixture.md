# MCP Apps 分维夹具（P2-4）

上游 ZCode 的 `packages/desktop/scripts/mcp-apps-host-fixture/`（Apache-2.0）把 MCP Apps 的验收
拆成 **retention / storage / sampling** 三个维度，各自驱动、各自产出 `*-results.json`。
b07 是 Tauri + WebView2，**没有 Electron 驱动**（真实 `BrowserWindow` + `webview` + `preload` +
`executeJavaScript`），故本批次不照搬驱动器，只移植「分维」这件事与每个维度的**不变式本身**，
落成两份可运行的东西：

1. **纯逻辑分维检查**（进 CI，`npm test`）：跑在 b07 现有的宿主模块上，不依赖浏览器/Electron；
2. **host fixture**（人工验收）：真实 WebView2 里逐维运行、逐项输出通过/失败。

两个形态共用同一份维度定义（`apps/workbench/src/runtime/zcode/fixture/`），不会各自漂移。

## 三个维度各自的不变式

| 维度 | 不变式（一句话） | 落到的 b07 模块 | 定义文件 |
| --- | --- | --- | --- |
| retention | 页面连续不可见满宽限期才回收；有在途工具/资源流（忙碌）时即使宽限到期也不回收，忙碌结束后的空闲确认立即回收；活页/任务容量超限时只淘汰「最久未用且可安全回收」的候选，无安全候选则拒绝（绝不静默超发）；引用非零期间不回收 | `PluginPageManager`、`PluginPageRegistry` | `fixture/retention-dimension.ts` |
| storage | 同一 app 身份跨（重）挂载得到**同一来源**（instanceId 只进路径，存储按来源键控故保持）；不同 app / 不同 server / 不同 workspace 身份得到**互不相同的来源**（隔离）；沙箱不给 `allow-same-origin`，应用停留在不透明源 | `mcp-app-origin.ts`、`mcp-app-document-client.ts`、`@awo/protocol` 的 `buildMcpAppSandbox` | `fixture/storage-dimension.ts` |
| sampling | 宿主代表不可信应用发起的请求必须：在白名单内、被新鲜的一次性用户手势背书、经风险分级与人工裁决（low 免批）、受并发上限与超时约束、按**代际**绑定（重挂载后迟到结果丢弃）；白名单外工具名/方法、无手势、未裁决/裁决拒绝、未声明参数键、带 id 的通知、非 JSON-RPC、超限载荷、卸载后调用一律拒绝 | `McpAppMountController`、`McpAppToolGateway`、`McpAppInstanceLease`、`@awo/protocol` 的 `parseMcpAppBridgeMessage` | `fixture/sampling-dimension.ts` |

> **sampling 是部分覆盖**：b07 尚无采样路径（`mcp-client-session.ts` 明确「sampling 不在本批」），
> 故本维度覆盖的是同一类缝——「宿主/服务端代表不可信应用发起请求」的准入与代际绑定，
> 真实模型采样（HTTP 到 provider、模型冻结、不写入主对话）在 b07 无对应实现，未做。

## 跑法一：纯逻辑分维检查（CI）

三个维度各一个测试文件，**可分别运行、分别报告**；`npm test` 会全量执行：

```bash
npm test                                   # 全量（含 architecture:check）

# 只跑某一个维度（逐项报告）：
node --experimental-sqlite --import tsx --test --test-concurrency=1 \
  apps/workbench/test/mcp-app-retention-fixture.test.ts
node --experimental-sqlite --import tsx --test --test-concurrency=1 \
  apps/workbench/test/mcp-app-storage-fixture.test.ts
node --experimental-sqlite --import tsx --test --test-concurrency=1 \
  apps/workbench/test/mcp-app-sampling-fixture.test.ts
```

每个文件把维度里的每条检查映射成一个 `node:test` 用例，并额外打印一行分维汇总
（`[retention] PASS/FAIL <检查名> :: <失败原因>`）。

## 跑法二：host fixture（真实 WebView2，人工验收）

夹具页面是工作台 vite 应用的一个**附加 HTML 入口**（`apps/workbench/mcp-app-fixture.html`），
只在 dev server 提供，**不进入生产包**（`vite build` 的默认入口仍是 `index.html`）。

```bash
# 1) 起工作台开发服务器
npm run dev --workspace=@awo/workbench

# 2) 用真实 WebView2 打开夹具页面（Tauri 应用内 WebView2，或系统 Edge/WebView2 均可）：
#    http://localhost:5173/mcp-app-fixture.html
```

页面上：

- 顶部「全部运行」一次跑三个维度；
- 每个维度一块，各有一个「运行本维度」按钮——**分维运行、分维报告**；
- 逐项显示 ✓/✗，失败项附原因；控制台同步打印 `[<维度>] PASS/FAIL <检查名>`；
- 也可在 DevTools 里脚本驱动：`await window.mcpAppFixture.run('storage')` 返回该维度的报告对象。

### 降级说明

上游用 Electron 真实驱动 64 个 webview guest、30 个任务与假时钟推进，验证的是「真实宿主对象」
的回收。b07 的 host fixture **不做跨进程 guest 驱动**，只把同一份维度定义搬进浏览器上下文运行：
在 WebView2 里验证的是纯逻辑不变式（`PluginPageManager` 等本就是渲染层纯逻辑），
真实 iframe 挂载/回收的端到端行为仍由 `McpAppHost.tsx` + `McpAppPageHost.tsx` 的既有测试与
手工回归覆盖。storage 维度在浏览器里额外可目视确认来源（iframe 的 `location.origin`），
但 b07 无持久化 partition，**跨重启的存储保持未做**（见 `mcp-app-origin.ts` 文件头）。
