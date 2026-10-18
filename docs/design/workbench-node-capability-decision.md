# 决策记录：workbench 如何触达 Node 侧能力

- 状态：**待拍板**
- 影响范围：动态工作流执行、插件 `@` 引用注入
- 本文档只记录事实与选项，**不改变任何代码**

---

## 1. 这份文档要解决的那一个问题

b07 现在有**两个互不相通的世界**。所有"功能写好了但用不上"的问题，根因都是这一个。

---

## 2. 实测事实（都可复现，命令附在 §7）

| 事实 | 数值 / 结论 |
| --- | --- |
| `packages/agent-runtime` 规模 | **18,443 行** |
| 它被**应用内**代码 import 的次数 | **0**（只有 `tools/architecture-check.mjs`、`tools/plugin-marketplace-cli.ts` 用它） |
| `apps/workbench/src/runtime` 规模 | **12,374 行** |
| 应用真正的 agent 循环在哪 | `agent-tool-loop.ts` + `use-direct-conversations.ts`（**渲染进程里**） |
| Tauri 是否启动 Node 子进程 | **否**（`tauri.conf.json` 无 `sidecar` / `externalBin`，`lib.rs` 无 `Command::new`） |
| Rust 是否嵌入 JS 引擎 | **否**（Cargo.toml 无 `deno_core` / `boa` / `quickjs` / `rusty_v8`） |
| workbench 的架构策略允许依赖 | `protocol`、`provider-sdk-browser`、`capability-placeholder` |

### 由此得到的两句话

1. **`agent-runtime` 不是"应用的后端"，它是一套只被 CLI 与测试使用的 Node 库。**
   应用运行时根本没有加载它。
2. **应用的 agent 能力（循环、工具、记忆）在渲染进程里另有一套实现。**

也就是说：不是"workbench 被策略禁止依赖 agent-runtime"，而是
**即使允许，它也没法依赖** —— 那 18k 行里有 `node:fs`、SQLite、`child_process`，
渲染进程跑不了。策略只是把这件事显式化了。

## 2.5 为什么会变成这样（历史，git 可查）

这不是一开始就设计成两套。**是删掉中间那一层之后留下来的。**

| 时间 | 提交 | 发生了什么 |
| --- | --- | --- |
| 2026-08-19 | `7fee29b` | 首个提交。同时有 `apps/workbench`（界面）与 `packages/agent-runtime`（Node 运行时），**外加 `apps/runtime-gateway`** —— 一个本地 HTTP 服务，把 agent-runtime 的能力开成 25+ 条 `/api/*` 路由 |
| 2026-08-22 | `93f30f2` | "replace gateway with direct desktop providers"：应用改成直接调桌面 provider，不再绕 gateway |
| **2026-08-26** | **`f2a0d18`** | **"remove gateway runtime and fixed loopback proxy"：整个 `apps/runtime-gateway` 被删，85 个文件、7,012 行** |
| 之后 | — | `agent-runtime` 留着，但它的宿主没了；界面里那些 `/api/*` 客户端也留着，但它们的服务端没了 |

### 删完之后留下的两样东西

**一、`agent-runtime` 成了孤儿。** 它原本是被 gateway 调用的库；gateway 没了，就没人调它了。

**二、一批界面面板被永久禁用。** `App.tsx` 里：

```ts
const [localServiceReady] = useState(false);   // 只取值，不取 setter
```

`localServiceReady` 是**硬编码 false 且没有 setter** —— 永远不可能变成 true。
而 `.tsx` 里引用它的地方有 **73 处**：浏览会话控制、扩展中心、预置角色目录等面板的按钮
全部 `disabled`，请求全部被跳过。它们不是"报错"，是**永远停在"未就绪"状态**。

这是一个"临时禁用"变成"永久禁用"的例子：删 gateway 时把开关关掉是合理的，
但没有任何机制提醒"这个开关再也不会被打开"。

### 对决策的影响

**这直接否掉了选项 C（起 Node sidecar）。**

8 月 26 日删掉 gateway 是一个**有意的决定**（提交标题写着 remove gateway runtime
**and fixed loopback proxy** —— 后者是安全考虑：固定回环端口）。现在为了复用 agent-runtime
再把一个本地 Node 服务加回来，等于把当时有意删掉的东西装回去，连同一个被明确移除的
固定回环端口一起。

所以真正的问题不是"要不要开个门"，而是：**那 1.8 万行还要不要；如果要，应该以什么形态进应用。**

---

### 概念上的两套实现

