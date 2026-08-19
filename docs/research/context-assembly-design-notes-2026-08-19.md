# 分层上下文装配与压缩治理设计笔记

**作者：Manus AI**  
**日期：2026-08-19**

## 可复用的公开设计原则

OpenClaw 将上下文引擎拆分为摄取、装配、压缩和回合后维护四个生命周期，并要求装配结果同时报告 token 估算；该分离有助于让记忆检索与「模型实际看到的输入」保持不同职责。[1] OpenClaw 的压缩保留近期未压缩尾部，要求工具调用与对应工具结果不可被压缩边界拆开，并在压缩写入前以质量检查失败即保留原始历史的方式避免上下文损坏。[2]

OpenCode 的检查点模式将早期会话压缩为结构化摘要，同时保留独立的近期尾部；它明确说明压缩不会删除较早的持久消息。[3] Open WebUI 为不同类型记忆设置独立注入预算，并以 type/path 管理可浏览范围；这支持将偏好记忆和一般事实记忆分开治理。[4]

| 本项目决策 | 依据 | 强制约束 |
| --- | --- | --- |
| L0 当前轮、L1 会话工作集、L2 已确认持久记忆、L3 知识引用、L4 历史归档按固定层次装配 | 上下文装配应在每次模型运行前产生有预算的确定性输入。[1] | 同层按稳定顺序选择；高层不能突破总预算。 |
| 每条注入项记录层级、原因、citation 与 token 估算 | 装配输出应有 token 估算；可引用项需要可审计来源。[1] | 不可追溯的知识项不能注入。 |
| 压缩前只产生 candidate 记忆，不直接确认为长期事实 | OpenClaw 在压缩前进行记忆保存提醒；Open WebUI 仍保留用户审查与删除控制。[2] [4] | candidate 不进入常规上下文；incognito 永不持久化。 |
| 压缩计划未通过验证时保留原会话工作集 | OpenClaw 的 safeguard 会在摘要不合格时停止写入并保留原始历史。[2] | 无摘要或缺少关键标识符时返回未压缩状态。 |
| 偏好记忆与普通持久记忆使用独立预算 | Open WebUI 对 user/context memory 分别限制注入量。[4] | preference 预算不可挤占 L0/L1。 |

> **实现边界：** Memory Ledger 只存储候选、确认与撤回的修订历史；Context Assembly 只读取符合 scope、path、expiry 与信任约束的 confirmed 项。二者均不得授予工具或审批权限。

## 参考文献

[1]: https://docs.openclaw.ai/concepts/context-engine "OpenClaw Context engine"
[2]: https://docs.openclaw.ai/concepts/compaction "OpenClaw Compaction"
[3]: https://opencode.ai/v2/docs/compaction "OpenCode Compaction"
[4]: https://docs.openwebui.com/features/chat-conversations/memory/ "Open WebUI Memory & Personalization"

## References

[1] [OpenClaw Context engine](https://docs.openclaw.ai/concepts/context-engine)  
[2] [OpenClaw Compaction](https://docs.openclaw.ai/concepts/compaction)  
[3] [OpenCode Compaction](https://opencode.ai/v2/docs/compaction)  
[4] [Open WebUI Memory & Personalization](https://docs.openwebui.com/features/chat-conversations/memory/)
