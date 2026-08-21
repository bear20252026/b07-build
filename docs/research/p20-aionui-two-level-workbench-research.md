# P20：AionUi 两级 Workbench 导航参考调研

**日期：** 2026-08-21
**作者：** Manus AI
**目标：** 以 AionUi 的公开首页/设置页职责划分为参考，将 AI Work OS 改造成轻量聊天首页与独立设置工作区，同时不改变本机 Gateway、受控执行和 Windows 桌面边界。

## 1. 官方许可与复用边界

AionUi 官方仓库将项目标为 Apache-2.0。[1] 该许可允许复制、修改和分发，但要求在分发的衍生作品中携带许可证、保留与所涉部分相关的版权、专利、商标和归属声明；若上游包含 `NOTICE`，还须在可读位置保留相应归属说明。[2]

| 处理对象 | P20 决策 |
| --- | --- |
| AionUi 产品与商标 | 仅作为架构和交互参考；不使用 AionUi 名称、Logo、图标、头像或品牌色来暗示关联。 |
| AionUi 主侧栏/设置侧栏源代码 | P20 先以原创组件实现相同的职责分层，不直接搬运依赖其内部设计系统、图标库、路由器或 i18n 状态的文件。 |
| 未来确定复制的 Apache-2.0 文件 | 必须保留原始版权头与 SPDX 标记，在仓库根部附带 Apache-2.0 许可证副本，并在 `THIRD_PARTY_NOTICES` 记录来源、路径、上游 commit 和修改说明。 |

> Apache-2.0 许可允许复用，但并不自动授予 AionUi 商标或品牌资产的使用权。[2]

## 2. 可验证的页面职责划分

用户提供的两张截图与官方 Quick Start 说明相互印证：首页的目标是尽快开始新会话和选择已可用模型；复杂模型配置则通过侧栏底部的 Settings 进入，并可从设置页返回聊天。[3]

官方 `SiderFooter.tsx` 明确将页脚入口表达为二态控件：普通聊天页显示 Settings 图标/标签，设置态显示返回箭头/Back；同一回调在两种状态之间切换。[4] 官方 `SettingsSider.tsx` 将复杂设置分为 AI core、app、archived、about 等组，并把每个条目映射到独立 settings path。[5] `SettingsModal` 也把模型、工具、WebUI、系统、关于等低频控制放在单独容器，而不是首屏聊天区。[6]

| AionUi 模式 | AI Work OS P20 本地化 | 保持不变的安全限制 |
| --- | --- | --- |
| 首页少量高频入口 | 首页仅保留新任务、工作区、模型连接、当前助手与底部设置。 | UI 不直接连接 Provider、SQLite、文件系统或系统进程。 |
| 左下角 Settings | 将当前多页管理项全部迁入 `settings` 态；设置入口位于主侧栏页脚。 | 进入设置不会附着 Gateway、调用模型或读取 API key。 |
| Settings 侧栏有分组 | 设置态显示 AI Core（模型/已连接模型）、Workspace（运行记录/扩展）、System（安全与系统）三个低频分组。 | 每一页继续消费既有只读 DTO/受控 intent，不创建新的后端 route。 |
| Back to chat | 设置态页脚显示返回聊天，恢复最小首页。 | 只是前端导航，不改变任务运行状态或权限。 |

## 3. P20 的明确非目标

P20 不复制 AionUi 的完整 Agent engine、CLI 自动检测、远程访问、工具执行模型、图标库、主题实现、路由器或资产。特别是，AionUi README 所描述的全文件访问/自动化能力不改变本项目现有的显式审批、Gateway 策略与 Windows only 受信边界。[1]

## 4. 参考资料

[1]: https://github.com/iOfficeAI/AionUi "AionUi 官方仓库与 README"
[2]: https://github.com/iOfficeAI/AionUi/blob/main/LICENSE "AionUi Apache License 2.0"
[3]: https://github.com/iOfficeAI/AionUi/wiki/Getting-Started "AionUi Getting Started：Settings → Models 与聊天入口"
[4]: https://github.com/iOfficeAI/AionUi/blob/main/packages/desktop/src/renderer/components/layout/Sider/SiderFooter.tsx "AionUi SiderFooter 源码"
[5]: https://github.com/iOfficeAI/AionUi/blob/main/packages/desktop/src/renderer/pages/settings/components/SettingsSider.tsx "AionUi SettingsSider 源码"
[6]: https://github.com/iOfficeAI/AionUi/blob/main/packages/desktop/src/renderer/components/settings/SettingsModal/index.tsx "AionUi SettingsModal 源码"

## 5. P20 首屏验证与修复发现

浏览器预览确认默认入口已切换为轻量聊天首页：左侧仅保留工作区与左下角 Settings，主区域仅显示欢迎、Profile、模型入口、建议任务和输入岛；未渲染右侧 Inspector、故事板、运行轨迹或运维面板。设置仍由明确按钮进入。

验证同时发现 `AgentProfileId` 的运行时枚举比双语 `profile` 目录多出一个未在目录声明的值，导致首页按 `Object.keys(profiles)` 直接映射时出现空 Profile 卡片。P20 将改用显式 allowlist（`build`、`plan`、`explore`、`reader`）渲染 UI Profile；这与现有可见 Profile 和安全策略一致，避免把管理员或未来内部类型意外暴露为用户可点击选项。

修复后浏览器验证：首页仅渲染 4 个明确 Profile（Build、Plan、Explore、Reader），空白卡片已消失；页面没有右侧 Inspector 或任务故事板。点击左下角 Open settings 后，模型连接与其余复杂条目显示在独立 Settings 态的分组侧栏中，顶部与底部均提供 Back to chat。验证结果符合「首页高频、设置低频」的两级信息架构；进入设置没有附着 Gateway 或发起 Provider 调用。

交互补充验证：从 Settings 返回聊天后仍保持轻量首页；点击建议任务仅将文本写入本地 composer 并聚焦输入框，未提交任务、未附着 Gateway、未请求 Provider。该行为与首页“先写目标，再由用户显式开始任务”的安全边界一致。
