# LobeHub 生态包兼容性审查

**日期：2026-08-19**

当前工作台已升级为 **React 19.2.8** 并正式使用 `@lobehub/icons@5.16.0`。该包的 React 19 peer 约束满足，且 LobeHub 标识组件已完成浏览器验证。

| 包 | 最新公开包信息 | 与当前工作台关系 | 本轮决定 |
| --- | --- | --- | --- |
| `@lobehub/icons@5.16.0` | React 19 peer，MIT | 已直接使用并通过构建和浏览器验证 | 保留，作为模型与工作台品牌视觉入口。 |
| `@lobehub/ui@5.32.2` | React 19、Antd 6、Motion 12 peer，体积约 4.9 MB（解包） | 当前由 Icons 生态依赖解析；工作台已有独立石墨设计令牌 | 不将全量 Provider/组件树强行套入，以免重置现有主题与引入非必要包体。仅借鉴可访问性、i18n Provider 和 motion 模式。 |
| `@lobehub/charts@5.4.0` | React 19/Antd 6 peer，但要求 `@lobehub/ui ^4.3.3`，MIT | 与当前 UI 5 生态有代际 peer 差异；引入将增加 Recharts 与潜在嵌套 UI | 本轮不直接安装。先建立稳定只读指标 DTO 与零依赖、可审计的条形可视化；等 Charts 发布 UI 5 peer 对齐版本后再替换呈现层。 |
| `@lobehub/editor@4.24.0` | React 19/Antd 6/Motion 12/UI 5 peer，约 2.0 MB（解包），MIT | 契约兼容，但当前仅需编辑短任务/交付草稿 | 本轮以浏览器本地 Markdown 草稿验证“编辑不等于写入”的领域边界；富文本、上传、协作与插件在产物持久化服务具备后再按需引入。 |
| `@lobehub/i18n-cli@1.27.0` | MIT，面向有模型令牌的批量翻译 CLI | 本项目已有人工可审查 `zh-CN`/`en` catalog | 不让外部翻译直接写入 catalog；未来仅作为离线生成候选，经差异审查后合并。 |

> **决策：** 先稳定领域 DTO 和用户可见的白盒控制面，再安装重量级表现层。这样既能吸收 LobeHub 的“可视化、可审查、可运营”产品理念，也不会让 npm 依赖或浏览器 UI 越过任务控制、审批与本地数据边界。
