# DESIGN.md 来源、许可与适用边界

**日期：** 2026-08-22
**用途：** 为 AI Work OS 的前端设计、人工评审和受控 UI 设计角色建立可追溯的参考依据。

## 结论

本项目采用 **Apple 设计语言为唯一主视觉基线**，而不是将多个品牌风格拼贴到同一界面。当前项目根目录的 `DESIGN.md` 由用户指定的 `npx getdesign@latest add apple` 命令生成；它是对公开 Apple 页面可观察模式的独立分析，并非 Apple 官方设计文件。Apple 官方 Human Interface Guidelines（HIG）则是可用性、可访问性、平台适配和字体使用的优先规范。[1] [2]

Linear 与 Raycast 的 DESIGN.md 已保存在 `docs/design/reference-systems/`。两者仅作为**局部交互模式库**：Linear 提供深色信息密度、表面阶梯和克制的边框层级；Raycast 提供命令面板、键帽提示与键盘优先的快速操作模式。两者的品牌颜色、标志性渐变、字体和产品外观不得成为 AI Work OS 的主视觉身份。[3] [4]

| 资料 | 本地位置 | 允许吸收 | 明确不吸收 |
| --- | --- | --- | --- |
| Apple DESIGN.md | `/DESIGN.md` | 克制的单一主操作色、SF 系统字体优先、清晰排版、8px 节奏、圆角层级、材料感浮层 | Apple 商标、Logo、产品渲染、营销页面的照搬布局 |
| Apple HIG | 官方网页 | 无障碍、文本可读性、键盘和触控目标、颜色之外的状态表达、减少动态效果 | 将 macOS/iOS API 或系统资产误认为 WebView 可直接使用的资源 |
| Linear DESIGN.md | `docs/design/reference-systems/linear/DESIGN.md` | 表面阶梯、发丝边框、稠密列表和只在代码语义中使用等宽字体 | 薰衣草品牌色、暗色营销站身份、专有字体和品牌 UI |
| Raycast DESIGN.md | `docs/design/reference-systems/raycast/DESIGN.md` | 命令面板行、键帽提示、快捷操作的紧凑层次 | 红色条纹渐变、白色主 CTA、Inter `ss03` 品牌字形、扩展商店外观 |

## 可验证原则

Apple HIG 将清晰、可读、可适配和一致的交互作为基础。它强调系统字体、可访问字号、层次表达、足够的前景/背景对比度、不能只以颜色传达状态、可通过键盘操作，以及在降低动态效果时减少自动动画。[1] [2]

因此，AI Work OS 的实现优先级如下：首先保持首页只包含任务发起、项目入口、工作方式和模板；其次将复杂控制面放入可关闭的分层设置空间；最后以可见文本、颜色、图标/形状和禁用原因共同表达受控执行状态。所有主操作采用一条蓝色行动语义，暂停、结束、失败仍采用语义色，但绝不以颜色单独授予或暗示权限。

## 许可与归因

`awesome-design-md` 仓库声明为 MIT；其 README 同时说明各 DESIGN.md 是从公开可观察样式提取的参考文档，并不拥有各品牌视觉身份。getdesign 的 Apple 页面也声明其内容为独立分析，未获 Apple 背书。[3] [5]

本项目不复制 Apple、Linear 或 Raycast 的商标、图标、页面截图、专有字体文件或品牌资产。文档只用于学习和指导原创界面实现。若后续引入任何上游源码、字体或资产，必须先核验对应文件的许可并在 `THIRD_PARTY_NOTICES.md` 中记录。

## References

[1] [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines)

[2] [Apple HIG: Typography](https://developer.apple.com/design/human-interface-guidelines/typography)；[Apple HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)

[3] [VoltAgent — awesome-design-md README and MIT notice](https://github.com/VoltAgent/awesome-design-md/blob/main/README.md)

[4] [Linear DESIGN.md catalog entry](https://getdesign.md/linear.app/design-md)；[Raycast DESIGN.md catalog entry](https://getdesign.md/raycast/design-md)

[5] [getdesign.md — Apple design analysis](https://getdesign.md/apple/design-md)


## 本地渲染验证

在本地 Workbench 预览中，首页仍仅展示任务发起、项目入口、工作方式、模板和模型连接摘要。左下角设置入口打开独立浮层；进入“扩展与能力”后再进入“预置专业角色”，可见 `UI Designer · Apple-first 设计简报`。该简报列明 Apple HIG 主基线、Linear/Raycast 的限定辅助模式以及“不会自动注入、授权、读取密钥或改变工具能力”的边界。

浅色界面已改用行动蓝作为普通主操作和键盘焦点，表面使用白色、暖灰白和发丝边框；角色简报采用独立的圆角、轻量表面层级。视觉验证未显示任何新增的首页复杂控制或对浏览器、Provider、任务执行边界的改动。
