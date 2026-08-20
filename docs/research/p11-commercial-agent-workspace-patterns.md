# P11：商业级 Agent Workspace 模式调研

调研日期：2026-08-20

## 结论摘要

成熟的 Agent 产品并非以“更高权限”作为可靠性的来源，而是将用户目标拆分为可审查的计划、隔离的执行环境、可回放的状态与可验证的产出物。对 AI Work OS 而言，P11 最有价值的增量是建立**工作区产出物与恢复检查点账本**：每一次任务运行都拥有稳定的任务根目录、显式产出清单、只读摘要、可恢复 checkpoint，以及用户可点击的审查/继续/放弃动作。该能力与现有的任务快照、轨迹账本、四级权限和 Windows 本机 Gateway 自然衔接，且不要求放宽任何系统权限。

| 外部模式 | 公开资料中的关键机制 | AI Work OS 的受控本地化结论 |
|---|---|---|
| GitHub Copilot cloud agent | 先研究与计划，再在短生命周期隔离环境中改动和测试；可审查 diff 与日志；输出在提交/分支中透明可见。 | 为本机运行建立运行级工作区和产出 manifest；不自动创建分支、不自动推送或改写用户代码。 |
| Claude Code checkpoints | 在每项 Agent 编辑前保存检查点，可独立恢复代码或会话；推荐与版本控制组合。 | 记录可恢复的任务状态与产出摘要；恢复只能重建受控运行状态，绝不自动执行 metadata 中的动作。 |
| Claude Code worktrees | 并行会话以独立目录/分支隔离编辑，并以锁和清理策略避免冲突与误删。 | 第一阶段只实现“单运行、显式工作区边界与 owned artifact 清单”；不在 P11 自动创建 Git worktree，也不引入并行文件写入。 |
| 专业代理 UX | 计划、状态、变更和产出物彼此可见，长任务可继续而不遮蔽用户控制。 | Workbench 在运行记录页面展示 checkpoint 与产出物摘要；冷路径诊断保持独立，主页不膨胀。 |

## P11 建议范围

1. 在领域层新增 `WorkspaceArtifactLedger` 与 `RunCheckpointLedger`，使用 SQLite adapter 只持久化**引用、摘要、哈希、状态和时间戳**；不持久化 API key、原文秘密或不受控 shell 输出。
2. Gateway composition root 负责创建 SQLite adapter；HTTP route 只调用注入服务，不直接创建数据库、读取环境或启动端口。
3. 新增版本化 HTTP 只读查询与显式 intent 路由，Workbench 只通过 task-client 发起查询和继续/放弃 intent。
4. 每个 checkpoint 表示任务轨迹与 artifact manifest 的可回放快照，不能成为自动执行授权；恢复仍需重新经过现有权限与审批控制面。
5. Workbench 运行记录页新增“任务产出与检查点”模块，保持模型连接为默认首屏且不接触 credential 原文。

## 非目标

P11 不实现自动 Git 提交、自动 PR、自动 worktree 创建、后台常驻进程、自动恢复执行、任意文件系统浏览、任意 shell 或网络权限。上述能力需要独立的风险分析、权限模型与 Windows 发布验证。

## References

[1] [GitHub Docs — About GitHub Copilot cloud agent](https://docs.github.com/copilot/concepts/agents/cloud-agent/about-cloud-agent)

[2] [GitHub Docs — GitHub Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent)

[3] [Claude Code Docs — Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees)

[4] [Anthropic — Enabling Claude Code to work more autonomously](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
