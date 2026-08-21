# P20：AionUi 式两级 Workbench 信息架构设计

**日期：** 2026-08-21
**作者：** Manus AI
**状态：** 已设计，待实现与验证

## 1. 设计目标

P20 将当前 AI Work OS 从“首页同时暴露任务、模型、运行状态、数据流、故事板和文件检查器”的高密度布局，调整为两级操作面：**轻量聊天首页**与**独立设置工作区**。首页让新用户先完成“选择 Agent Profile、输入目标、连接模型（若尚未配置）”这条高频路径；模型连接、已连接模型、运行记录、扩展能力、安全与系统等低频复杂控制进入 Settings 页面。

此模式参考 AionUi 的官方侧栏页脚双态入口与设置侧栏分组模式。[1] [2] 本项目不复制其内置图标、Logo、组件库、路由器、主题或实现代码；P20 使用原创 React/CSS 组件和既有本机 Gateway DTO。

## 2. 页面职责

| 页面态 | 侧栏 | 主区域 | 右侧 Inspector | 禁止承担的职责 |
| --- | --- | --- | --- | --- |
| Chat Home | 新任务、工作区、模型连接、高频 Agent 小玩偶；页脚只显示“打开设置”。 | 无任务时显示简洁欢迎、Profile 选择、模型就绪提示、建议任务和输入岛；有任务时恢复任务故事板、运行快照与活动。 | 仅在 task/run 已存在或已产生受控成果时显示。 | 不显示低频运维面板、Provider 测试、审计报表或扩展管理。 |
| Settings | AI Core、Workspace、System 三个分组；页脚显示“返回聊天”。 | 按现有 `models`、`connections`、`operations`、`capabilities`、`security` 页渲染其原有组件。 | 不渲染。 | 不自动启动 Gateway、probe Provider、调用模型、读取 API key 或改变任务。 |

> 首屏“连接第三方 API”仍是入口，但仅跳转 Settings → 模型连接；它不在首页展开完整 Provider 配置表单。

## 3. 状态机与导航

P20 不新增浏览器路由、URL 参数或持久化 UI 状态。`WorkbenchPage` 继续为唯一前端页面意图源：`workspace` 代表 Chat Home，其余值代表 Settings 页面。

```text
Chat Home (workspace)
  ├─ 新任务 → focus composer
  ├─ 模型连接 → Settings / models
  └─ 左下角打开设置 → Settings / models

Settings / models | connections | operations | capabilities | security
  ├─ 设置分组项 → 同一 Settings 页面内切换既有视图
  └─ 左下角返回聊天 → Chat Home (workspace)
```

该跳转不调用 Gateway。现有依赖 `activePage` 的只读水合逻辑仍然只在进入相应低频设置页后运行，因此首页不会请求控制面诊断或安全审计摘要。

## 4. 组件边界

| 组件/文件 | P20 职责 | 输入与边界 |
| --- | --- | --- |
| `Sider.tsx` | 明确将 Primary（Chat Home）与 Settings navigation 分开；页脚双态显示打开设置/返回聊天。 | 只发送 `onNavigate`、`onNewTask` 与主题/语言 intent。 |
| `ChatHome.tsx` | 呈现无任务的轻量欢迎、Profile chips、建议目标、模型入口。 | 不读取 Provider secret、文件、SQLite、进程或网络；仅调用父组件受控 intent。 |
| `App.tsx` | 按 task/run 是否存在决定是否扩展到故事板、运行快照、活动和 Inspector。 | 不新增 route、Gateway API 或数据源。 |
| `catalog.ts` | 为新增 UI 文案提供中英文对应文本。 | 禁止硬编码单语言用户文案。 |
| `workbench.css` | 创建 Home/Settings 的原创样式，不导入 AionUi 主题/资源。 | 保持 CSP；不引入外链字体或图标运行时。 |

## 5. AionUi 许可证与归属处理

AionUi 官方仓库使用 Apache-2.0。[3] P20 仅复制其**职责分层模式**，不复制源代码，因此本轮不添加第三方源文件或许可证副本。若后续某次确有必要移植其明确的 Apache-2.0 文件，将同时执行以下步骤：保留该文件的 `Copyright 2025 AionUi (aionui.com)` 与 `SPDX-License-Identifier: Apache-2.0`；保留原始 Apache-2.0 文本；新增 `THIRD_PARTY_NOTICES` 以记录来源、上游 commit、文件路径与本地修改；不得使用 AionUi 商标、Logo 或视觉资产。

## 6. 验收条件

无任务时首页可见的主路径限定为任务输入、Agent Profile、模型就绪和设置入口；设置页保留既有复杂分组和所有能力页；左下角可在两态之间稳定切换；有任务时既有任务故事板、快照、活动、文件 Inspector 和显式交付流程仍可用。完整 TypeScript、架构、测试、生产构建、Rust/Python/sidecar、CSP 合同和 Windows 来源证明必须通过。

## References

[1]: https://github.com/iOfficeAI/AionUi/blob/main/packages/desktop/src/renderer/components/layout/Sider/SiderFooter.tsx "AionUi SiderFooter"
[2]: https://github.com/iOfficeAI/AionUi/blob/main/packages/desktop/src/renderer/pages/settings/components/SettingsSider.tsx "AionUi SettingsSider"
[3]: https://github.com/iOfficeAI/AionUi/blob/main/LICENSE "AionUi Apache License 2.0"
