# 2026 架构对标：AFFiNE 与 LobeHub

**日期：** 2026-08-21
**作者：** Manus AI

## 已验证的参考模式

AFFiNE 将自身定义为由可组合 building blocks 组成的工作区操作系统，并将文档、画布和表格作为统一工作表面。其 2026 年公开更新还显示了 AI BYOK、日历/数据库视图、本地索引与 CJK 模糊搜索、大附件可恢复上传、代码/图表预览、同步兼容性和编辑器性能等持续投资。[1] [2]

这说明对 AI Work OS 最值得借鉴的不是把完整通用文档/画布编辑器嵌入聊天产品，而是采用其原则：**对象有稳定类型、视图由对象投影、局部功能可独立进化、重型能力延后进入受控页面**。

LobeHub 的公开定位强调以 Agent 为工作单元，围绕招募、调度、汇报以及 Agent 的组织来构建操作表面；其 2026 年公开更新列表提到 task delivery checks 和主页对 Agent 状态的追踪。[3] [4]

这对应 AI Work OS 的本地化方向：每个 task/run 必须拥有可恢复状态、可审查成果、显式权限和可交付判定；不能将多 Agent 并行、远程云执行或隐式计划引入现有本机受控边界。

## 许可证边界

AFFiNE Community Edition 在其 README 中说明为 MIT；若逐文件移植，实现中需要保留版权和许可证文本。LobeHub 主仓的具体许可须按目标文件核验；在未核验可复用文件前，只采用信息架构、产品行为与模块职责模式，不复制其主产品实现或品牌资源。

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE GitHub README"
[2]: https://affine.pro/what-is-new "AFFiNE Product Updates"
[3]: https://lobehub.com/ "LobeHub"
[4]: https://lobehub.com/changelog "LobeHub Changelog"
