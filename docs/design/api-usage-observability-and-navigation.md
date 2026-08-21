# API 用量可观测性：分层导航与受控账本规格

**日期：** 2026-08-21
**范围：** Windows AI Work OS 的本机 Gateway 已实际完成的第三方 Provider 推理。
**对标：** TokenTracker 的本地、隐私优先计量模式；LobeHub 的 Agent/模型用量下钻；AFFiNE 的对象化多层工作表面。

## 信息架构

首页不展示任何图表、用量数字、成本或原始 API 记录。左下角设置进入二级页“运行记录”；其中仅提供一个紧凑的 **API 使用摘要** 卡片，显示本机 Gateway 的调用次数、成功率、最近一次活动和“供应商 token 计数可用/不可用”的状态。点击卡片才进入三级页 `api-usage`，三级页才显示按 Provider、模型和时间窗聚合的指标及单次脱敏收据。

| 页面层级 | 职责 | 禁止内容 |
| --- | --- | --- |
| 首页（workspace） | 任务发起、项目、工作方式、模板建议。 | 调用量、成本、账单、图表与筛选器。 |
| 二级设置（operations） | 运行账本、检查点、只读轨迹，另加一张 API 使用摘要卡。 | 完整事件表、复杂过滤、价格配置。 |
| 三级审计（api-usage） | Provider/模型/日期筛选、聚合趋势、单次调用脱敏收据。 | API key、prompt、response、endpoint、完整输出 digest、自动价格拉取。 |

## 度量事实与未知语义

当前 Provider Driver 把流式文本转换为受限输出字符串，并没有跨供应商统一返回 billing usage。故本期账本必须严格区分三类字段。

| 字段 | 来源 | 语义 |
| --- | --- | --- |
| `callCount`、完成时间、Provider、Profile revision、模型、延迟、输出字符数、结果状态。 | Gateway 已完成的实际推理结果。 | **真实事实。** |
| `reportedInputTokens`、`reportedOutputTokens`、`reportedTotalTokens`。 | 仅在已审核 Driver 明确返回供应商 usage 时记录。 | 当前驱动尚未稳定提供，默认未知。 |
| 成本。 | 需要用户显式配置并审查本地定价表，且依赖供应商 token usage。 | 本期显示“未配置/不可验证”，绝不以字符估算伪装账单。 |

## 隐私与安全边界

1. 账本只在本机 SQLite WAL 中追加写入；不得有遥测、云同步、自动扫描外部 CLI 日志或安装 hook。
2. 记录中不得含 API key、credential reference、base URL、prompt、response、输出正文、输出摘要、文件路径或操作系统用户信息。
3. 每个请求在 Gateway 成功返回后才写入；失败请求只记录 `outcome=failed`、Provider、模型、延迟和安全错误类别，不能包含供应商错误正文。
4. UI 仅经 HTTP DTO 读取投影；任何筛选和跳转均不授予重新调用模型、刷新报价或读取账户余额的权限。
5. 收据使用随机 `usageId`，不会使用 prompt/output digest 作可关联标识。

## 数据模型与流向

```
Provider inference completed or failed
  → Gateway provider route creates a redacted UsageReceipt
  → Local SQLite append-only UsageLedger
  → Gateway summary/detail projection DTO
  → Settings / Operations summary card (secondary)
  → API Usage audit page (tertiary)
```

`ProviderInferenceService` 仍只负责身份、Profile、凭据引用、Driver allowlist 与受限推理；计量由 Gateway application service 接收已脱敏结果并写账本，避免 provider-sdk 依赖 SQLite。

## 验收标准

- 调用次数、成功/失败、模型、Provider 和延迟来自真实 Gateway 推理调用。
- token 与成本在供应商未报告/本机未配置时显式显示未知；没有静默估算。
- 收据与聚合 DTO 不包含 key、endpoint、prompt、response、digest、路径或全量错误信息。
- 首页保持不变；三层导航从 settings operations 跳转到 API Usage。
- SQLite 账本可重开、顺序稳定、复制安全；全量质量门、桌面 CSP 和 Windows 来源证明通过。
