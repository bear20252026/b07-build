# P19：任务故事板 Workbench 设计

**日期：** 2026-08-21
**作者：** Manus AI
**状态：** 已实现，待完成质量门与来源证明
**范围：** Windows AI Work OS 的 Workbench 主工作区

## 1. 目标

P19 在当前任务对话主工作区增加一个原创的 **Task Storyboard（任务故事板）**。它将当前 task/run 的脱敏摘要组织为四个稳定阅读块：**上下文、执行、人工复核、成果**。设计目标是使用户不用在对话事件、运行快照和右侧 Inspector 之间反复猜测当前状态，同时不把展示层变成第二套调度器、文件浏览器或 Provider 客户端。

该方向吸收 AFFiNE 的块式工作区、同屏信息组织和低干扰页面顺序，以及 LobeHub 对 Agent 任务、执行活动与成果审查的职责隔离。但实现完全以本项目原创 TypeScript/React/CSS 代码完成，不复制 AFFiNE 或 LobeHub 主产品源代码。[1] [2]

## 2. 信息架构与跳转

| 故事板块 | 显示内容 | 允许的交互 | 明确不做的事 |
| --- | --- | --- | --- |
| Context | 当前是否已有受控 task/run、运行尝试数和权限模式摘要 | 无 | 不显示任务原文、密钥、URL 或原始输入。 |
| Execution | 运行状态、步骤完成数与已记录事件数 | 无 | 不重放事件，不启动模型或后台运行。 |
| Review | 当前是否被阻塞、失败或无需确认的只读判断 | 无 | 不在该块提供自动批准、自动恢复或权限升级。已有运行快照仍是显式决策入口。 |
| Deliverables | 当前 task/run 文件与 ZIP 交付收据计数 | **查看成果**，只把键盘焦点移动到既有右侧 Inspector | 不读取文件内容、不创建 ZIP、不执行或解压文件。 |

> “查看成果”不是新的路由、API 请求或状态容器。它只聚焦已经存在的 `#task-inspector`，因此实际预览、差异读取与显式 ZIP 打包仍由 P13 的受控组件处理。

## 3. 数据与安全边界

`TaskStoryboard` 的输入完全由 `App.tsx` 已持有的 `WorkbenchTaskSnapshot`、事件数、任务文件数和交付包数构成。纯函数 `createTaskStoryboardProjection` 只将这些已验证的摘要映射为文案、状态色和计数。它不接收 task goal、文件正文、绝对路径、Provider endpoint、API key、凭据引用或可执行字段。

| 层级 | P19 责任 | 保持不变的限制 |
| --- | --- | --- |
| Workbench React | 组合已有脱敏 DTO；呈现卡片；聚焦现有 Inspector。 | 不导入 `node:`、SQLite、`child_process`、`process.env`；不直连 Provider。 |
| Gateway | 无新增 route、SQLite adapter 或环境读取。 | 仍是 Provider 会话、任务策略、审批、账本和 DTO 校验的唯一本机边界。 |
| Rust / Python sidecar | 无变更。 | 保持现有控制面、回环绑定与不可外部参数化规则。 |
| PreviewPanel | 增加稳定的键盘焦点锚点 `id="task-inspector"`。 | 仍只按 task/run 范围加载受限 preview/diff；ZIP 仅通过显式用户操作创建。 |

## 4. 版权与参考处理

AFFiNE 官方仓库当前说明 Community Edition 为 MIT；其 MIT 文本要求在复制或实质部分中保留版权与许可。[1] [3] LobeHub 主产品当前使用 LobeHub Community License，其衍生作品的商业分发存在附加限制。[2] [4]

P19 的处理方式如下。

| 参考对象 | 使用方式 | 本次代码处理 |
| --- | --- | --- |
| AFFiNE | 研究页面块、工作区层级和服务/实体分层的设计思路。 | 未复制任何源文件；因此没有将上游实现并入本仓库。若未来复用某个明确为 MIT 的独立文件，将保留文件版权头、完整 MIT 文本与 `THIRD_PARTY_NOTICES` 条目。 |
| LobeHub | 研究任务详情可拆分为 Brief、活动、成果与状态的职责模式。 | 未复制、移植或改写 LobeHub 主产品代码；不引入其运行时依赖或品牌资产。 |

## 5. 验收条件

P19 需满足以下条件：故事板在无任务、阻塞、失败和完成状态下可预测地显示四块结构；文件成果入口仅聚焦既有右侧 Inspector；新增纯投影测试覆盖核心状态；完整 TypeScript、架构、单元、生产构建、Rust/Python/sidecar、CSP 及 Windows 来源证明质量门均通过。

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE 官方仓库与 README"
[2]: https://github.com/lobehub/lobehub "LobeHub 官方仓库与 README"
[3]: https://github.com/toeverything/AFFiNE/blob/canary/LICENSE-MIT "AFFiNE MIT 许可证"
[4]: https://github.com/lobehub/lobehub/blob/canary/LICENSE "LobeHub Community License"
