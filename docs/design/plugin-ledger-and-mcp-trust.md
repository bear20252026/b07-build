# 两条卡住插件链的决策

状态：**待拍板**
日期：2026-10-18
相关：`workbench-node-capability-decision.md`（为什么只剩 Tauri 命令面）、PR #45

技术侧已经就绪：官方 MCP SDK 已接入并对着真实 stdio 服务器验证通过，连接注册表
`liveMcpServers()` 可用，插件账本可读。**剩下的两条是产品与安全决策。**

---

## 决策一：谁写插件账本

背景：插件账本（`~/.awo/plugin-marketplace/*.sqlite`）目前只有一个写入方 ——
`tools/plugin-marketplace-cli.ts`。应用只读。

`installPlugin` 的依赖链合计 1000+ 行：`resolver.load`（市场加载，含 git 源）/
`resolvePluginRoot` / `inspectPluginPackage` / `appRegistry.register`。

| 选项 | 做法 | 代价 | 好处 |
| --- | --- | --- | --- |
| **1A. 只 CLI 写**（现状） | 用户在内置终端跑 `plugin-marketplace-cli.ts add <source>` | 需要终端；普通用户装不了 | 单一写入方，零重写，零分歧风险 |
| **1B. Rust 也写** | 在 Rust 里移植 install（校验 + 复制 + 建 id + 注册 app） | **重写 1000+ 行**；两个写入方必然分歧（id 规则、清单校验、幂等语义）；每次上游改规则要同步两处 | 应用内一键安装，无需 Node |
| **1C. 应用内调 CLI** | Tauri 命令跑 `node tools/... add` | 需要运行时里有 Node（应用当前不捆绑）；进程管理 + 输出解析 | 复用**同一份**逻辑，仍是单一实现 |

**推荐 1A。** 理由：1B 是明确的倒退（这个 PR 一路在清"两套实现"）；1C 只有在
"应用要捆绑 Node"成立时才划算，而捆绑 Node 正是 8 月删掉 gateway 想避免的事。
1A 的代价是"普通用户装不了"——但那是因为**插件本身还不可用**（见决策二），
先解决二，再回来看一。

---

## 决策二：MCP server 从哪来、信谁

背景：插件只声明 `mcpApp.serverId`，**没有** `command`/`args`。要 spawn 一个进程，
必须有人提供可执行文件与参数。而"用插件声明的命令去 spawn"等于把"装了别人的插件"
升级成"跑了别人的命令"——与 hook 同类风险。

| 选项 | 做法 | 代价 | 好处 |
| --- | --- | --- | --- |
| **2A. 用户显式登记 server** | 应用内配置 `command`/`args`/`env`（一份 server 列表），插件只按 `serverId` **引用** | 用户手工配置；插件"装完即用"不成立 | 信任面最小：执行的永远是**用户自己填的**命令，与插件来源无关；不需要新的信任模型；今天就能跑通 |
| **2B. 读账本清单 + 信任门** | 从 `mcp-servers.sqlite` 取清单，套用 hook 同款信任门（来源判定 + 准入）后 spawn | 要接一套信任门 + 清单格式校验；**插件来源决定了本机执行什么** | 装完即用；体验最好 |
| **2C. 不连 MCP** | 只展示插件声明的能力，永不执行 | 插件工具永远不可用 | 零风险 |

**推荐 2A。** 理由：2B 把"插件市场"变成了"远程命令执行清单"，这个信任模型需要
单独设计（谁能发布、如何审计、如何撤销），不是一批能做完的事；2C 等于承认插件只是
展示品。2A 让 `liveMcpServers` 立刻有真实数据，`plugin-reference` 的 reminder 也就
能真正生效——**而且它不引入任何新信任假设**。

2A 之后，"插件声明了 server X" 与 "用户配置了 server X" 的交集才有意义：
声明但未配置 → 显示"未连接"；两者都有 → 可用。

---

## 两案合起来的产品形态

```
插件（只读目录）          用户配置的 MCP server（可写）
  name@marketplace    ──►   serverId → command/args/env
  声明 serverId             ↑
  声明 toolNames            └── 只有交集才可执行
```

- 插件**怎么装**：CLI（1A）
- 插件**能干什么**：声明值，显示为"未连接"直到用户配置了对应 server
- 插件**真的能调工具**：仅当用户在设置里登记了同名 server

这个形态不需要新的信任模型，也不需要重写任何东西——**只差一个"server 配置"界面 +
把注册表接上**。

---

## 若选 2A，下一批的具体范围

1. 用户级 server 配置的存储（`~/.awo/mcp-servers.json` 或 Tauri 命令写 SQLite）
2. 设置页：增删改 server（command / args / env / 工作目录）
3. 用 `McpConnectionRegistry` + `McpStdioTransport` 把配置的 server 连起来
4. `plugin-reference` 的 reminder 接上（需要给 workbench 加 `@awo/plugin-reference` 依赖边）
5. `@` picker：列出"可用插件"（= 声明 ∩ 已配置 ∩ 已连接）

预计 2–3 批。