| 概念 | `agent-runtime` | `workbench/src/runtime` |
| --- | --- | --- |
| 记忆 | 3 个文件 | 2 个文件 |
| 子代理 | 7 个文件 | **0** |
| 插件市场 | 4 个文件 | **0** |
| MCP | 2 个文件 | 0（走 Tauri 命令） |

注意子代理与插件市场是**只在 Node 侧存在**的两块能力 —— 这正好对应下面两件被挡住的事。

---

## 3. 被挡住的两件事

### 3.1 动态工作流**执行**（`packages/workflow-script`）

已交付：facade、类型检查、站点枚举、journal 重放、校验器 CLI。**缺驱动层**：

- 派活（起子代理、发 ask、等结果）
- 跑命令（`world.run`）
- journal 落盘

前两项在应用里没有对应物（workbench 无子代理）；第三项需要持久化。

### 3.2 插件 `@` 引用**注入**（`packages/plugin-reference`）

已交付：严格解析、会话内冻结目录、只含标识符的能力提示。**缺数据源**：

- 已安装插件清单（`InstalledPluginRecord`，在 `agent-runtime`）
- MCP 连接状态（在 `agent-runtime`）

workbench 拿不到这两样，也拿不到"用户消息里有哪些引用"——那需要 `@` picker。

### 3.3 一个反例：为什么文件回退没被挡住

文件回退能用，是因为它的每一步都有 **Tauri 命令**（`workspace_read_file` /
`stage_patch_batch` / `commit_patch`）。它不需要 Node —— 需要的只是 Rust 侧已经有的能力。

**这就是分界线：能落到 Tauri 命令上的，就能用；必须跑 Node 代码的，就用不了。**

---

## 3.5 遗留面清点：`localServiceReady` 到底关掉了什么

`localServiceReady` 是硬编码 `false` 且无 setter 的开关。它的影响面不是"几个面板"，
而是**整个数据层的一半**。下面按传输方式把 `apps/workbench/src/runtime/*-client.ts`
全部归类（共 20 个）。

### 走 HTTP 的（后端 `apps/runtime-gateway` 已删 → **全部不可用**）：7 个

| 客户端 | 撑起的功能 |
| --- | --- |
| `task-client`（**26 处 `fetch`**） | **任务执行**、运行记录、检查点、产出账本、组件锁、控制面诊断 |
| `knowledge-client` | 知识库检索 |
| `knowledge-workspace-client` | 知识工作区 |
| `agency-role-client` | 预置角色目录 |
| `extension-client` | 扩展中心 |
| `api-usage-client` | 用量账本 |
| `mimo-tts-client` | 语音预览（`/api/companion/tts/preview`） |

### 走 Tauri 的（**能用**）：12 个

`desktop-diagnostics`、`direct-provider`、`extension-host`、`external-url`、
`github-collaboration`、`hybrid-search`、`last30days`、`project-memory`、
`searxng-local`、`terminal`、`web-search`、`workspace-file-rewind`

### 纯类型：1 个

`project-client`（只有 interface，没有传输）

---

### 最重的一条：**任务执行整体是禁用的**

```ts
// App.tsx
const [localServiceReady] = useState(false);           // 永远 false
const taskExecution = useTaskExecution(localServiceReady, { … });

// use-task-execution.ts:103
if (!localServiceReady) { /* 直接返回 */ }
```

也就是说：**提交任务 → 运行 → 产出账本 / 检查点 / 交付物** 这条主链路，
在删掉 gateway 之后就没有后端了。这不是"某个面板灰了"，是**产品的主功能之一停摆**。

对话与工具调用走的是另一条路（`use-direct-conversations` + Tauri 命令），所以还能用 ——
这也是为什么"看起来还在工作"：能聊天、能改文件、能开浏览器，但不能"提交一个任务让它跑完"。

---

## 3.6 MCP 连接：缺的那一层已经有了，但还差两个决定

`plugin-reference` 的 reminder 要求"已连接且 provider 可见"，此前应用里没有任何东西
记录这个状态。现在补上了：

| 位置 | 内容 |
| --- | --- |
| `runtime/zcode/mcp-connection-registry.ts` | 连接注册表：连上、记状态、报工具数、能关掉 |
| `McpConnectionRegistry#liveMcpServers()` | 正是 `plugin-reference` 需要的形状（server → 工具数） |

底层件本来就在（`McpClientSession.connect/listTools`、`mcp-stdio-transport` 经 Tauri 起进程、
`McpClientPool` 按租借管理），缺的只是"现在哪些连着"这一层。

