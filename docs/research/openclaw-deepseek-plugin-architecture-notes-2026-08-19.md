# OpenClaw 与 DeepSeek-Harness 插件化架构研究

**日期：2026-08-19**

## 关键结论

OpenClaw 将 **plugin** 定义为能力所有权边界，而将 **capability** 定义为可由多个插件实现/消费的核心契约。其加载链清晰分为 manifest 发现、启用与校验、运行时加载、表面消费；其中 metadata snapshot 不加载运行时代码，因此可先完成配置验证、诊断、UI/schema 提示和激活计划。[1]

DeepSeek-Harness 将模型、工具、技能、会话、沙箱、存储、循环、调度和 UI 都组合为 Cordis 插件，并以 append-only session log 记录模型看到的上下文、工具调用、子代理调度和注入来源。它当前处于 developer preview，官方明确说明会有破坏性兼容变更。[2] [3]

| 参考模式 | 可吸收原则 | AI Work OS 约束化适配 |
| --- | --- | --- |
| OpenClaw manifest-first | 先读取元数据，再决定是否激活；不要为验证配置执行插件代码 | 将现有 MCP manifest 抽象为通用 `ExtensionManifest`；安装/加载必须先经过 source digest、兼容性和权限评估。 |
| OpenClaw capability ownership | 插件拥有供应商或特性的完整表面，核心拥有共享能力契约、策略和 fallback | 保持 `CapabilityPolicy` 与 `ModelRouter` 在核心；provider、knowledge importer、UI panel 等扩展只登记受限 capability。 |
| OpenClaw activation plan | 按当前任务的 channel/provider/tool 等需求窄化加载范围；诊断必须说明理由 | 引入可解释激活计划，输出每个扩展的 `selected/disabled/blocked` 及 reason。 |
| OpenClaw operator install policy | 非受信任 npm/git/本地代码需审查、明确允许且运行时检查 | 默认拒绝外部扩展；将当前 MCP 的显式 enable/revoke、source digest、审查人延伸到全部扩展类别。 |
| DeepSeek “everything is plugin” | 可组合而非巨型核心；统一服务和事件通道 | 采用“可插件化的一切”但不采用“可自动执行的一切”：核心 runtime、策略、事件协议和 durable stores 保持可信基底。 |
| DeepSeek traceability | 运行可由同一 append-only log 重放、fork、search、审查 | 在 TaskEvent 之外补上 `extension.*` 生命周期事件和 context-source 引用；不得记录或展示私密 incognito 状态。 |

## 设计结论

应实现 **受控扩展平面（Controlled Extension Plane）**，而不是直接嵌入 DeepSeek 的 Cordis 运行时。AI Work OS 的最小可信核心继续持有：任务身份、Profile、能力政策、审批、预算、事件协议、SQLite append-only snapshots 和 incognito 隔离。扩展只能声明 manifest、能力、数据边界、资源预算和可选启动钩子；核心计划器才可以选择、拒绝、沙箱化或停用它们。

> 这实现了“任何业务能力可模块化”的收益，同时不让任意插件获得自动安装、自动加载、DB 直连、密钥访问、工具授权或网络执行权。

## References

[1] [OpenClaw Plugin Internals](https://docs.openclaw.ai/plugins/architecture)  
[2] [OpenClaw Plugins Guide](https://docs.openclaw.ai/tools/plugin)  
[3] [DeepSeek Harness Developer Preview](https://deepseek.com/harness/en/)  
[4] [DeepSeek Harness Repository](https://github.com/deepseek-ai/deepseek-harness)
