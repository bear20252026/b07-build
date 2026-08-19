# DeepSeek Harness 当前公开架构研究：可组合性与可追溯运行

**调研日期**：2026-08-19  
**用途**：吸收公开、可验证的高层扩展性设计；不导入上游插件框架或执行代码。

## 公开观察与独立决策

| DeepSeek Harness 公开设计 | 可融合原则 | AI Work OS 的独立落点 |
|---|---|---|
| 模型、工具、会话、sandbox、存储、loop、调度和 UI 都能作为插件装配 | 每个可替换能力必须有稳定端口、提供者和消费者，避免跨层 import | 继续按 TypeScript ports/adapters、Rust control plane、Python sidecar 划分；不引入“任何插件可修改任何运行时”的共享内核 |
| Durable session event log 是模型可见上下文、回放和 UI 轨迹的事实来源 | 所有模型可见输入必须能被重建；UI 只能渲染已验证事件和快照 | 当前 `TaskEvent` 已覆盖任务执行；Session Control Plane v1 扩展独立 `SessionEvent`，不把 token chunk、秘密或未脱敏工具输出送入通用日志 |
| 运行时 capability seam 分为 service definition、provider、consumer | 用一条接口定义把本地/远端模型、SQLite/vector、工具 sandbox 等实现替换隔离 | 将 provider-sdk、knowledge workflow、snapshot store 统一补齐显式 provider health / lifecycle；所有 consumer 仍要经过 CapabilityPolicy 和 ApprovalPort |
| profile/bundle 以有序配置装配可覆盖能力 | 配置层级应可审计、可恢复、不可越权 | 用版本化 `RuntimePreset` 记录 Profile、Role、router hints、budget 和开启的 adapter；preset 只能缩窄而非新增能力 |
| 运行模式（standard/code/minimal/creator）对应不同工具与交互集合 | 为学习/测试提供明确的低能力模式，而不是全量工具默认开放 | 定义 `RuntimeMode`：`explore`（只读）、`plan`（无副作用）、`build`（审批写入）、`benchmark`（最小可重复工具集）；现有 Agent Profile 迁移保持兼容 |

## 下一阶段落地：Runtime Preset Manifest v1

在 Session Control Plane 的领域模型中同时引入一个小而封闭的 `RuntimePresetManifest`：

```text
presetId + runtimeMode + roleId + profileId + modelRequirements
+ budgetLimits + knowledgeWorkspaceScope + enabledAdapterIds
+ contractVersion
```

该 manifest 是本地可审计的配置快照，不是可执行插件代码。新 adapter 只能在受控注册表中声明；UI 只能展示和选择已由本地网关允许的 manifest。该路径保留插件式可组合收益，同时避免通用动态插件给个人本地系统带来不透明依赖或权限升级。

## 官方来源

1. [DeepSeek Harness GitHub README](https://github.com/deepseek-ai/deepseek-harness)
2. [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
3. [DeepSeek Harness developer preview](https://deepseek.com/harness/en/)