### 注册表刻意不做的事

**它不决定 spawn 什么。** 会话由注入的 `createSession(serverId)` 造。起什么进程、带什么参数、
信任不信任 —— 这些是安全决策，不该藏在一个注册表里。

### 还差两个决定（都不是代码问题）

1. **启动规格从哪来。** 插件只声明 `mcpApp.serverId`，没有 `command`/`args`。
   `mcp-servers.sqlite` 里可能有 server 清单 —— 但那意味着"读插件账本就能拿到要执行的命令"。
2. **信任谁。** 用插件声明的命令去 spawn 进程，等于**把"装了别人的插件"升级成"跑了别人的命令"**。
   这和 hook 是同一类风险，应当走同一套信任门（`hook-trust` 那套：来源判定 + 准入过滤），
   而不是让插件市场账本直接变成执行清单。

在这两个决定定下来之前，注册表只能被喂一个"永远返回 undefined"的工厂 ——
所以本批**没有**把它接进界面：接上去只会让每个插件都显示"无法连接（缺少启动规格）"，
那不是信息，是噪音。

---
## 4. 四个选项

| 选项 | 代价 | 解锁 | 风险 |
| --- | --- | --- | --- |
| **A. 加架构边**（workbench → agent-runtime） | 小（改 `architecture-policy.yaml`） | **什么都解锁不了** | 会让 18k 行 Node 代码进渲染进程的 import 图，构建直接失败（`node:fs` 等）。**这不是真选项**，列出来是为了关掉它 |
| **B. 加 Tauri 命令面**（把需要的能力用 Rust 写） | 中～大（重写） | 插件清单 + MCP 状态（小）；子代理 + 命令执行（大） | 18k 行 Node 库继续闲置；与 Rust 侧已有实现可能再次分叉 |
| **C. 起 Node sidecar**（Tauri `externalBin`，Node 子进程 + IPC） | 大（打包 Node 运行时、进程生命周期、IPC 面、本地端口的安全边界） | 全部 —— 18k 行直接可用 | 为了复用一套**应用从未运行过**的库而引入一个新进程；且它与 workbench 已有的 agent 循环是两套实现，会出现"到底哪套在跑"的长期困惑 |
| **D. 承认两套世界，只把 Node 侧做成 CLI/工具** | 极小（已在做） | 作者工具、运维、CI | 应用内**永远拿不到**这两项能力 |

---

## 5. 推荐

**B 为主，D 为辅；不建议 C，除非目标本来就是"用 Node 那套替换掉 workbench 的 agent 循环"。**

理由：

1. **B 与现有架构一致。** 应用里所有真正能用的能力（工作区写入、浏览器工具、文件回退）
   都是 Tauri 命令。再加一条命令面是在延长已有的路，不是开新路。
2. **C 解决的是"复用"，但没人能确认那套值得复用。** 18k 行从未在应用里跑过。
   为一个未验证的库引入 sidecar + IPC + 本地端口，风险与收益倒挂。
   真要复用，应当先回答"要不要用它替换 workbench 现有循环"—— 那是另一个量级的决定。
3. **D 已经在产出价值。** 工作流脚本校验器（`tools/workflow-script-cli.ts`）与
   插件市场 CLI 都是这条路。作者与 CI 能立刻用上，不需要等任何架构决定。

### 按推荐落地的话，顺序是

1. **插件 `@` 引用（B 的小份）**：加一条 `plugin_reference_catalog` 命令，
   返回已安装插件 + MCP 状态。约等于把 `InstalledPluginRecord` 投影成 Rust 结构。
   拿到数据后 `plugin-reference` 立刻可用（它的三段逻辑都已测过）。
2. **`@` picker（纯 UI）**：插入 `[name](plugin://name@marketplace)` 链接。
3. **动态工作流执行（B 的大份）**：需要先有"应用内子代理"这个能力，
   而 workbench 目前**没有**。这一步的实质是"给应用加子代理"，工作流只是它的编排语法。
   建议单独立项，不要与 1、2 混在一起。

---

## 6. 需要你拍的那一个问题

> **`packages/agent-runtime`（18,443 行，应用零引用）的定位是什么？**

- **甲：未来要接进应用的正式后端** → 走 C，但要连带决定"替换 workbench 现有循环"，
  否则会出现两套 agent 循环长期并存。
- **乙：只服务 CLI / 运维 / 测试的工具库** → 走 B + D，应用侧需要什么就用 Rust 重写一份，
  不必追求两套合一。

