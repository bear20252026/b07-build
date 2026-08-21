# AFFiNE 启发的 Workbench 多层工作面契约

**状态：** 实施中
**日期：** 2026-08-22
**主要参考：** AFFiNE 的设置集中化、工作区内容组织和独立低频控制面。[1] [2]

## 1. 目标

AI Work OS 的首页必须保持为简洁的任务对话工作面。连接、产物、角色和低频控制不占据首页的长期布局；它们通过明确的入口进入独立的三级浮层。每个浮层都在背景模糊之上呈现，内部再分为局部导航、内容区和可选检查器。

| 工作面 | 入口 | 负责内容 | 禁止内容 |
| --- | --- | --- | --- |
| 主对话 | 默认首页 | 当前任务、简短上下文、可收起的编辑器 | Provider 表单、完整文件树、角色配置 |
| API 连接浮层 | 标题栏 API 图标或设置入口 | 选择 Provider、登记内存会话、手动测试与连接状态 | 任务事件、文件预览、自动调用 |
| 项目产物检查器 | 右上角“产物”图标 | 当前 task/run 的受控文件投影、预览、差异与交付包 | 任意本地文件系统浏览、未范围化文件 |
| Companion 窗口 | 标题栏角色图标 | 明确角色呈现状态、TTS 连接状态与“打开角色控制”动作 | 麦克风、屏幕捕获、系统自动化的隐式授权 |
| 角色控制三级页 | Companion 窗口中的设置入口 | 2D/VRM 选择、模型导入审查、角色卡和语音配置 | 将没有 VRM 资产的舞台标示为真实 3D 人物 |

## 2. Apple-first 视觉规则

界面使用系统优先的字体栈；避免下载字体成为首次加载依赖。浮层采用 20–24 px 连续圆角、半透明背景、克制阴影和不超过 180 ms 的位移/透明度过渡。颜色只增强层级与状态；连接、执行、权限和资产可用性均有可读的文本标签。

> 任何“3D 已上线”的显示必须同时满足：本地已审查模型资产可用、渲染器成功初始化、失败时存在可读错误提示。否则应显示“VRM 待导入”，并使用 2D 动态角色或明确的空状态回退。

## 3. 产物文件呈现契约

项目产物检查器只接收 `WorkbenchTaskFile`、`WorkbenchTaskFilePreview`、`WorkbenchTaskFileDiff` 和 `WorkbenchTaskDeliveryReceipt` 这几类已脱敏的 Gateway DTO。用户可看到 Markdown、代码、JSON 或其它受控投影；界面不读取本机路径，不枚举任意目录，不把文件内容混入聊天记录。

## 4. 归属与许可证

本实现以 AFFiNE 的公开产品信息架构为设计参考。若未来复制明确的 AFFiNE Community Edition 源文件，相关源文件、NOTICE 和分发材料必须保留其版权与 MIT 文本。[3] AFFiNE/BlockSuite 的独立 design 仓库采用 MPL-2.0，因此默认不复制其中的组件或主题源码；如复制，必须遵守该文件级许可证要求。[4]

WorkBuddy 截图仅用于用户明确指定的“右侧项目产物检查器”模式参考，不导入其代码、商标、品牌、角色或素材。

## References

[1]: https://docs.affine.pro/core-concepts/elements-of-affine/settings "AFFiNE Settings"
[2]: https://docs.affine.pro/core-concepts/elements-of-affine/workspaces "AFFiNE Workspaces"
[3]: https://github.com/toeverything/AFFiNE "AFFiNE GitHub Repository"
[4]: https://github.com/toeverything/design "AFFiNE/BlockSuite Design System Repository"
