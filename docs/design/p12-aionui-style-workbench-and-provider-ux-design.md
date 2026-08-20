# P12：AionUi 风格 Workbench 与第三方模型连接体验重构

状态：已批准实施

## 1. 目标

P12 修复 Workbench 当前“所有状态都堆在主页面”的信息架构问题。主工作区只承担对话、任务状态、模型选择和必要审批；运行轨迹、模型健康、扩展、控制面诊断、安全审计和 Windows 证据全部移动到设置的二级页。

模型连接保持为默认首屏，但页面不再把新手配置与高级测试中心纵向堆叠。用户按**选择兼容协议 → 选择服务预设 → 填显示名称、模型名称、API key → 保存 → 显式测试**完成连接。该流程借鉴 AionUi 的 `Settings → Models → Add Model` 路径与 AtomCode 的“主对话中只选择已配置模型、配置放入设置”的分离方式。[1] [2] [3]

## 2. 页面模型

| 区域 | 页面 | 用户看到的内容 | 禁止出现的内容 |
|---|---|---|---|
| 工作区态 | 工作区 | 欢迎/空会话、任务对话、当前模型、任务状态、审批、预览 | 控制面审计、发布证据、扩展诊断、本地模型健康长卡片、Provider 表单 |
| 设置态：AI Core | 模型连接 | 协议切换、预设服务、三字段表单、连接结果与“去测试”按钮 | 运行轨迹、安全审计、扩展详细控制 |
| 设置态：AI Core | 已连接模型 | 状态、启用、显式模型目录测试、单次受限文本试用 | API key、端点编辑、自动测试 |
| 设置态：运行 | 运行记录 | P11 产出与检查点账本、不可复放轨迹 | 配置表单、隐私/安全管理动作 |
| 设置态：能力 | 扩展与能力 | Extension Center、可选本地模型健康摘要、控制面概览 | 密钥、自动激活、任意进程控制 |
| 设置态：系统 | 安全与系统 | 安全态势、lockfile、宿主认证、Windows 发布证据 | 自动修复、自动信任、自动执行 |

## 3. 导航交互

参考 AionUi，左侧栏具有两种明确状态：

1. **工作区态**：新任务、工作区、模型连接快捷入口、会话/项目摘要和底部“设置”。
2. **设置态**：返回工作区、模型连接、已连接模型、运行记录、扩展与能力、安全与系统。切换设置项不清空当前任务、草稿或已附着 Gateway；返回工作区保留原任务上下文。

默认规则：如果没有已附着 Gateway 或没有活跃的第三方模型连接，打开应用时显示“模型连接”；否则显示工作区。P12 在前端保持模型连接默认首屏，后续版本可将“已有已启用连接”的持久化状态作为工作区默认条件。

## 4. 新手连接路径

| 步骤 | 交互 | 默认 | 成功结果 |
|---|---|---|---|
| 0. 附着 | “启动并附着 Gateway” | 不自动启动 | 显示“本机服务已就绪”；连接按钮可用 |
| 1. 协议 | `OpenAI-compatible` 或 `Anthropic-compatible` | OpenAI-compatible | 过滤/突出对应预设；不要求填写 endpoint |
| 2. 服务 | OpenAI、DeepSeek、Gemini、Mistral、OpenRouter 或 Anthropic | OpenAI | 填充规范显示名和公开默认模型示例 |
| 3. 三字段 | 显示名称、实际模型名称、API key | 显示名与模型示例已预填；API key 空 | 用户只需改成账户实际模型和粘贴 key |
| 4. 保存 | “保存并启用” | 显式点击 | Key 写入 Gateway 会话内存；Profile 显式登记与启用；显示连接已准备好 |
| 5. 测试 | “测试连接” | 不自动发请求 | 仅发一次受限模型目录 probe；显示可行动状态，不显示原始 HTML/JSON 解析错误 |

## 5. 协议与安全边界

本轮“兼容协议”是**已审核 provider catalog 的显示与筛选模型**，不是让浏览器输入任意 URL。现有 catalog 只允许代码审查过的 HTTPS base URL；这是防止 WebView 把本机 Gateway 变为任意网络代理或 SSRF 通道的必要边界。

自定义服务在本轮展示为“需要受控接入”的入口：用户可选择 OpenAI-compatible 或 Anthropic-compatible 的产品需求，但只有当对应 provider 进入经过审查的目录后才可连接。API key、显示名和模型选择继续遵循既有边界：key 只在 Gateway 会话内存中，显示名/模型仅作为会话 presentation metadata，不能进入任务事件、SQLite Profile、快照、账本或响应 DTO。

## 6. 错误呈现规则

所有 WebView 端错误先经 `gatewayErrorText` 归一化。对 `Failed to fetch`、HTML 误响应和 JSON 解析错误，界面只显示以下可行动提示之一：

- “请先点击‘启动并附着 Gateway’，再保存连接。”
- “本机 Gateway 已启动但暂未就绪；请等待后重试。”
- “测试请求未收到供应商的有效响应。请检查 API key、模型名称和该服务的可用状态。”

不将 `<!DOCTYPE...`、`Unexpected token`、endpoint、header、key 或原始异常正文显示在新手向导中。高级运行记录可保留脱敏 outcome 分类，但不保留敏感正文。

## 7. 验证策略

新增 Workbench 侧栏测试覆盖工作区态/设置态切换与点击目标；Provider Setup 测试覆盖协议过滤、预填、三字段提交、错误归一化、成功后的高级管理跳转；现有 provider SDK 测试继续证明快速配置会登记并启用 Profile，但 key 绝不持久化。全量 TypeScript、架构、跨语言与 Windows 安装器质量门必须通过。

## References

[1] [AionUi Getting Started — 模型设置与首个对话](https://github.com/iOfficeAI/AionUi/wiki/Getting-Started)

[2] [AionUi LLM Configuration — 预设平台与 Custom OpenAI-compatible 模型说明](https://github.com/iOfficeAI/AionUi/wiki/LLM-Configuration)

[3] [AtomCode Documentation — first-run model configuration and sessions](https://atomcode.atomgit.com/docs/en/)

[4] [P12 research — AionUi/AtomCode 源码级信息架构调研](../research/p12-aionui-atomcode-workbench-information-architecture.md)