这个问题的答案决定了后面所有工作。在它明确之前，我不会再往"需要 Node 才能跑"的方向加功能 ——
那只会继续产出用不上的代码。

---

## 7. 取证命令

```bash
# agent-runtime 规模
find packages/agent-runtime/src -name "*.ts" | xargs wc -l | tail -1

# 谁真的引用了它 —— 注意用**路径**而不是包名：
# 全部导入都是相对路径（'../packages/agent-runtime/src/...'），
# 包名别名 `@awo/agent-runtime` 只出现在它自己的 package.json 里，没有任何人这样 import。
grep -rln "agent-runtime/src" --include=*.ts --include=*.mjs apps/ tools/ packages/ | grep -v node_modules
# 期望输出（且 apps/ 一个都没有）：
#   tools/architecture-check.mjs
#   tools/plugin-marketplace-cli.ts
#   packages/agent-runtime/src/network/egress-policy.ts   ← 包内部引用

# 应用内消费者（应为 0）
grep -rln "agent-runtime/src" --include=*.ts apps/ | grep -v node_modules | wc -l

# 是否有 sidecar / 外部进程 / JS 引擎（三者都应为空）
grep -n "sidecar\|externalBin" apps/desktop-shell/src-tauri/tauri.conf.json
grep -rn "Command::new" apps/desktop-shell/src-tauri/src/lib.rs
grep -n "deno_core\|boa\|quickjs\|rusty_v8" apps/desktop-shell/src-tauri/Cargo.toml
```

> 顺带一个信号：`@awo/agent-runtime` 这个包名**没有任何人 import**。
> 一个只被自己引用的包名，通常意味着它从来没被当作"对外提供的模块"对待过 ——
> 与"应用零引用"是同一件事的两种表现。
## 附：三边规模与可借清单（2026-10-17 实测）

| | 自有代码 | 源码文件 | 仓库体积 | stars | 许可 |
| --- | --- | --- | --- | --- | --- |
| **b07（本仓）** | **92,876 行** | 573（ts 465 / tsx 54 / rs 54） | 83 MB | — | — |
| **ZCode** | **678,445 行** | 3,069（ts 2,278 / tsx 791） | 93 MB | 7.9k | Apache-2.0 |
| **dsh** | **~52 万行**（估） | — | 286 MB | 252k | MIT |

数法：`git ls-files`（自动排除 node_modules）+ 逐文件数行，只取 `packages/*/src`、`apps/*/src`。
dsh 无法本地数，用 ZCode 标定（678,445 行 / 74 MB TS ≈ 9,168 行每 MB），dsh 57.16 MB TS ≈ 52 万行。

b07 是 ZCode 的 **1/7**，是 dsh 的 **1/5.6**。

### 本仓模块分布：约 1/3 是零引用

| 模块 | 行数 | 占比 | 状态 |
| --- | --- | --- | --- |
| `agent-runtime` | 25,620 | 27.6% | **零引用** |
| `workbench` | 21,774 | 23.4% | 在用 |
| `desktop-shell`（Rust） | 11,786 | 12.7% | 在用 |
| `protocol` | 4,830 | 5.2% | 在用 |
| `provider-sdk` | 2,636 | 2.8% | 在用 |
| `knowledge-workflow` | 2,201 | 2.4% | 零引用（Node 侧） |
| `workflow-script` | 1,611 | 1.7% | 零引用 |
| `capability-placeholder` | 969 | 1.0% | 待查 |
| `plugin-reference` | 947 | 1.0% | 零引用（Node 侧） |

零引用合计 ≈ 30,300 行 ≈ **32.6%**。
（另有 196,657 行 `.py` 属 `third_party/`：searxng-windows 352 文件、last30days-skill 305 文件，不算自有代码。）

### 可借清单（按成本从低到高）

| 级别 | 内容 | 代价 |
| --- | --- | --- |
| **A. 换依赖** | `@modelcontextprotocol/client` + `core` + `ext-apps@2.0.0`，替掉 683 行手写协议层 | 一天 |
| **B. 借契约** | ZCode `packages/shared/src/mcp-apps/CONTRACT.md` + `contract.ts` + `hostContract.ts` | 半批 |
| **C. 借设计** | ZCode ADR 0003（安装/来源独立建模 + 孤儿态）；dsh 市场索引 format-1 + `engines` 检查 | 半批 |
| **D. 不能借** | dsh 的 Cordis 插件体系（52 万行，等于重写应用）；ZCode 的 Electron 外壳（本仓是 Tauri） | — |

---
