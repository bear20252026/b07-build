# last30days、OpenWorker 与 AtomCode 联网、文件与终端能力核验

## 范围与版权边界

本记录只归纳公开项目的职责划分和用户体验，不复制其源代码、资源、凭据、爬虫规避逻辑、请求签名、浏览器 Cookie 或品牌。`mvanhorn/last30days-skill`、`Jesseovo/last30days-skill-cn`、OpenWorker 与 AtomCode 的仓库页面均标示 MIT 许可；若未来直接合并受许可代码、文件或资产，必须先逐文件保留其原有版权与许可文本，并完成兼容性审查。

| 参考项目 | 已核实的模式 | 对 AI Work OS 的可用结论 |
|---|---|---|
| [last30days-skill](https://github.com/mvanhorn/last30days-skill) | 多来源并行检索、来源可用性诊断、可选 API key / 浏览器会话、来源评分与带引用综合；默认可降级到可用来源。 | 搜索不应绑定单一模型 Provider；应有来源状态、诊断、失败原因和每条引用，而非一个静默按钮。 |
| [last30days-skill-cn](https://github.com/Jesseovo/last30days-skill-cn) | API → 可选浏览器自动化 → 公开接口 → 公开搜索引擎的分层降级；`--diagnose` 明示来源可用性、旧机器模式和失败路径。 | 中国站点检索需独立适配器与诊断页；不把单个爬虫/网站失败误报为“模型不支持联网”。本轮先修复通用 Web 检索，不接入平台爬虫。 |
| [OpenWorker](https://github.com/andrewyng/openworker) | 本机 agent server 统一承接模型、文件、终端、连接器和 MCP；任务、工具与外部副作用分层，命令与连接器在本机按用户选择运行。 | 附件必须有“描述符 → 读取/提取 → 限长内容 → 模型请求”的完整管线；终端应是本机真实工具，不应只是静态计划 UI。 |
| [AtomCode](https://atomgit.com/atomgit_atomcode/atomcode) | 会话持久化与恢复、上下文预算/压缩、文件路径作为上下文、`bash` / `web_search` / `web_fetch` 工具、后台会话和 per-session 权限。公开代码中 `web_search` 默认独立使用 Exa MCP，也可走 DuckDuckGo，不绑定 MiMo。 | 会话上下文需要预算、可见压缩策略和稳定恢复；联网检索、文件附件、终端执行都应记录为同一会话的真实活动，而不是伪造回答。 |

## 本轮架构决策

当前 AI Work OS 的独立 Exa MCP 搜索保留为通用第一级，MiMo 原生 Web Search 为可选后续适配器。搜索按钮需要改为明确的蓝色启用态并显示“准备 / 检索中 / 完成 / 无结果 / 失败”状态；任何搜索服务失败应显示可见原因与可尝试的降级路线。

聊天附件的当前问题是页面只保存文件名称、大小和 MIME 描述符，消息提交未将文件内容写入第三方 Provider 请求。文本型文件将改为用户提交时在 Tauri 原生层显式读取、按类型/体积限制提取、加上来源标签后作为本轮上下文；二进制、压缩包、PDF、Word 等不应谎称已被模型读取，必须呈现当前处理状态和下一步可选解析器。

终端能力将由用户在独立的终端工作面显式提交命令，Tauri 在当前 Windows 用户权限下启动子进程并返回 stdout、stderr、退出码及运行状态。普通命令不会被伪造为“待计划”；长运行命令需要能够取消。系统管理员提权、删除/覆盖大量文件、远程副作用和凭据目录触达仍保留一次明确确认，不以普通聊天静默获取系统管理员权限。

## 2026-08-23：用户提供的多后端搜索与工具调用建议核验

用户提供的“模型提出工具调用 → 桌面应用执行 → 将原始结果回传 → 模型完成回答”是可实施的标准代理职责分层。当前版本已实现用户显式点亮后的本地搜索与结果回传；后续工具调度将统一记录为会话活动，而不是要求每个第三方模型都原生具备联网能力。

公开资料确认，`mvanhorn/last30days-skill` 采用 MIT 许可，面向多来源的近期研究，支持零配置的部分来源与按需配置的平台连接；`Jesseovo/last30days-skill-cn` 同样采用 MIT 许可，并公开描述 API、浏览器自动化、公开接口和搜索兜底的分级运行方式。[1] [2] 这些项目适合参考的内容是**诊断、来源状态、分级降级、结构化引用和工具调度职责**。本项目不会直接导入其运行时、浏览器 Cookie、平台爬虫或依赖树；若未来逐文件复用 MIT 许可代码，必须保留对应文件的版权和许可文本。

用户附件中关于 Searchpin、国内多引擎 MCP 和 SearXNG 的具体“零配置/稳定性/覆盖率”描述尚未获得各项目官方仓库与实际 Windows 环境的逐项复核，因此不会作为已实现承诺。SearXNG 官方文档确认其可使用容器、安装脚本或逐步方式部署；MCP 官方规范确认远程工具在 `initialize` 成功后需发送 `notifications/initialized`，这一步已补入当前独立搜索适配器。[3] [4]

## 参考资料

[1] <https://github.com/mvanhorn/last30days-skill>

[2] <https://github.com/Jesseovo/last30days-skill-cn>

[3] <https://docs.searxng.org/admin/installation.html>

[4] <https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle>

## 来源

1. <https://github.com/mvanhorn/last30days-skill>
2. <https://github.com/Jesseovo/last30days-skill-cn>
3. <https://github.com/andrewyng/openworker>
4. <https://atomgit.com/atomgit_atomcode/atomcode>
