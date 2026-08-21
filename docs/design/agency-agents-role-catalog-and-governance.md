# agency-agents 预置角色目录与治理规格

**日期：** 2026-08-21
**上游：** `msitarzewski/agency-agents`，MIT License，`Copyright (c) 2025 AgentLand Contributors`。

## 目标与分层导航

AI Work OS 引入少量与本产品直接相关的预置专业角色，但角色不是权限 Profile、Provider、工具插件或自治 Agent。角色作为可审查的静态 Skill Pack 来源，只在操作者于三级详情中明确“添加为候选”后才进入本机 SQLite 账本；候选必须按既有 `candidate → reviewed → published/disabled/revoked` 生命周期处理。

| 表面 | 职责 | 禁止内容 |
| --- | --- | --- |
| 首页 | 不显示角色目录、角色提示或角色切换。 | 团队墙、角色列表、自动激活。 |
| 二级：设置 → 扩展与能力 | 显示紧凑“预置专业角色”入口和来源/许可证摘要。 | 大量角色正文、自动安装或批量发布。 |
| 三级：专业角色目录 | 按 division 浏览少量角色、查看归因、用途与安全说明。 | Provider 切换、API key、工具执行、外部目录写入。 |
| 四级：角色详情（局部抽屉/详情面） | 预览原始角色文本与版权头；显式添加为候选。 | 自动注入上下文、自动审批、自动发布。 |

## 首批角色与来源

首批复用八个角色原文，保留每个角色文件前的版权/许可证提示，并在根 `THIRD_PARTY_NOTICES.md` 加入完整 MIT 文本：Software Architect、Frontend Developer、Code Reviewer、SRE、UI Designer、UX Researcher、Product Manager 与 Test Automation Engineer。

复制的原文来源固定至本轮上游快照，目标文件保留 `sourcePath`、上游 URL、MIT 归因和 SHA-256 摘要。角色文本是 untrusted context：即使包含工具建议、命令示例或“自动化”措辞，仍不能改变 AI Work OS capability policy、审批、Provider 数据边界、密钥策略或桌面 CSP。

## 接入管道

```
Static licensed role catalog
  → GET /api/agency-roles (metadata only)
  → GET /api/agency-roles/:id (source + content only on explicit detail request)
  → POST /api/agency-roles/:id/candidate (explicit x-awo-operator-intent)
  → SkillPackRegistry.registerCandidate
  → existing human review / digest verification / publish / revoke pipeline
```

Gateway 读取编译内置角色常量而非扫描本地目录、调用网络或运行上游脚本。UI 只通过 API 消费 metadata/详情，并且不将角色正文注入任务。重复添加同一版本时返回现有候选摘要而非覆写账本。

## 版权与许可实施

1. `THIRD_PARTY_NOTICES.md` 保存上游仓库链接、快照 commit、版权行和完整 MIT License。
2. 复制的每个 Markdown 源文件及编译常量均保留版权头：`Copyright (c) 2025 AgentLand Contributors`。
3. UI 可见的角色详情显示 `来源：agency-agents · MIT` 与上游链接；不得暗示该项目背书 AI Work OS。
4. 不复制上游安装器、转换脚本、原生应用、自动更新、外部日志扫描或 hook。

## 验收标准

- 角色目录仅在二级“扩展与能力”入口及其三级页出现。
- Gateway 无本地目录扫描、外部 CLI 写入、hook 安装或网络依赖。
- 角色候选需要显式操作者 intent；仍不能自动注入、执行或授权。
- 复制文本、目标文件、第三方通知和 UI 都具有可核验 MIT 归因。
- 全量质量门、Windows 来源证明和性能预算通过。
