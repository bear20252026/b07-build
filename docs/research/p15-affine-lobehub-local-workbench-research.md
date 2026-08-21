# P15：AFFiNE 页面系统与 LobeHub 本地工作台模式调研

**日期：** 2026-08-21

## 1. 研究结论与许可边界

AFFiNE 将文档、画布和表格定位为可合并的工作空间 building blocks，并声明 local-first、数据由用户磁盘持有，同时支持可选实时协作。[1] 其公开仓库是 MIT 许可，可作为理解模块划分和本地优先原则的参考；但本项目不直接引入 AFFiNE 的复杂编辑器、CRDT、服务端或品牌资源。

LobeHub 将 Agent 视为工作单元，并以任务、项目、页面、群组、工作区与可观察的 memory 为协作层次；其主仓库使用 LobeHub Community License。[2] 因此 P15 仅使用其产品结构与可见性原则，不复制主仓库代码、图形资源、品牌或服务端部署设计。

| 来源模式 | 对 AI Work OS 的采用 | 明确不采用 |
|---|---|---|
| AFFiNE 的块式工作台 | 任务由有边界的“上下文、计划、运行、产物、交付”块组成；块可折叠、可审查且来自真实 DTO | 通用无限画布、CRDT 同步、任意嵌入内容、远程账户/同步服务。 |
| AFFiNE 的 local-first | App Local Data 保存受控状态；UI 只消费本地 Gateway 的固定回环 API | 云优先数据库、浏览器直连第三方服务、隐式云同步。 |
| LobeHub 的 Agent 协作可见性 | 当前 task/run、权限模式、审批、产物文件和交付收据在同一工作面保持可见 | 后台自治、隐藏调度、远程 Agent 账号、服务端运行时。 |
| LobeHub 的项目/页面层次 | 在单任务范围内用块式上下文与交付物替代散乱事件文本 | 将本地单用户 Workbench 改造成多租户 Web 服务。 |

## 2. 仅本地 Gateway 的第三方 API 数据流

第三方 Provider 并不是“运行在本地”的模型本身；其 API 调用会从本机发往服务商。P15 的安全语义是：**调用的发起、凭据的暂存、请求的策略控制、任务编排、持久化和呈现全部在用户本机进行**，而 Provider 的响应经固定回环 Gateway 返回 WebView。API key 仅驻留 Gateway 进程内存，不进入 SQLite、任务事件、资料块、浏览器本地存储或返回 DTO。

```text
Workbench WebView
  └─ 仅 HTTP 到 127.0.0.1:4318
       └─ 本机 Gateway：会话内 credential、allowlist、能力/审批/预算策略
            └─ 第三方兼容 API（仅显式用户动作触发）
                 └─ 响应回到 Gateway，投影为脱敏 task/run DTO
                      └─ Workbench 只读地渲染任务块、文件和交付收据
```

## 3. 页面改进方向

P15 适合将现有任务主页从“首屏 + 时间线”的单列阅读流，收束为一组固定且有职责的任务块：任务概览块、连接 readiness 块、运行/审批块、活动块、交付物块。右侧 P13 Inspector 保持 task/run 文件的唯一审查入口；它不是任意文件浏览器。所有块使用现有黑白主题 token 和圆润 P14 表面，不导入新的配色或外部运行时依赖。

官方 AFFiNE 站点和文档在本次浏览环境返回访问限制，因此视觉研究改用其公开 GitHub README、目录结构与产品文字；不将受限网页的内容当作执行指令或事实依据。LobeHub 的公开 README 用于验证其 Agent、项目、工作区和可见 memory 的产品概念，不用于复制其 Community License 代码。

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE repository README and MIT license"
[2]: https://github.com/lobehub/lobehub "LobeHub repository README and Community License"
