# AI Work OS：2026 架构评估与演进路线

**日期：** 2026-08-21
**作者：** Manus AI
**评估范围：** `main` 分支 `fd794f9`；Windows x64 桌面优先；第三方 API 优先；本机受控 Gateway；AFFiNE 与 LobeHub 的公开产品/架构模式。

## 结论

> **当前架构已经是“2026 年可维护的受控本地 Agent Workbench 基线”，不是需要推倒重写的原型。**
>
> 它不是“全行业最新功能的集合”——任何产品都不可能在一个时点完成这一点——但在可恢复执行、权限边界、凭据隔离、Windows 发布证明和 UI 分层方面，已具备比多数聊天壳更扎实的工程基础。下一步的重点应由“继续增加入口”转为“让已有领域对象形成完整闭环”。

## 当前已具备的现代化能力

| 层 | 现状 | 2026 价值 |
| --- | --- | --- |
| 桌面与 UI | Tauri Windows 壳；聊天首页、独立任务页、独立设置页；纯页面意图与命令目录。 | 高频操作简洁、低频控制面分层，避免将配置和执行堆叠到聊天页。 |
| 受控执行 | React 只发意图；本机固定 loopback Gateway 解码版本化 DTO；领域服务再访问运行时。 | 可将 UI、网络、持久化和副作用分开测试、替换与审计。 |
| 恢复与审计 | 任务快照、文件账本、交付收据与 SQLite WAL 适配器。 | task/run 可恢复，文件/ZIP 由受控资源链路而非聊天文本承载。 |
| 凭据与 Provider | `credentialReference`、session-only 自定义 Provider、HTTPS 与私网拒绝策略。 | API key 不入 SQLite、事件或 DTO；外部模型接入仍保持本地控制点。 |
| 交付安全 | Windows x64 Setup.exe、CSP 契约、固定 sidecar、SLSA provenance；GitHub Actions 已迁移官方 Node 24 runtime。 | 构建来源可追溯，不放宽 `unsafe-eval`、不自动安装/启动。 |
| 可组合性 | 每项 UI 能力分为纯类型/投影、视图、测试、设计记录；Gateway root 固定 350 行预算。 | 有利于逐里程碑回滚，而不是形成无法维护的巨大 App 组件。 |

## 对照 AFFiNE 与 LobeHub 的判断

AFFiNE 的关键启发是“对象具有稳定类型，页面只是对象的投影”，以及文档、表格、画布与本地索引逐步演进的工作区模型。[1] [2] 本项目已经将 task/run、任务成果、交付收据与项目元数据向该方向拆分；但不应贸然嵌入完整 BlockSuite 或自由画布，因为当前产品的主风险是**受控执行闭环**而不是缺少任意内容编辑器。

LobeHub 的关键启发是将 Agent、Task、交付检查和状态可见性放在同一操作面，而不是把每次对话视为孤立消息。[3] [4] 本项目的任务页、故事板、成果块和收尾判定已形成对应基础；但不应复制其云端长期运行、并行编排或品牌资源，而应坚持本机 Gateway 的显式启动、权限与审查模型。

## 缺口与优先级

| 优先级 | 主题 | 推荐交付 | 应避免的误区 |
| --- | --- | --- | --- |
| **R1** | 项目闭环 | 为已有 `ProjectWorkspace` 补齐 Workbench client、项目列表/详情页、task/run 归属动作与迁移回归测试。 | 不把项目做成聊天标签；不把文件字节、密钥或事件正文复制到项目 store。 |
| **R2** | 收尾闭环 | 把 P27 只读收尾判定接入独立任务页；提供“待审查条件”跳转到现有 Inspector，不自动创建 ZIP 或交付。 | 不用“任务完成”替代人工复核；不能伪造引用或交付收据。 |
| **R3** | 类型化任务块注册表 | 定义内建块 registry：Intent、Plan、Approval、Execution、Evidence、Files、Delivery、Closeout；每块有 DTO 投影与版本。 | 不引入任意第三方脚本块或可执行插件。 |
| **R4** | 可观测性与恢复演练 | 增加 task/run 时间线的结构化 trace、重放摘要、checkpoint 恢复演练、失败分类与导出脱敏诊断包。 | 不记录 prompt 中的密钥、文件正文或完整第三方响应。 |
| **R5** | 模型选择审计闭环 | 将 P25 的只读工作方式摘要升级为 task 提交时的显式、可回放 model/profile decision receipt。 | 不进行自动模型路由或隐式降级；不保存 API key。 |
| **R6** | 本地知识 UX | 把既有 SQLite 检索/引用层呈现为可审查引用块，支持 CJK 模糊搜索、范围选择和来源版本。 | 不因为追求“RAG”而自动把所有本地文件摄入或上传。 |
| **R7** | 文件大对象管道 | 引入可恢复导入状态机、内容摘要、文件类型 allowlist 和显式存储预算。 | 不让 UI 直读绝对路径；不把附件混入任务事件正文。 |
| **R8** | 设置控制面精修 | 已连接模型的修订历史、显示名、脱敏连通性结果和明确停用/回滚。 | 不在首页加入复杂 Provider 表单；不自动 probe。 |
| **R9** | 性能基线 | 建立冷启动、内存、长任务事件数、SQLite 读写和 Workbench bundle 的性能预算与 CI 回归门。 | 不为“性能”把受控边界跨线程或取消审计。 |
| **R10** | 扩展治理 | 从现有 Skill Pack 发展为签名/digest/权限声明/候选审查的能力清单。 | 不允许插件获得通用 shell、文件或网络权限。 |

## 推荐执行顺序

第一阶段应完成 **R1 + R2**，使“项目 → task/run → 证据/文件 → ZIP 收据 → 人工收尾”成为真实用户可以点击完成的闭环。第二阶段实施 **R3 + R4 + R5**，让每个任务的块、决策、失败和恢复都具备稳定类型与可回放证据。第三阶段再做 **R6 + R7 + R8**，提升知识、文件和模型配置的真实可用性。最后以 **R9 + R10** 建立长期性能和扩展治理，避免系统随功能增长失去边界。

## 许可证与复用决策

AFFiNE Community Edition 在官方 README 中说明采用 MIT；对逐文件的实质性复用，保留原始版权、MIT 文本、上游路径/commit、修改说明及 NOTICE。[1] LobeHub 的主产品代码必须按目标文件的当前许可证逐项核验；在未确认兼容前，仅使用其信息架构、任务可见性和交付检查模式，不复制实现、图标、字体、品牌或云端服务逻辑。[3]

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE GitHub README and license statement"
[2]: https://affine.pro/what-is-new "AFFiNE 2026 product updates"
[3]: https://lobehub.com/ "LobeHub product site"
[4]: https://lobehub.com/changelog "LobeHub changelog"
