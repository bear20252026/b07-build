# P9：AionUi / AtomCode 工作台布局与交互研究

**日期：**2026-08-20
**目的：**针对用户反馈的“主页面过长、对话区被冷路径诊断卡片挤压、第三方 API 难以配置”问题，提炼参考项目中可迁移的信息架构原则。此文只记录独立观察和将采用的产品原则，不复制第三方业务代码。

## 参考材料与观察范围

| 参考项目 | 已审查材料 | 可迁移观察 |
|---|---|---|
| AionUi（Apache-2.0） | 官方仓库 `iOfficeAI/AionUi` 的 `Layout.tsx`、`Sider/index.tsx`、`ModelModalContent.tsx`；官方站点在本次浏览环境中仅呈现空白加载页，故不据此推断视觉细节 | 对话/工作区为主路由，设置为独立路由；侧栏根据当前路由替换为对应导航；模型 Provider 配置作为 Settings 子页面，采用“添加 Provider → 添加模型 → 可选健康检查”的逐层、按需展开流 |
| AtomCode（MIT） | 用户提供的 AtomGit 仓库以及本地只读参考副本；确认其 Rust `tuix` 中含 onboarding wizard、provider panel、model picker、config panel 等独立模块 | 配置流、模型选择、Provider 管理和会话操作应为独立、可发现的面板/向导，而非堆叠在主工作区；提供预设与受控自定义字段可减少新手输入 |

## AionUi 源码中的具体布局原则

AionUi 的顶层 `Layout` 采用稳定的三层结构：固定标题栏、可折叠侧栏、路由驱动的主内容区。对话页内部可在需要时增加项目浏览器和预览区，但它们是与主内容区并列的可收起区域，而不是把所有运行时控制面板连续堆叠到聊天流下方。

其 `Sider` 将“新建对话、助手、计划任务、可滚动历史”放在非设置路由中；进入 `/settings/*` 后，侧栏会替换为 `SettingsSider`。设置入口不是在聊天页内追加卡片，而是一个明确页面状态。模型配置页面使用页面标题、一个“添加模型/平台”主操作、空状态帮助、Provider 折叠项及每个模型的受限操作；健康检查为可选按钮而非默认自动动作。

## 本项目应采用的页面重排

| 目前问题 | 改版原则 | 目标交互 |
|---|---|---|
| 首页堆叠运行轨迹、控制面诊断、审计、构件、原生宿主、发布证据和本地模型卡片 | 主工作区只保留当前会话、任务 composer、紧凑状态摘要和必要的下一步 | 用户打开应用后立即看到对话和“连接模型”行动，而不是需滚动越过冷路径卡片 |
| 第三方 API 配置需要理解 Gateway、环境变量、Profile 等内部概念 | 以“模型连接”作为设置首要入口，采用 Provider 预设和最小字段表单 | 新用户选择常用 OpenAI-compatible 或 Anthropic-compatible，再填写显示名称、实际模型名、API key；其余字段预填或收在“高级设置” |
| 诊断错误 `Failed to fetch` 与 HTML JSON 错误在主页面中直接出现 | 提供可读的设置向导状态：未启动、无法附着、CORS/地址错误、密钥缺失、测试失败；给出下一步操作 | 失败状态有“启动说明”“重试”“查看高级诊断”而非只显示原始异常 |
| 现有入口不形成页面跳转 | 以主侧栏/顶部入口在“工作区”“模型连接”“运行记录”“安全与系统”之间切换 | 每个入口改变主内容页；设置内含二级导航，避免把所有设置展示在同一长页 |

## 适配约束

本项目继续遵循既有安全约束：桌面启动不自动连接 Gateway；使用者必须显式操作；API key 不进入 SQLite、Profile、事件或浏览器 DTO。要支持用户所需的手动 API key 表单，必须新增一个经用户确认的**本机凭据保管端口**；不能把 key 发送到 Workbench 的普通 HTTP DTO 或仅写入环境变量说明中。该端口应与 Provider Profile 解耦，且应仅暴露脱敏存在状态。

## 参考链接

1. [AionUi GitHub repository](https://github.com/iOfficeAI/AionUi)
2. [AtomCode AtomGit repository](https://atomgit.com/atomgit_atomcode/atomcode)
3. [AionUi layout source](https://github.com/iOfficeAI/AionUi/blob/main/packages/desktop/src/renderer/components/layout/Layout.tsx)
4. [AionUi model settings source](https://github.com/iOfficeAI/AionUi/blob/main/packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent.tsx)

## 本地 Workbench 实际页面验证（P9 实现中）

在本地 Vite Workbench 中验证了新结构。默认工作区已只显示欢迎区、显式 Gateway 状态、任务快照、紧凑控制面摘要、活动列表和固定 composer；原先的 Provider、扩展、审计和发布证据卡片已不再出现在首页。侧栏“模型连接”可正常切换到独立页面，页面中存在四个可点击的预设卡片（OpenAI-compatible、Anthropic/Claude、Gemini、OpenRouter）、显示名称输入、实际模型 ID 输入、密码型 API key 输入以及“保存并启用连接”按钮。

该独立页面在当前 877px 宽的验证窗口中可正常呈现而未出现白屏；模型配置区需要向下滚动才显示高级连接状态，符合将冷路径放在第二层的目标。仍应在后续质量阶段检查桌面壳实际安装包中的同等交互，并可继续压缩标题栏的 Agent Profile 控件，避免小尺寸窗口的首屏拥挤。

进一步验证后，非工作区页面改为“侧栏 + 全宽主内容”两栏布局，并隐藏交付预览右栏；模型连接向导在 877px 宽的普通窗口中可完整显示四个协议/供应商预设、三项最小输入和显式 Gateway 附着按钮，页面下方只保留作为次级内容的高级连接状态。默认启动页现为模型连接页，符合“先配置第三方 API、再进入工作区”的新手路径。
