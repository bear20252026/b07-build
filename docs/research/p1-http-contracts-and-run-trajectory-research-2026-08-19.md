# P1 调研：版本化 HTTP 契约与可回放运行轨迹

**作者：Manus AI**

**日期：2026-08-19**

## 结论

AI Work OS 应把现有严格 Task Event 协议扩展为两个不同层级，而不是将 HTTP body、领域事件和观测 trace 混成单一大 DTO。

| 层级 | 责任 | P1 实现 |
| --- | --- | --- |
| HTTP Contract | 在 Gateway 边界拒绝错误请求/响应漂移；客户端只获取已声明 DTO。 | `@awo/protocol` 提供 versioned request/response guard；每个 route 仅接收已解码 command；Workbench client 复用 response guard。 |
| Domain Event | 表达可回放的控制面事实和状态迁移。 | 保持既有 Task Event、revision、approval、citation 语义；不把原始 prompt、secret、tool args 写入通用事件。 |
| Run Trajectory | 为任务、计划、Skill provenance、Adapter session、Schedule run 提供按来源关联的 append-only 审计投影。 | `RunTrajectoryEventV1` 只存 actor/source/revision/capability/budget/引用和摘要，不存链式思维、凭据、规则全文、任意 tool 参数。 |

DeepSeek Harness 的公开说明表明，session log 用于重建 run、检索、分叉、恢复和回放；本仓应借用它的 **append-only + source provenance** 模式，但不复制完整 prompt/reasoning 记录，以免把敏感上下文扩散为默认可读日志。[1]

OpenTelemetry GenAI 语义规范提供 agent、conversation、workflow、operation、provider、token usage、retrieval source 与 tool 等关联维度。P1 仅借用这些稳定的**关联名称**，不默认采集 `input.messages`、`output.messages`、tool arguments 或 result，因为这些字段可包含用户数据、密钥或不应共享的推理内容。[2]

Pact 说明 HTTP/消息合同测试应以消费者实际使用的具体 request/response 为例，和 schema-first 描述互补。P1 因而采用「协议 guard + Gateway 真实 HTTP 集成测试 + Workbench client fixture」三层，而不是将所有端点都迁入沉重的外部契约平台。[3]

## P1 不变安全约束

1. HTTP schema 验证不授予执行权；route 仍调用服务端 policy 与审批状态机。
2. Trajectory 事件是 metadata；可检索、分叉和回放不表示可重放副作用。
3. 每个 trajectory event 必须有 `runId`、`sequence`、`source`、`at` 和 schema version；不能让 UI 注入任意 actor/source。
4. 所有 user text、Skill 正文、credential reference 解析结果、tool args/result 只允许由专门的受限 store 管理，不进入默认 trajectory 响应。

## References

[1] [DeepSeek Harness Official Overview](https://deepseek.com/harness/en/)

[2] [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)

[3] [Pact Contract Testing Introduction](https://docs.pact.io/)
