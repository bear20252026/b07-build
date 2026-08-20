# P9：Workbench 分层与第三方模型接入向导设计

## 目标

将当前“所有可观测性与连接卡片均堆叠在首页”的实现调整为对话优先工作台。默认用户先看到可写入的任务/聊天区域、模型状态与一个明确的“添加模型”入口；高级运行记录、安全审计、组件证据和本地模型健康度移入设置二级页。该结构参考 AionUi 的“稳定外壳 + 路由内容 + 设置专属侧栏”模式，以及 AtomCode 的“Provider/Model 独立管理面板、协议预设、分步表单”模式。[1][2]

## 页面信息架构

| 一级页面 | 默认内容 | 二级内容 | 用户动作 |
|---|---|---|---|
| 工作区 | 欢迎/当前任务、紧凑 Gateway 状态、事件摘要、固定 composer | 当前任务的轨迹和审批只在有任务时展开 | 新建任务、选择 Agent Profile、提交/继续/审批 |
| 模型连接 | Provider 卡片、快速添加向导、当前默认模型 | 已配置连接、连通性测试、单次文本试用、可选高级参数 | 选择供应商/协议、填显示名/模型名/API key、保存到本次 Gateway 会话、启用、测试 |
| 运行记录 | 控制面健康、任务轨迹、扩展管理 | 本地模型健康、调度与诊断详情 | 只读查看、显式刷新 |
| 安全与系统 | 安全态势、锁文件、构件管理、原生宿主、Windows 发布证据 | 高级诊断说明 | 只读查看、无自动修复 |

左侧主导航使用 `工作区 / 模型连接 / 运行记录 / 安全与系统`。设置类页面有页面内二级导航；它们替换主内容，而不在工作区底部持续渲染。点击“添加模型”直接进入模型连接页并聚焦向导。

## 新手模型连接向导

默认顺序是第三方 API 而非本地模型。首屏展示已审核供应商预设（OpenAI、Claude、Gemini、DeepSeek、Mistral、OpenRouter）以及两种通用协议：**OpenAI-compatible** 与 **Anthropic-compatible**。当前目录预设优先提供默认 endpoint 和模型；用户只需填写：

1. 给这条连接起一个显示名称；
2. 填写实际模型 ID；
3. 粘贴 API key。

当选择通用兼容协议时，向导显示“高级：服务地址”字段；此字段默认折叠，且仅接受 HTTPS URL 或明确定义的本机 loopback。默认 endpoint 和协议选择绝不覆盖用户手动填写的值，遵循 AtomCode Provider 表单“预设只填空字段”的原则。[2]

## 凭据与持久化边界

Provider Profile 和 SQLite 账本继续只保存 `credentialReference`，不保存 API key。为了让新手表单可直接使用，Gateway 将拥有一个明确的**会话凭据保管器**：API key 通过用户点击触发的单向回环请求进入 Gateway 进程内存，按已审核 Provider reference 暂存，只向外暴露 `available/missing` 状态；不返回、记录、持久化或写入任务事件。Gateway 退出后，会话 key 自动失效，用户可选择使用既有环境变量作为持久的高级选项。

HTTP 路由不得读取环境变量、创建数据库或写日志中的 secret。Workbench 只会从密码输入框发送 key，随后立即清空输入框；任何 API、错误投影和浏览器 DTO 均不得回显 key、长度、endpoint header 或原始供应商错误正文。

## Gateway 附着与失败诊断

桌面仍默认不启动或连接任何后台服务。模型页面把“附着本机 Gateway”置于第一项，并根据失败类型给出用户可操作的文案：未启动、网络/CORS 不可用、凭据缺失、Provider 未登记、连通性被拒绝。原始 `Failed to fetch` 或 HTML 解析错误只放在“高级诊断”详情内，默认提示下一步，而不是令新手自行理解网络栈。

## 验收条件

1. 首页在 960px 高度内始终能看到对话 composer，不再要求滚过安全/诊断卡片。
2. 点击侧栏“模型连接”显示一个明确的模型设置页；首页没有 Provider 卡片堆叠。
3. 新手可从预设中选择 OpenAI 或 Anthropic 兼容协议，并在最少三项输入后完成保存、启用、测试。
4. API key 不进入 SQLite、Provider Profile、任务事件、返回 DTO、日志或 UI 状态之外的持久化位置。
5. Gateway 未启动时显示可操作诊断，不显示裸 `Failed to fetch`。
6. 现有严格 CSP、无特权 IPC、显式 Gateway 附着和权限边界回归测试持续通过。

## References

[1] [AionUi Layout](https://github.com/iOfficeAI/AionUi/blob/main/packages/desktop/src/renderer/components/layout/Layout.tsx)

[2] [AtomCode Provider Panel](https://atomgit.com/atomgit_atomcode/atomcode)
