# MiMo Token Plan 与自定义模型连接契约

**日期：** 2026-08-22  
**作者：** Manus AI  
**状态：** 已实施并纳入回归测试

## 问题与根因

现有 MiMo 预置只有一个按量 API 目录项，固定指向 `https://api.xiaomimimo.com`。这对 `sk-` 按量密钥正确，但用户输入 `tp-` Token Plan 密钥时，界面没有区域/套餐端点选择，Gateway 因而会向错误端点探测和推理。与此同时，浏览器客户端仅接受 `provider.*` 推理 profile，导致 Gateway 已完成的 `session.custom-*` 自定义兼容模型结果被前端误判为无效。

> 小米官方说明明确区分 `sk-xxxxx` 按量密钥与 `tp-xxxxx` Token Plan 密钥；两者独立且不可混用。Token Plan 应以控制台显示的区域 Base URL 为准。[1] [2]

| 连接类型 | OpenAI 兼容 Base URL | 官方密钥形式 | 本轮预置 |
| --- | --- | --- | --- |
| MiMo 按量 API | `https://api.xiaomimimo.com/v1` | `sk-…` | `mimo` |
| Token Plan 中国 | `https://token-plan-cn.xiaomimimo.com/v1` | `tp-…` | `mimo-token-plan-cn` |
| Token Plan 新加坡 | `https://token-plan-sgp.xiaomimimo.com/v1` | `tp-…` | `mimo-token-plan-sgp` |
| Token Plan 欧洲 | `https://token-plan-ams.xiaomimimo.com/v1` | `tp-…` | `mimo-token-plan-ams` |

## 实施边界

本轮为三个 Token Plan 区域增加经过代码审查的目录项，并令 MiMo 按量和 Token Plan 均使用官方支持的 `api-key` 请求头。Gateway 仅在用户点击“连接并测试”后，把 API key 写入**当前 Gateway 进程内存**，自动执行一次 `/v1/models` 探测；它不会把密钥写入 SQLite、任务事件、HTTP DTO、浏览器状态、日志或 Git 仓库。

自定义 OpenAI/Anthropic 兼容模型继续支持用户明确输入的公开 HTTPS Base URL 与模型名。修复后，`session.custom-*` 的合法会话推理结果能被 Workbench 接受。为避免 Gateway 被利用为任意网络代理，仍拒绝 URL 凭据、HTTP、IP、localhost、私网/本地域名和完整操作路径；这不是模型连接功能的额外审批，而是对网络目标的输入完整性要求。

本轮不会要求用户额外登记、激活或手动打开测试页：保存连接本身即是对该 Provider 的明确本地操作意图，随即完成受限模型列表测试。聊天内容、模型推理、工具调用和系统/终端动作仍各自需要独立且明确的用户操作，不能因“已保存 API key”自动发生。

## 验证证据

用户授权的 `tp-` 密钥已对 Token Plan 中国集群完成两项最小验证：`GET /v1/models` 成功返回 6 个模型标识，其中包含 `mimo-v2.5-pro`；`POST /v1/chat/completions` 以 `api-key` 头收到成功响应，确认该密钥、区域端点和推理协议可达。密钥、原始响应和任何可识别凭据均未被写入本文档、测试、日志或版本控制。

回归覆盖包括：Token Plan 中国预置的 `/v1/models` 与 `/v1/chat/completions` 路径、`api-key` 鉴权、密钥/端点不回显、TP 配置后的探测与推理、以及自定义 `session.custom-*` 推理结果的前端接收与伪造 profile 拒绝。

## References

[1] [Xiaomi MiMo：首次调用 API](https://mimo.mi.com/docs/quick-start/first-api-call)  
[2] [Xiaomi MiMo：API 接入常见问题](https://mimo.mi.com/docs/zh-CN/quick-start/faq/api-integration)  
[3] [Xiaomi MiMo：Token Plan 快速接入](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)  
[4] [Xiaomi MiMo：AI 工具集成总览](https://mimo.mi.com/docs/en-US/tokenplan/integration/tools-overview)
