# LobeHub 生态适配计划

**作者：Manus AI**  
**日期：2026-08-19**

## 研究结论与许可边界

LobeHub 主仓库的公开产品模式强调以 Agent 作为工作单元、项目/工作区组织、调度与报告，以及可审查的个人记忆；但主仓库当前使用 **LobeHub Community License**，因此本项目只从中提炼产品与架构模式，不复制主仓库源码。[1] `lobe-ui`、`lobe-editor`、`lobe-charts` 和 `lobe-icons` 的公开仓库均标记为 **MIT**；其中 UI 基于 Antd/antd-style，Editor 面向 React 19+、Lexical 内核与插件化编辑，Charts 面向 Recharts 的图表组合。[2] [3] [4]

| 来源 | 本项目适配方向 | 采用方式 | 边界 |
| --- | --- | --- | --- |
| LobeHub 主仓库 | Agent 作为工作单元、运营可观测性、工作区/日程/报告产品模型 | 抽象领域模型和界面信息架构 | 仅参考模式，不复制 Community License 源码。 |
| Lobe UI | ThemeProvider、I18nProvider、配置化交互与可访问性 | 评估局部 UI primitives；当前石墨 token 继续为唯一主题事实源 | MIT 依赖可用，但不得让 UI 直接访问 DB、provider 或工具。 |
| Lobe Charts | 预算、并发、上下文压缩、记忆增长的可观测指标 | 优先为只读 runtime DTO 增加图表模型，再评估引入包 | 图表只订阅受控 DTO，不能成为运行时状态写入通道。 |
| Lobe Editor | Markdown/JSON/纯文本导出、插件和命令内核 | 为工作台的任务说明、产物评审和记忆候选编辑定义受控文档草稿边界 | 编辑结果是意图草稿，任何写入仍经任务/审批协议。 |
| Lobe i18n | 资源目录、增量翻译、评审流程 | 保持现有 `LocaleProvider` 和 `zh-CN`/`en` catalog；未来可加入离线/受控翻译检查 | 不把未审查机器翻译直接写入用户偏好或运行时策略。 |
| Lobe Theme / Vidol / Awesome RSI | 色彩层次、细腻动效、参考图与虚拟化交互灵感 | 仅抽象设计原则与交互启发 | 不复制非兼容仓库源码或资源。 |

## 下一步实现优先级

首先，应让网关公开稳定的只读运行统计 DTO：任务状态计数、并发峰值、预算阻断数、上下文压缩和存储修订增长。工作台据此渲染“控制面健康”面板。第二步，将工作台的交付说明从静态占位替换为受控 Markdown 草稿；编辑只更新浏览器草稿状态，明确提交后才经幂等任务意图进入运行时。最后，再按需评估 `@lobehub/charts` 和 `@lobehub/editor` 的依赖成本、React 19 peer 兼容性与浏览器包体积。

> **不可变架构原则：** UI 只订阅事件和只读 DTO、只发送用户意图；Memory Ledger 仍不可授权；incognito 数据不进持久存储或知识索引；MCP manifest 仅登记与显式启用，不自动运行。

## References

[1] [LobeHub Repository](https://github.com/lobehub/lobehub)  
[2] [Lobe UI Repository](https://github.com/lobehub/lobe-ui)  
[3] [Lobe Editor Repository](https://github.com/lobehub/lobe-editor)  
[4] [Lobe Charts Repository](https://github.com/lobehub/lobe-charts)

## 补充生态来源

| 来源 | 公开许可证 | 适配决定 |
| --- | --- | --- |
| Awesome RSI | CC0-1.0 | 可作为研究索引，用于扩展“候选—评审—确认”的受控改进路线；不实现自动自修改循环。 |
| Lobe Theme | AGPL-3.0 | 不复制代码或样式资产；只提取浅深主题、可调中性色阶、可访问性与移动端折叠的产品原则。 |
| Lobe Vidol | Apache-2.0 | 当前不引入三维/虚拟形象栈；借鉴多模态工作区、渐进式增强和 i18n 配置治理的界面思路。 |
| Lobe i18n | MIT | 可作为后续离线/审查式 locale 增量维护的候选 CLI；在未引入外部翻译调用前，现有静态中英文 catalog 仍是唯一运行时事实源。 |

上述来源表明，下一轮实现宜聚焦在 **白盒可观测性**：向用户呈现其任务、预算、记忆候选和受控扩展的可审查状态，而不扩大工具权限、更不引入自动执行。[5] [6] [7] [8]

[5] [Awesome RSI Repository](https://github.com/lobehub/awesome-rsi)  
[6] [Lobe Theme Repository](https://github.com/lobehub/sd-webui-lobe-theme)  
[7] [Lobe Vidol Repository](https://github.com/lobehub/lobe-vidol)  
[8] [Lobe i18n](https://github.com/lobehub/lobe-cli-toolbox/tree/master/packages/lobe-i18n)
