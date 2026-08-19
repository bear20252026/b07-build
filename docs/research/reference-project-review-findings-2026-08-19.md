# 参考项目对标调研记录：Agent Runtime 与插件化

**作者：Manus AI**

**日期：2026-08-19**

## 第一轮官方资料结论

| 项目 | 官方资料确认的架构事实 | 对 AI Work OS 的可迁移方向 | 采用边界 |
| --- | --- | --- | --- |
| OpenClaw | 单一 Gateway 是 sessions、tools、events 与 channels 的本地控制面；Control UI、CLI 与 TUI 都连接 Gateway；tools、skills、plugins 可扩展能力。 | 保持本仓 Gateway 为唯一产品 HTTP 组合点，并把多个 UI/CLI 接入保持为 DTO/intent 通道。 | 不将远程通道或 host tool 执行直接引入当前本地 metadata Gateway。 |
| ClawCode | Rust workspace 是 canonical runtime；提供 `doctor` 健康检查、CLI/session 文档、parity 与路线图；ACP 当前仍非可执行 daemon。 | 为 Rust supervisor 增加可机读 doctor 输出、跨语言 contract/parity fixture、可复现 mock harness。 | 不把未成熟 ACP status 或 CLI 设计当作生产协议。 |
| DeepSeek Harness | models、tools、skills、sessions、sandboxes、storage、loops、scheduling、UI 都可由插件提供；插件通过 services/events 协作；所有 run 在 append-only session log 中可检索、恢复、分叉和回放。 | 在 v0.19 metadata 控制面之上建立 runtime preset/assembly 规格、统一的 run trajectory envelope 与可追溯 context injection 事件。 | 插件 manifest 继续只是 metadata；任何可执行 mount 仍必须经 Rust Host、实时 policy、预算和审批。 |

## 审查用来源

[1] [OpenClaw Repository README](https://github.com/openclaw/openclaw)

[2] [ClawCode Repository README](https://github.com/ultraworkers/claw-code)
[3] [DeepSeek Harness Official Overview](https://deepseek.com/harness/en/)

## 第二轮官方资料结论：工作台、知识与 Provider

| 项目 | 官方资料确认的架构事实 | 对 AI Work OS 的可迁移方向 | 采用边界 |
| --- | --- | --- | --- |
| AionUi | 统一 UI 管理内建与外部 CLI agent；并行 session 使用独立 context；Team Mode 通过 leader、async mailbox、task board 协调；每个 agent 有独立 permission dialog 和待审批标识。 | 把 v0.18 Adapter mailbox 和 v0.19 approval inbox 投影到 Workbench 的统一任务板；以独立 session/runId 表示每个 agent 的上下文与审批状态。 | 不采用其 unattended/YOLO 语义；本仓默认仍拒绝高风险能力，审批不等于执行。 |
| AnythingLLM | 本地优先，明确分离 frontend、server、collector 和 embedding/vector 数据层；提供动态模型路由、可配置 provider、文档 pipeline、来源引用与开发者 API。 | 把 Knowledge 的 document ingestion 抽为可观察 job/collector 边界；将 Provider Profile 扩展为模型、embedding、reranker 的同构 capability profile。 | 继续避免在 UI 或 metadata Gateway 中直接持有密钥、执行 provider 调用或引入远程 telemetry。 |
| LobeHub | 公开资料指向前后端、runtime 与数据存储的独立架构文档，且其 UI/图标生态适合 React 工作台。 | 继续复用其 MIT UI/icon 生态；将 Workbench 的观测区按任务、扩展、审批、知识来源拆为可独立测试的 feature slice。 | 保持当前 AionUi 石墨视觉方向，不复制 LobeHub 的全栈状态耦合。 |

[4] [AionUi Repository README](https://github.com/iofficeai/aionui)

[5] [AnythingLLM Repository README](https://github.com/Mintplex-Labs/anything-llm)

[6] [LobeHub Architecture Documentation Route](https://lobehub.com/docs/development/basic/architecture)

## 第三轮官方资料结论：本地多模型客户端

| 项目 | 官方资料确认的架构事实 | 对 AI Work OS 的可迁移方向 | 采用边界 |
| --- | --- | --- | --- |
| Chatbox | Electron 项目明确分为 main、renderer、preload、shared；强调本地数据、流式回复、快捷键、提示词库与跨平台打包。 | 为未来桌面壳保留 main/preload/renderer/shared 四层；为 Workbench 增加可访问性/快捷键测试和 streaming event 客户端。 | 当前 Web Workbench 不冒充 Electron 权限边界；任何 preload API 必须最小化、显式 allowlist。 |
| Cherry Studio | 多 Provider/本地 Ollama、LM Studio，支持多模型并发会话、MCP、助手、主题、桌面平台；公开 roadmap 包含知识管理、OCR、插件与多窗口。 | 将 Provider Profile 的解释理由与并行 session/run 可视化纳入 Workbench；以 feature slice 方式增加 Assistant Catalog、主题 token 与知识集合。 | 不将大量 Provider 密钥配置放入 UI；不引用 AGPL 代码。 |
| Jan | Tauri + Rust + web app + extensions 的目录分离；本地模型和 cloud model 可并存；提供 localhost OpenAI-compatible API 与 MCP；强调离线与隐私。 | 评估在 Rust supervisor 旁增加严格 loopback OpenAI-compatible adapter，并为离线状态、资源能力和本地模型健康度添加明确 UX。 | 仅允许受控 loopback endpoint；不将本地 endpoint 视为天然可信，继续经 Profile/data boundary 过滤。 |

[7] [Chatbox Repository README](https://github.com/chatboxai/chatbox)

[8] [Cherry Studio Repository README](https://github.com/CherryHQ/cherry-studio)

[9] [Jan Repository README](https://github.com/janhq/jan)
