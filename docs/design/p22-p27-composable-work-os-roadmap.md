# P22–P27：可拼接 AI Work OS 演进路线

**日期：** 2026-08-21
**作者：** Manus AI
**状态：** 已立项；按里程碑独立实现、验证、提交与来源证明

## 1. 总体目标

在 P20 的双层导航和 P21 的 task/run 成果块之上，把 AI Work OS 扩展为可拆卸、可组合、可恢复的个人工作系统。所有新能力都必须服从同一条单向数据管道：

```text
Workbench UI intent
  → typed local HTTP client
  → fixed-loopback Gateway route
  → application/domain service
  → SQLite adapter / recoverable runtime
  → versioned DTO / event
  → pure projection
  → React block or page
```

React 组件不能创建数据库、读取环境变量、启动进程、读取文件或直连 Provider。页面只消费脱敏 DTO 和发出显式 intent。所有写入操作必须经本机 Gateway 的固定 loopback 路由、版本化请求、幂等键和领域服务验证；所有 API key 只以 `credentialReference` 或会话内存形式存在。

## 2. 上游参考与版权决策

| 上游 | 可借鉴内容 | 许可证结论 | P22–P27 的处理方式 |
| --- | --- | --- | --- |
| AFFiNE | 页面承载工作上下文、构件式信息组织、命令/导航的渐进披露。 | Community Edition 当前声明为 MIT。[1] [2] | 默认使用原创组件。若后续逐文件复用可确认的 MIT 源文件，保留原版权头、完整 MIT 文本、来源 URL/commit 与修改说明。 |
| LobeHub | 将 Agent、任务、项目、资源和任务模板按明确对象职责拆分的产品模式。 | 主产品为 LobeHub Community License，衍生作品分发存在额外条件。[3] [4] | **不复制或移植主仓源码、样式、图标、品牌或依赖。** 仅采用高层产品模式，全部重新实现。 |

## 3. P22–P27 可拼接模块地图

| 里程碑 | 新模块 | 输入 | 输出 | 禁止承担的职责 |
| --- | --- | --- | --- | --- |
| P22 | `task-page-projection`、`TaskPage`、typed work blocks | 既有 task/run snapshot、events、trajectory、files、deliveries | 页面标题、状态、块列表、只读摘要 | 不能请求 Gateway、创建 ZIP、读取文件正文或授予审批。 |
| P23 | `command-catalog`、`command-projection`、`CommandPalette` | 纯本地导航命令与现有页面/task 标识 | 选中导航/聚焦 intent | 不能执行 Shell、Provider、文件或任务操作。 |
| P24 | `project-domain`、SQLite project store、project route/client、`ProjectBoard` | 显式项目 CRUD intent 与 task/run 归属 | 版本化项目/成员关系 DTO | 不能保存密钥、文件内容、绝对路径或替代 task ledger。 |
| P25 | `work-mode-projection`、`WorkModeCard` | 已有 profile、authority、provider connection 脱敏摘要 | 任务前的显式选择 intent 与审计 metadata | 不能隐式选择模型、探测 Provider 或自动启用工具。 |
| P26 | `task-template-catalog`、`TaskTemplatePicker` | 静态模板目录 | 本地填充 composer 的 draft/profile/authority 建议 | 不能自动 submit、调用模型或更改设置。 |
| P27 | `task-closeout-projection`、`TaskCloseoutChecklist` | snapshot、审批、files、deliveries、citations metadata | 只读完成/待审查状态与 Inspector 导航 | 不能伪造任务完成、自动创建或下载 ZIP、绕过审批。 |

## 4. 分批顺序与每批验收

### P22：任务页与类型化工作块

任务页是聊天首页与右侧 Inspector 之间的专注工作表面。其采用 P19/P21 的纯投影模式，将目标、当前状态、审批、活动、成果和交付收据组织成可独立理解的块。任务页使用既有 task/run，不引入新的状态源或存储。

### P23：本地命令面板

命令面板只包含页面跳转、任务聚焦、设置入口、模型连接页和 Inspector 聚焦等无副作用动作。所有命令都由纯 catalog 定义，再由 projection 根据当前页面/任务态决定是否可见；键盘调用不会变成隐藏自动化通道。

### P24：本地项目层

项目是多个受控 task/run 的本地组织容器，而非云团队空间。项目 metadata 以独立 SQLite store 保存；task/run 用显式项目引用关联。既有 task runtime、文件账本、交付包和恢复机制仍是独立领域边界。

### P25：工作方式与模型选择审计卡

工作方式卡在任务提交前清晰呈现 Profile、权限模式和可用模型连接，并记录用户明确的选择。Provider connection 只显示现有脱敏字段，不显示 endpoint、API key 或原始 probe 错误；选择本身不发起模型请求。

### P26：模板库

模板是静态、可审计的 UI 辅助目录，例如「代码实现」「研究报告」「文件整理」「交付复核」。单击模板仅填入聊天首页的草稿、推荐工作方式与权限提示；提交仍必须由用户点击。

### P27：收尾审查清单

任务收尾块汇总运行终态、未决审批、成果数量、ZIP 收据和引用审查状态，并只允许跳转 Inspector。它显示事实而不改变事实：只要 task 未完成、仍有审批或成果尚未审查，就不能显示“可安全交付”。

## 5. 可持续维护规则

每个功能必须有下列四类文件，避免 App.tsx 或 Gateway composition root 继续膨胀：纯类型/投影、独立视图、定向测试、设计/研究记录。必须通过 `architecture:check`、全量测试、Workbench build、Rust/Python/sidecar、CSP contract、`git diff --check` 与 Windows provenance。每一里程碑独立 commit/push；不以批量大改替代可恢复交付。

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE 官方仓库"
[2]: https://github.com/toeverything/AFFiNE/blob/canary/LICENSE-MIT "AFFiNE MIT License"
[3]: https://github.com/lobehub/lobehub "LobeHub 官方仓库"
[4]: https://github.com/lobehub/lobehub/blob/canary/LICENSE "LobeHub Community License"
