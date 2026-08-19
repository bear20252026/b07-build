# LobeHub 生态参考与许可证边界

**调研日期**：2026-08-19  
**用途**：为 AI Work OS 的个人学习产品吸收 LobeHub 生态的设计系统、图标、编辑器、图表和国际化模式；每项采用都在独立依赖与 NOTICE 中保留上游版权和许可证信息。

## 许可证与采用决策

| 项目 | 公开定位 | 公开许可证 | 本项目采用边界 |
|---|---|---|---|
| [LobeHub](https://github.com/lobehub/lobehub) | 7×24 Agent 运营、团队、个人记忆与工作区产品 | LobeHub Community License | 仅参考产品信息架构、状态透明/白盒记忆和 Agent 作为工作单元的模式；不复制产品源码或将其当作 MIT 依赖。 |
| [Lobe UI](https://github.com/lobehub/lobe-ui) | AIGC React UI 组件库，基于 Ant Design，ESM-only | MIT | 可在评估 bundle/依赖影响后作为 UI 包直接依赖，或独立吸收 token、provider、motion、i18n 组合模式；保留 MIT 版权与许可证。 |
| [Lobe Icons](https://github.com/lobehub/lobe-icons) | AI/LLM 品牌 SVG/PNG/WebP 图标，tree-shakable | MIT | 优先作为本地 npm 依赖按需导入；不使用远程 CDN，保持本地优先、离线可用和可复现版本；保留 MIT 许可证。 |
| [Lobe Editor](https://github.com/lobehub/lobe-editor) | Lexical 内核 + React 插件化编辑器，含 slash/mention/chat input | MIT | 后续用于记忆/工作笔记编辑；先建立 `MemoryEditorPort`，不让编辑器直接写 SQLite 或执行工具；保留 MIT 许可证。 |
| [Lobe Charts](https://github.com/lobehub/lobe-charts) | Recharts 基础的现代 React 图表 | MIT | 用于预算、记忆增长和运行统计的可视化；按需加载并限制首屏图表；保留 MIT 许可证。 |
| [Lobe i18n](https://github.com/lobehub/lobe-cli-toolbox/tree/master/packages/lobe-i18n) | 大文件拆分、增量翻译与 locale lint 的 CLI 工作流 | MIT | 采用 locale JSON 的增量/分片/可恢复流程；自动翻译必须在未来由显式用户操作、可信模型与人工复核触发，不能把 API key 写进前端。 |
| [Lobe Theme](https://github.com/lobehub/sd-webui-lobe-theme) | 主题、可配置侧栏、亮/暗色 UX 参考 | AGPL-3.0 | 仅保留抽象设计启发（令牌化主题、可配置侧栏、移动折叠）；不复制 CSS/JS/资源，避免使本项目被其条款约束。 |
| [Awesome RSI](https://github.com/lobehub/awesome-rsi) | Agent 记忆、评估和自我改进研究索引 | CC0-1.0 | 作为研究导航；本项目仅实施有明确人类审查、预算和权限边界的“受控学习”，不做自修改或无限自动改进循环。 |

## 可融合的产品模式

| LobeHub 生态模式 | AI Work OS 的独立实现 |
|---|---|
| Agent 是工作单元；工作区、任务、报告和记忆可见 | 工作台增加 `AgentRole`、Session/Task tree 与 Memory review；状态全部来自防御性 DTO。 |
| 白盒记忆与个人可编辑记忆 | 已有 Memory Ledger；后续提供 candidate/confirmed/retracted 的审查页和来源/过期/范围浏览。 |
| 插件化编辑器、slash/mention、Markdown 互操作 | 先用可替换的 Editor Port；只作为 UI 输入，不直接绑定 Policy、Store 或 Tool Runner。 |
| Tree-shakeable 图标与显式品牌模型图标 | 仅按需引入经过审计的本地包，降低初始工作台 bundle。 |
| UI provider、主题、i18n resource bundles | 在既有石墨设计令牌上增加 `LocaleProvider` 和 resource catalog；文本不散落在 UI 组件中。 |
| 大文件拆分、增量翻译和断点恢复 | 对 locale 资源建立键级校验和增量更新，自动翻译是未来单独审批的后台工作流。 |

## P0–P3 相关约束

1. LobeHub 主仓库使用 Community License；其源代码不作为可自由复制的 MIT 素材。
2. 引入任何 MIT npm 包前，固定版本、审查 transitive dependency 与包体；更新 `THIRD_PARTY_NOTICES.md`。
3. UI 包只能消费网关 DTO；不得因使用编辑器、图表或图标而突破 SQLite、Provider、审批或 CapabilityPolicy 边界。
4. 受控 MCP Registry 只保存 manifest，不创建、启用或调用任何 Manus connector；实际外部连接始终需要用户显式提供 URL/凭据并经过单独确认。
5. 7×24、定时、持续运行或远端节点属于后续部署选择，而不是本轮默认能力；个人本地版本仍保持按需启动、默认关闭外部连接。

## 来源

1. https://github.com/lobehub/lobehub
2. https://github.com/lobehub/lobe-ui
3. https://github.com/lobehub/lobe-icons
4. https://github.com/lobehub/lobe-editor
5. https://github.com/lobehub/lobe-charts
6. https://github.com/lobehub/lobe-cli-toolbox/tree/master/packages/lobe-i18n
7. https://github.com/lobehub/sd-webui-lobe-theme
8. https://github.com/lobehub/awesome-rsi
