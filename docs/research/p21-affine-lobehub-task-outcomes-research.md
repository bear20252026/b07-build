# P21：AFFiNE / LobeHub 块式任务成果参考调研

**日期：** 2026-08-21
**作者：** Manus AI
**目标：** 在 P20 的轻量聊天首页和独立设置页之上，将当前 task/run 的受控成果组织为更易审查、交付和恢复的块式工作流，而不复制受限 LobeHub 主产品代码或扩张 Gateway 权限。

## 1. 官方资料与许可证结论

| 上游 | 已核验事实 | P21 采用方式 | 复用决策 |
| --- | --- | --- | --- |
| AFFiNE | 官方 README 将其定义为由知识库构件组成的工作区，并强调将文档、白板、表格等构件置于同一工作表面；当前 CE 说明采用 MIT。[1] [2] | 借鉴「一个工作单位由可独立扫描、可组合的块构成」的产品原则；任务成果不应只是散落在事件文本中。 | 若将来逐文件复用经确认的 MIT 代码，保留版权头和完整 MIT 文本；P21 预期使用原创实现。 |
| AFFiNE Workspaces | 官方文档区分 Local 与 Cloud Workspace，强调工作区承载相关文档和主题。[3] | 将已有 task/run 作为 AI Work OS 的最小受控工作单元，所有文件/交付只显示在同一 task/run 范围。 | 不引入 AFFiNE 的 CRDT、云同步、数据引擎或运行时依赖。 |
| LobeHub 主产品 | 官方 README 将 Agent 作为工作单元，并描述 Pages、Project、Workspace、Schedule 等结构；主仓当前为 LobeHub Community License。[4] [5] | 借鉴「任务、活动、产物与报告应存在稳定关联」的用户体验原则。 | **不复制、移植、改写或依赖 LobeHub 主产品源码。** 其当前许可证对衍生作品分发有附加条件。 |

> P21 只使用公开产品模式与本项目已验证的 task/run DTO，绝不将 Provider endpoint、API key、绝对路径、文件内容或可执行操作注入成果摘要。

## 2. 高价值功能缺口

目前 Workbench 已提供五标签右侧 Inspector（文件、代码、差异、交付包、引用）和 P19 任务故事板，但用户仍需自行在「故事板」与「右侧检查器」之间建立成果上下文。P21 应增加一个**任务成果摘要块**：在 task/run 工作台中以有限条目显示已产出的文件、最新交付包和下一步审查动作，并只通过明确、无副作用的导航将焦点转到已有 Inspector。

| 当前能力 | P21 增强 | 边界 |
| --- | --- | --- |
| `WorkbenchTaskFile[]` | 最多显示近期少量文件的逻辑路径、版本、媒体类型和大小。 | 只显示已有 metadata；不读取或渲染文件正文。 |
| `WorkbenchTaskDeliveryReceipt[]` | 显示最新 ZIP 收据的文件数与可用状态。 | 不自动创建、下载、解压或执行 ZIP。 |
| `WorkbenchTaskSnapshot` | 显示成果归属的当前 task/run 与状态。 | 不泄露 task goal、凭据、路径或运行细节。 |
| `PreviewPanel` | 点击成果块只聚焦已有 Inspector。 | 不切换标签、不发送请求、不触发 Provider。 |

## 3. 参考资料

[1]: https://github.com/toeverything/AFFiNE "AFFiNE 官方仓库与 README"
[2]: https://github.com/toeverything/AFFiNE/blob/canary/LICENSE-MIT "AFFiNE MIT 许可证"
[3]: https://docs.affine.pro/core-concepts/elements-of-affine/workspaces "AFFiNE Workspaces 官方文档"
[4]: https://github.com/lobehub/lobehub "LobeHub 官方仓库与 README"
[5]: https://github.com/lobehub/lobehub/blob/canary/LICENSE "LobeHub Community License"

## 4. 验证记录

P21 的纯成果投影回归测试覆盖了文件排序、最多三项展示、大小格式化、无文件不伪造可交付状态和最新收据选择。全量质量门通过：架构检查、严格类型检查、**235/235** 测试、Workbench 生产构建、两处 Rust crate 的 fmt/check/test/clippy、Python 编译、Gateway sidecar 构建、生产依赖审计和 7/7 桌面 CSP/sidecar 契约。

尝试启动第二个开发 Gateway 时，固定 `127.0.0.1:4318` 正被一个已运行的本项目 Node Gateway 占用；读取 `/api/providers/connections` 返回现有的脱敏 Provider DTO。这证明端口固定与回环限制在本次环境中生效。为避免并发服务实例竞争，P21 没有覆盖、停止或修改现有 Gateway；成果块本身使用已有 task/run DTO 的单元与构建验证，不依赖在浏览器预览中创建额外任务。
