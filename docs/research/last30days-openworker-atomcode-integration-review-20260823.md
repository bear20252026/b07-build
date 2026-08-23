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

## 来源

1. <https://github.com/mvanhorn/last30days-skill>
2. <https://github.com/Jesseovo/last30days-skill-cn>
3. <https://github.com/andrewyng/openworker>
4. <https://atomgit.com/atomgit_atomcode/atomcode>
