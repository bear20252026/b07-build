# reference/ — 参考材料（分离存放，不与主代码混）

<!-- file-id: acct2-20260819-ai-work-os-reference ; 作者: 账号2 ; 日期: 2026-08-19 -->

> 本目录只存放**外部参考材料**（源码导读/静态补全候选/外部项目快照），**不参与** npm workspace / cargo workspace / 主代码构建。
> 主代码见 `packages/` `crates/` `sidecars/` `apps/`；本目录仅供研读与追溯。任何参考内容的使用都遵守其上游许可证与《融合型实施方案》的许可证隔离原则。

## 本地文件（已上传本仓）

| 文件 | 大小 | 来源 | 用途 |
|---|---|---|---|
| `CoreCoder_7篇源码导读原文归档_20260819.zip` | 50K | 账号2 解压自桌面 zip，对照 he-yufeng/CoreCoder 真仓库 | 7 篇源码导读原文（agent/llm/context/session/cli 全解析）——Agent 编排/上下文治理参考 |
| `ClaudeCode_静态补全候选_20260818.zip` | 27M | 账号2 本地下载的 Claude Code 静态补全候选 | Claude Code 源码基线静态补全——工具/Hook 链/Agentic Loop/子代理/工作树隔离参考 |

## 外部参考代码库（在线，未本地化）

| 仓库 | 用途 | 定位 |
|---|---|---|
| https://github.com/he-yufeng/CoreCoder | Agent loop/上下文压缩/工具契约的 TS 参考 | 已读 7 篇导读；必要时 clone 对照 |
| https://github.com/XiaomiMiMo/MiMo-Code | 小米开源编码 Agent 参考 | 已镜像最新版至 bear20252026/MiMo-Code（单提交快照，见台账） |
| Claude Code 源码基线（社区泄露镜像） | 7 项工程设计基线（见 docs/《产品目标·参考代码库·整体框架》） | 工具执行/Hook 链、query.ts Agentic Loop、AgentTool 子代理、函数式工具组合、MCP 隔离、会话/任务/工作树隔离、CLI/TUI 分层 |
| Antelope 泄露源码的最小可实践缩小版（社区重建） | 最小可实践模型的缩小版源码参考 | 本地暂无文件；列入参考清单，后续如取得源码再入本目录 |

## 使用规则
1. reference/ 内文件**不进** `tsconfig` / `Cargo.toml` / `vite` 任何构建入口。
2. 参考后写新代码走"清洁实现"：围绕自己的领域模型/命名/测试重写，不复制非公开代码。
3. 新增参考材料统一放本目录 + 更新本索引 + 登记台账。
