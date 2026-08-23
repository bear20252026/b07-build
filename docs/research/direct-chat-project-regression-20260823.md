# 首页直接聊天与项目创建回归复核

## 根因

桌面首页此前只在 `taskModelSelection` 已驻留 React 内存时调用直接 Provider；刷新或重启后虽然选择已写入本地存储，却没有恢复到主页状态，导致发送回落到遗留的 Gateway 任务流。直接会话的异步失败也未在首页展示，使用户看到“没有输出”。

项目页则仍以 `gatewayAttached` 作为创建开关，并经 `http://127.0.0.1:4318` 的旧 HTTP 客户端读写；Gateway 已被移除时，该开关始终为假，所以新建项目被禁用。

## 修复方向

主页恢复已保存的 Provider / 模型选择，发送时等待原生直接 Provider SSE 操作结束；失败将显示在聊天画布而非静默丢失。项目 metadata 与 task/run 引用改为 `awo.projects.v1` 本地持久化账本，独立于 Provider、API key、文件、模型网络请求及回环 HTTP 服务。

这沿用 AtomCode / OpenWorker 所采用的职责分离模式：Provider 选择、会话和本地工作区元数据分开管理；项目创建不依赖模型请求成功。没有复用其源代码、图标或品牌资源。

## 本地预览核验

在未连接 Provider 的本地预览中，首页已去除白色外框，并在单一窗口内展示内容与输入区，没有页面纵向溢出。项目页面显示“新项目名称 / 说明 / 创建项目”表单；创建按钮未再因 Gateway 状态禁用，说明本地项目路径已经代替旧回环门槛。

交互实测已创建“本地项目核验”：项目立即出现在列表中、自动选中并显示 `0 个任务` 的详情，未出现旧 Gateway 错误或网络请求前置条件。该临时浏览器数据将在核验后清除。

恢复选择核验显示：首页刷新后标题栏与欢迎区都会显示已保存的 `mimo-v2.5-pro` 任务模型选择。该选择会使提交函数进入 `useDirectConversations.send` 的直接 Tauri SSE 路径，而不再回落到遗留任务执行客户端。

发送交互核验显示：用户消息会立即加入时间线，发送函数已进入直接 Provider 路径；在普通浏览器预览中该路径因不存在 Tauri WebView 运行时而返回 `transformCallback` 错误，且该错误已在聊天画布中可见。此错误证明静默失败已被修复，但无法替代安装后的 Tauri 原生 Provider 实际供应商连接测试。

## OpenWorker 与 AtomCode 参考边界

本次采用两者共同的产品分层模式：Provider / API key 负责建立真实模型会话，项目和会话元数据属于独立的本地工作区状态；项目创建不应取决于某个模型请求、回环 HTTP 服务或供应商响应。本实现没有复制、导入或分发 OpenWorker、AtomCode 的源代码、图标、品牌、模型资产或接口凭据处理；仅以公开产品交互模式作为参考，并保留该说明。

参考来源：

* <https://github.com/andrewyng/openworker>
* <https://atomgit.com/atomgit_atomcode/atomcode>

## 启动时的原生 Provider 会话重建

已新增 `awo.direct-provider-accounts.v1` 本地账本，保存 `providerId`、显示名称、协议、Base URL、模型名和按用户要求可查看的 API key。用户在“连接并测试”成功配置后，应用会保存该完整账户配置；下次 Windows 桌面应用启动时，Workbench 仅调用 Tauri 原生 `configure_direct_provider` 重建内存会话，然后恢复同一 `providerId` 的模型选择与对话历史。

该启动恢复**不会**自动执行连接测试、模型目录查询或聊天请求，也不会写入会话记录、项目账本或诊断板。只有用户发送消息或手动选择“连接并测试 / 查询模型”时，才会发出第三方网络请求。恢复失败时首页会提示用户在 API 连接页面重新连接，而不会回退至已移除的 Gateway 或 `127.0.0.1:4318` 链路。

验证结果：新增直接 Provider 账户账本的更新和异常数据降级测试；全仓 `npm test` 为 **309/309** 通过，TypeScript、Workbench 生产构建、Rust `cargo check` 与差异空白检查均通过。真实供应商回复仍需在安装后的 Tauri WebView 中由用户使用自己的有效账户完成验证。
