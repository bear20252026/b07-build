# API 用量可观测性：TokenTracker 对标笔记

**采集日期：** 2026-08-21

## TokenTracker：可吸收模式

TokenTracker 官方仓库将自身描述为本地优先的 token 用量与成本仪表盘，公开页面标示为 MIT 许可证。其 README、产品说明和工程说明共同强调：记录 token 计数、时间戳、模型与来源，而不读取或保存 prompt、回复或文件正文；以本地队列和 SQLite 聚合数据；将摘要页面、用量趋势、模型拆分、成本分析与限额详情分开呈现。

| 可吸收模式 | AI Work OS 本地化决策 |
| --- | --- |
| 只记录 token/时间/模型/来源，不记录 prompt 或 API key。 | 采用。Gateway 只写入已发生的 Provider 推理的脱敏 metering 收据；不从外部 CLI 日志扫描或安装 hook。 |
| 追加式用量记录、稳定 dedup 键、按时窗聚合。 | 采用。以 `provider/profile/model/request` 受控收据为起点，聚合只在查询投影层进行。 |
| 仪表盘中将核心数字与 per-provider/details 分层。 | 采用。设置二级入口仅显示摘要；三级页提供模型/Provider/日期过滤和单次调用审计。首页不展示。 |
| 成本引擎用公开价格表估算。 | 有条件采用。先显示“厂商未返回/本机未配置价格”的未知状态；不把估算金额伪装为账单，也不自动联网拉取价格。 |
| 自动扫描第三方工具日志、安装 hook、读取其它应用 SQLite。 | 不采用。与 AI Work OS 的显式输入、最小权限和不自动扫描文件边界不兼容。 |
| 桌面宠物根据真实用量活动反应。 | 可在未来作为纯 UI 投影采用；当前动态玩偶仍不从 API 使用量驱动，以避免把装饰误读为任务执行或计费结论。 |

## 许可证与引用

TokenTracker 的根 LICENSE 为 MIT License，版权标注为 `Copyright (c) 2026 xiufengsun`。本轮先借鉴公开的产品与数据建模模式；若未来复制其可识别代码或资产，必须保留相应版权声明与 MIT 许可文本。

## 官方来源

1. https://github.com/xiufengsun/TokenTracker
2. https://github.com/xiufengsun/TokenTracker/blob/main/LICENSE
3. https://github.com/xiufengsun/TokenTracker/blob/main/PRODUCT.md
4. https://github.com/xiufengsun/TokenTracker/blob/main/CLAUDE.md

## LobeHub 与 AFFiNE：最新对标结论

LobeHub 官方更新日志的公开摘要显示，其 Agent 层已呈现 token、使用量与成本细节，活动热图支持从对话频率切换到 token 用量；这支持“摘要先行、下钻审计”的页面层级。AI Work OS 采用该信息架构，而非复制其云端 Agent 自治、服务端账户或 Credits 体系：本项目只对本机 Gateway 已实际发出的 Provider 请求记录收据。

AFFiNE 官方仓库当前仍明确以 local-first、privacy-focused workspace 与可组合 building blocks 为核心，并使用独立结构组织 packages、BlockSuite 与本地/协同数据基础。AI Work OS 因此采用“Settings 二级入口 → API Usage 三级审计页”的对象化跳转逻辑：一级聊天首页只保留任务发起；二级设置承载系统控制；三级独立页面承载高密度指标、过滤器和收据列表。不会将 AFFiNE 的 CRDT、白板或同步服务器引入 API 计量功能。

| 对标项目 | 可采用 | 不采用 |
| --- | --- | --- |
| LobeHub | Agent/模型层使用量摘要、热图/趋势与按 Provider/模型下钻，成本作为估算而非命令入口。 | 云端账户 Credits、服务端数据仓库、自动 Agent 组织及其受许可证约束的产品代码。 |
| AFFiNE | 块式对象边界、二级/三级表面、局部高密度工作面、local-first 数据归属。 | 为统计引入协作 CRDT、文档/画布平台或同步基础设施。 |

## 增补官方来源

5. https://lobehub.com/changelog
6. https://lobehub.com/changelog/page/2
7. https://github.com/toeverything/AFFiNE
