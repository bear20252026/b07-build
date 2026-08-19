# 本地知识、MCP 与模型运行：公开参考项目研究

**调研日期**：2026-08-19  
**定位**：个人学习产品的本地优先能力融合；仅使用公开文档与高层模式。

## 可融合模式

| 参考项目 | 经公开资料验证的强项 | AI Work OS 的独立融合决策 |
|---|---|---|
| AnythingLLM | 工作区隔离的文档问答、可配 chunk/overlap/embedding、桌面本地体验 | 将现有知识 `sourceUri`、引用和 store port 扩展为 `KnowledgeWorkspaceId`；检索只能跨显式共享工作区，不能默认跨个人任务或 incognito session |
| Open WebUI | 多 Provider、MCP、可组合工具、混合检索和 reranking 等平台能力 | 先固化 adapter port 与检索阶段 port；不把具体向量库、模型、MCP server 类型写入领域模型；个人版优先小型本地实现，复杂 pipeline 延后 |
| Jan | 本地/离线模型运行、线程式对话、局部 API 暴露与跨平台桌面体验 | provider router 把 local runner 视为一等候选；定义 `LocalModelEndpoint` 健康与能力探测，不在 UI 中直连本地模型进程 |
| 5ire | 跨平台桌面、MCP client、本地知识、多 Provider、用量可见性 | 引入受控 MCP registry：发现、清单、启用状态和权限摘要；接入前必须经 capability policy / approval port，不执行“一键安装”或任意二进制 |
| Cherry Studio 等多模型客户端 | Provider/model 配置与本地模型连接的产品化体验 | 扩展现有可解释模型路由结果，使工作台可显示“为何选择/未选择本地模型”和成本/隐私原因 |

## 优先顺序

1. **会话控制面 v1**：解决本地恢复、可见性、incognito 和 snapshot gap；这是 OpenClaw 优先能力。
2. **本地模型 Endpoint Registry**：为已存在的 `provider-sdk` router 追加可靠的本机 runner 健康检查和能力发现。
3. **知识工作区与检索计划**：让本地向量库有工作区、来源范围和可解释 retrieval plan，而不急于引入重量级多向量数据库。
4. **受控 MCP Registry**：仅接入 manifest/审批/策略，后续再由用户显式添加可信 server；默认拒绝。
5. **受控子任务 v1**：会话、权限和预算稳定后，再按 OpenCode 的 primary/subagent 交互增加只读 Explore/Scout 子任务。

## 不在当前个人学习切片内的范围

- 外部 IM 帐号绑定、远端节点配对和公网 gateway。
- “一键下载/运行”第三方 MCP server 或模型二进制。
- 多用户 RBAC、SSO、组织治理和 Kubernetes 化部署。
- 无来源、无隐私范围的跨工作区/跨会话原文检索。

## 公开来源

1. [5ire GitHub README](https://github.com/nanbingxyz/5ire)
2. [Open WebUI & AnythingLLM](https://docs.openwebui.com/alternatives/anythingllm/)
3. [Open WebUI & Jan](https://docs.openwebui.com/alternatives/jan/)
