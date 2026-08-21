# 浏览控制与分层设置规格

**状态：** P3/P4 实施规格
**日期：** 2026-08-21
**参考：** browser-use、Midscene、UI-TARS Desktop、AFFiNE 公开资料及用户提供截图。

## 1. 首轮产品范围

本轮把“浏览器接管”拆为一个**可治理的浏览会话控制面**。它不直接嵌入 browser-use、Midscene 或 UI-TARS 运行时；也不会向 WebView 授予浏览器 profile、文件系统、环境变量、Shell、桌面鼠标键盘或通用进程启动能力。

首轮只提供 `local-browser-preview` 适配器的会话记录与控制信号。适配器声明为不可执行，因此用户可以验证授权、暂停、结束、审计和界面层级，而任何真正的网页点击、输入、上传、下载、支付、登录、表单提交与跨站导航都仍不可发生。后续若接入经审查的浏览器后端，必须另行以 Agent Adapter manifest 声明其 transport、能力集、数据范围、版本和 SHA-256 digest，并在每个高风险意图处重新走审批。

> “管理员”不应成为绕过基础拒绝规则的开关。浏览会话的基础拒绝包含：读取浏览器存储、读取密码、CAPTCHA 规避、绕过登录、支付/转账、上传文件、下载/运行文件和操控整机输入设备。任何未来能力仍受这些基础拒绝与显式审批约束。

## 2. 浏览会话状态机

| 状态 | 由谁发起 | 允许操作 | 禁止操作 |
| --- | --- | --- | --- |
| `requested` | 用户显式创建 | 查看授权摘要、取消 | 自动启动后端、自动浏览 |
| `authorized` | 用户显式授权目标范围 | 开始受控适配器（未来）或暂停/结束 | 扩展站点范围、直接执行网页动作 |
| `running` | 已审查适配器回报 | 暂停、结束、查看审计 | 重复创建、隐式后台运行 |
| `paused` | 用户点击暂停 | 恢复（仅同一范围）、结束 | 新动作、更新目标范围 |
| `ended` | 用户结束或失败 | 只读审计 | 恢复或重放副作用 |

每条记录仅包含会话 ID、适配器 ID、目标摘要（协议+主机，不含完整路径/查询）、时间、状态、范围 digest、操作人、理由与不可执行声明。不得记录网页正文、截图、cookie、token、密码、表单字段、端点、浏览器 profile 或模型输入输出。

## 3. Gateway 管道

```text
Workbench intent
  → Gateway HTTP route (x-awo-operator-intent)
  → BrowserSessionControlPlane
  → SQLite WAL append-only ledger
  → redacted DTO
  → Workbench control panel
```

HTTP 路由不访问浏览器、文件系统、环境变量或数据库构造器；SQLite 在 Gateway composition 中唯一创建和关闭；Workbench 只读投影并发送显式意图。路线保持与现有 Provider、Skill Pack、Agent Adapter 一致的单向管道。

## 4. AFFiNE 式设置空间

设置不再是 `workbench-main` 内的普通内容替换。启用设置态时：

1. 聊天/项目/任务工作区仍保留为背景上下文层，但通过遮罩降低视觉权重。
2. 居中的 `.settings-overlay` 成为独立浮层，具有 20–24px 圆角、柔和外阴影与可访问的关闭动作。
3. 浮层内部为双栏：左侧 `.settings-sidebar` 显示分类、当前选择与返回聊天；右侧 `.settings-content` 承载二级页。
4. 三级页（角色目录、API 审计、浏览控制）仍在右侧内容栏中呈现，使用面包屑和“返回二级页”按钮，不把用户弹回首页或另起平铺页面。
5. 移动端退化为全屏设置层，左栏转为可横向滚动的分类带，不出现小屏双栏挤压。

视觉 token：普通行使用透明/浅灰基底；选中项使用低饱和蓝灰填充和可见文本；主操作为蓝色；暂停为琥珀；结束为红色；只读为中性灰。所有按钮保留 `title`、键盘焦点和明确副作用文案。

## 5. 验收条件

| 条件 | 验证方式 |
| --- | --- |
| 首页没有浏览管理、角色墙或 API 审计 | Workbench 视觉检查。 |
| 设置浮层有独立遮罩、容器、左菜单与右内容 | Workbench 截图/DOM 检查。 |
| 浏览会话必须显式创建和授权 | 领域/HTTP 测试。 |
| 暂停与结束即时记录，结束不可恢复 | SQLite 状态机测试。 |
| 首轮没有任何网页或桌面执行后端 | Manifest 与路由测试，`canExecute=false`。 |
| DTO 不泄漏页面内容、cookie、密码、完整 URL 或 secret | 领域与 Workbench 客户端测试。 |
| 仍满足 WebView 无 `unsafe-eval` 与 Windows 固定 Gateway sidecar 边界 | 现有桌面壳契约与全量质量门。 |

## References

[1] [browser-use repository](https://github.com/browser-use/browser-use)
[2] [Midscene.js repository](https://github.com/web-infra-dev/midscene)
[3] [UI-TARS Desktop repository](https://github.com/bytedance/UI-TARS-desktop)
[4] [AFFiNE repository](https://github.com/toeverything/AFFiNE)
