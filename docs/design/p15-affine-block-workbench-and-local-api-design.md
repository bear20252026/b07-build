# P15：块式任务工作台与本地 API 边界设计

**状态：** 已设计，待实现

## 1. 目标

P15 将 AFFiNE 的“可组合工作块”与 LobeHub 的“Agent/任务可见性”本地化为 AI Work OS 的单任务桌面界面。改动不把产品变成通用笔记应用、无限画布或服务端协作平台；它让用户在既有 task/run 流程中更明确地看见本机数据路径、当前连接状态、授权状态和受控产物。

| 工作台对象 | P15 块 | 状态来源 | 操作边界 |
|---|---|---|---|
| 当前任务 | 既有欢迎/任务概览块 | `snapshot`、当前 Profile、authority mode | 提交仍经既有受控意图。 |
| 模型准备度 | 既有 Model Readiness 块 | Gateway 附着与 provider connection metadata | 仅导航到模型连接；不自动连接。 |
| 本地 API 边界 | 新增 Local Data Flow 块 | Gateway 附着、已连接 Provider 数、task/run 文件数 | 无网络请求、无编辑、无密钥显示。 |
| 运行状态 | 既有 Runtime Snapshot 与活动块 | task snapshot、事件 DTO | 审批/恢复仍为原有明确按钮。 |
| 受控产物 | P13 右侧 Inspector | task/run 专属文件/交付 DTO | 不成为任意文件浏览器。 |

## 2. Local Data Flow 块

新增无状态 `LocalDataFlowBoard`，归属 `apps/workbench/src/components/workspace/`。它只接收已经由 `App` 持有并脱敏的 `gatewayAttached`、`connectedProviderCount`、`taskFileCount`。组件不导入 client、Tauri、Node、环境变量或 Provider SDK，也不触发请求。

```text
Workbench WebView              Local Gateway                    Third-party API
only 127.0.0.1:4318      session credential + policy        explicit user request only
        │                         │                                  │
        └── local task files / SQLite metadata / safe DTO projection ─┘
```

页面文字必须准确表达边界：第三方 API 在用户显式发起的模型调用中会接收该请求需要的内容；“本地优先”并不表示远程 Provider 不会收到任何提示或输出。它表示浏览器不直连 Provider、凭据仅在 Gateway 进程内存、控制和持久化在本机、WebView 只接收经过 DTO 守卫的投影。

## 3. 视觉与交互

Local Data Flow 块使用 P14 的圆润卡片、黑白主题 token 和低饱和状态点。四个小型面板按照固定顺序读取，不使用线路图、动态动画或暗示后台自动化的动效。工作区在宽屏显示一行四格；窄屏降为两列或一列。只有“查看模型连接”是明确的导航按钮，其他内容是只读解释。

| 条件 | 本机 Gateway 块 | Provider 块 | 产物块 |
|---|---|---|---|
| 未附着 | 显示“等待显式附着” | 显示“未开始网络请求” | 显示当前 task/run 可用文件计数。 |
| 已附着、无连接 | 显示“本机策略边界已就绪” | 显示“尚未配置会话连接” | 显示当前 task/run 可用文件计数。 |
| 已附着、有连接 | 显示“本机策略边界已就绪” | 显示已连接模型数量；强调调用仍需明确用户意图 | 显示当前 task/run 可用文件计数。 |

## 4. 安全不变量与失败语义

| 不变量 | P15 约束 |
|---|---|
| 网络 | `HttpWorkbenchTaskClient.forLocalGateway()` 的 `http://127.0.0.1:4318` 固定 origin 不修改；没有任意 URL 输入或浏览器直连 Provider。 |
| 凭据 | 不向组件传递 API key、endpoint、header、prompt、原始 response 或 secret；Provider 摘要的 `canReadSecret` 始终为 `false`。 |
| 持久化 | 不新增 SQLite 数据或浏览器本地存储；连接 metadata、任务文件与交付仍使用既有受控服务。 |
| 自动化 | 新块不附着 Gateway、不探测、不推理、不创建任务、不写文件、不生成交付包。 |
| 降级 | Gateway 未附着、无模型连接、无任务文件时只展示可读空状态，不能抛出错误或诱导用户忽略审批。 |

如果组件要求额外 API、出现 Provider URL/API key、或把“本地优先”描述成“不会向用户选择的第三方 API 传输请求数据”，P15 视为设计失败并移除相应实现。

## 5. 验收

P15 验收包括：静态组件的任务作用域清晰；小于 820px 时不破坏既有任务输入；本地 Gateway 地址仍固定；Provider DTO 守卫和 P13 文件/交付契约持续通过；架构检查、TypeScript、全量测试、Workbench build 与桌面 CSP 契约通过。

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE repository README and MIT license"
[2]: https://github.com/lobehub/lobehub "LobeHub repository README and Community License"

### 浏览器级初步验证

本地 Workbench 已在未附着 Gateway 的真实状态下显示 Local Data Flow 块：本地工作台说明固定 `127.0.0.1` 回环边界；Gateway 显示“等待显式附着”；Provider 显示“尚未配置会话连接”；本地记录显示当前 task/run 的零文件计数。右侧 P13 Inspector、任务输入和既有连接入口同时仍然可见。页面没有 Provider URL、API key、端点、响应正文或自动连接操作。

### 导航与质量门验证

点击 Local Data Flow 块的“查看模型连接”后，Workbench 仅切换到既有模型连接页面；Gateway 仍处于未附着状态，页面仍要求用户显式点击启动入口，因此未发生隐式网络调用。P15 已通过架构检查、严格 TypeScript 检查、219/219 全量测试、Workbench 生产构建和 7/7 桌面壳 CSP/sidecar 契约测试。生产构建仅包含本地静态资源；客户端固定回环 origin 与 Provider DTO 拒绝敏感/可执行字段的既有测试持续通过。
