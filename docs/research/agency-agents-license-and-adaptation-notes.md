# agency-agents：许可证与本地化适配核验

**核验日期：** 2026-08-21
**上游：** https://github.com/msitarzewski/agency-agents
**目标：** 将少量与 AI Work OS 相关的预置角色作为受治理、本地可审查角色目录引入；不把上游安装器或外部工具副作用带入本机 Gateway。

## 可验证许可证结论

上游根仓库公开标注 MIT License，LICENSE 全文的版权行是：`Copyright (c) 2025 AgentLand Contributors`。因此，复制其角色 Markdown 的实质文本时，目标副本必须保留该版权声明和完整 MIT 许可文本；仅借鉴信息架构或角色分类时仍在本项目研究记录中归因。

## 上游结构与本地化边界

上游按 engineering、design、product、project-management、testing、security 等专业目录组织角色，并在 README 中提供将角色安装到第三方 Agent/CLI 的脚本。AI Work OS 仅采用角色文本与分类的可审查模式：不运行、复制或启用其 `scripts/install.sh`、转换脚本、自动侦测、外部 CLI 写入或 hook 安装行为。

| 上游能力 | 本地化决定 |
| --- | --- |
| 专业角色 Markdown、明确使命/流程/交付物 | 选择少量与产品相关的角色，保留原文与 MIT 归因。 |
| 分专业目录与角色浏览 | 采用为二级“扩展与能力”下的目录和三级角色详情。 |
| 安装到 Claude Code、Cursor、Codex、OpenCode 等外部工具 | 不采用；AI Work OS 不自动写入、扫描或修改第三方工具目录。 |
| 角色含工具建议或高权限措辞 | 只作为不授予权限的上下文文本；不能替代 capability policy、审批或 Provider 约束。 |
| 上游原生应用与自动更新 | 不采用。 |

## 初选角色范围

首批仅考虑与当前 AI Work OS 直接相关的少量角色：Software Architect、Frontend Developer、Code Reviewer、SRE、UI Designer、UX Researcher、Product Manager、Project Shepherd、QA/Test Engineer 和 Security Auditor。每个角色作为静态、显式选择的受治理 Skill Pack 候选，不会自动注入任何任务。

## 官方来源

1. https://github.com/msitarzewski/agency-agents
2. https://github.com/msitarzewski/agency-agents/blob/main/LICENSE
3. https://github.com/msitarzewski/agency-agents/blob/main/README.md
