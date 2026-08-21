# AFFiNE 与 Apple-first 工作面参考核验（2026-08-22）

## 采用范围

本轮以 **AFFiNE** 作为主要的信息架构与交互层次参考；用户提供的 WorkBuddy 截图只用于“右侧项目产物检查器”这一单一模式，不作为整体视觉或源码参考。

| 公开来源结论 | AI Work OS 的本地化采用 |
| --- | --- |
| AFFiNE 的设置将外观、快捷键、关于、工作区与账户等低频控制集中管理，而不是堆在主工作面中。[1] | 首页只保留任务、对话和少量明确入口；API、角色与产物进入独立三级悬浮检查器。 |
| AFFiNE 以 Workspace 组织文档与工作内容，且可区分本地与云端工作区。[2] | 当前任务的产物以只读文件投影呈现，并明确标记来源、类型和可审查范围，不能被聊天文本替代。 |
| AFFiNE 仓库公开标注 Community Edition 使用 MIT 许可证。[3] | 如直接采用明确来源的 CE 源文件，须保留版权及 MIT 许可；本轮优先复刻信息架构与视觉原则，不引入 AFFiNE 运行时。 |
| AFFiNE/BlockSuite 独立设计系统仓库使用 MPL-2.0，而非 MIT。[4] | 不复制其设计系统源码或主题包；若未来按文件级复制，必须遵守 MPL-2.0 的源代码提供与通知义务。 |

## 设计契约

> 首页是专注任务的工作表面，不是设置目录。三级信息应作为独立的、带背景模糊的浮层打开；浮层内部采用左侧类别导航、中央内容与可选右侧检查器的职责分离。

Apple-first 细化为：系统字体优先、低饱和中性色、清晰单一主操作、18–24 px 连贯圆角、三层 surface 阴影、可见键盘焦点、短动效，且任何安全、执行或连接状态均以文本明确表达而非仅依赖颜色。

## References

[1]: https://docs.affine.pro/core-concepts/elements-of-affine/settings "AFFiNE Settings"
[2]: https://docs.affine.pro/core-concepts/elements-of-affine/workspaces "AFFiNE Workspaces"
[3]: https://github.com/toeverything/AFFiNE "AFFiNE GitHub Repository and License"
[4]: https://github.com/toeverything/design "AFFiNE/BlockSuite Design System Repository and MPL-2.0 License"
