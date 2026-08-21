# 浏览自动化与 AFFiNE 分层设置对标笔记

**日期：** 2026-08-21

## 上游核验摘要

| 项目 | 公开许可 | 可借鉴模式 | 不直接引入的假设 |
| --- | --- | --- | --- |
| browser-use | MIT | 浏览会话、逐步动作、暂停/人工接管讨论、可扩展自定义工具 | 托管浏览器、代理轮换、CAPTCHA 绕过和持久化云端 profile。 |
| Midscene.js | MIT | 截图驱动的 `act/query/assert` 分层，视觉定位与可见结果断言，适合之后的 GUI 测试适配器 | 直接安装完整视觉自动化运行时或让视觉模型绕过现有审批。 |
| UI-TARS Desktop | Apache-2.0 | 浏览器/桌面操作器分离、实时事件流、视觉/DOM 混合策略、会话状态反馈 | 无提示地接管整机、远端电脑与浏览器控制、MCP 直接授予高风险能力。 |
| Vision Skill | 未在仓库摘要中声明 SPDX 许可证；需在复用前逐文件核验 | OpenAI-compatible VLM 配置、异步任务元数据、失败重试与强制确认思想 | 外部 COS 上传、API key 配置文件、后台 worker 和未经审查的脚本。 |

## 设计结论

AI Work OS 应首先落地 **浏览授权控制面**，而非直接嵌入任意浏览器或桌面操控框架。每个浏览会话必须具备：用户显式发起、目标范围、会话标识、状态机（`requested`、`running`、`paused`、`ended`、`failed`）、即时暂停、结束、只读审计投影和不含页面正文/密钥的事件收据。初版不会启用网页表单提交、支付、下载、凭据读取、文件上传或整机鼠标键盘控制。

用户提供的 AFFiNE 截图表明当前 Workbench 的“设置页面替换中心内容”层级感不足。改造方向应采用：桌面背景保留主工作区作为被遮罩的上下文层；设置为独立大圆角浮层；浮层内部左栏承担设置分类，右侧承载对应内容；三级页在右侧内容中显示返回二级页的面包屑/返回控件，而非回退到首页。视觉 token 应使用更明确的层次：遮罩、容器、分组容器、可点击行、选中状态、主按钮、危险结束按钮和可访问焦点。

## 来源

[1] https://github.com/browser-use/browser-use
[2] https://github.com/web-infra-dev/midscene
[3] https://github.com/bytedance/UI-TARS-desktop
[4] https://github.com/lgwanai/vision-skill
[5] https://github.com/toeverything/AFFiNE
