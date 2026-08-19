# P3 调研：受控桌面桥接与离线模型健康

**作者：Manus AI**

**日期：2026-08-19**

## 结论

P3 不应把 Web Workbench 直接包装为拥有文件系统、Shell 或任意 IPC 的桌面应用。桌面宿主必须实现**窄桥接（narrow bridge）**：每个 renderer/WebView 只获得明确命名、参数受验证的读取型命令；启动 extension、执行工具、恢复数据库、读取凭据等高风险动作保持在既有 Gateway policy/approval 控制面之外，默认不提供 desktop command。

| 边界 | 推荐能力 | AI Work OS 取舍 |
| --- | --- | --- |
| WebView → Host IPC | 按窗口 label/能力清单暴露 `runtime.health`、`runtime.openLocalGateway` 的 metadata；严格 schema 和 source 校验。 | P3 只定义 bridge manifest 与 command guard，不接入 Electron/Tauri runtime，不把 Node 或 `ipcRenderer` 传给 UI。 |
| Host → Local Gateway | 只访问 loopback `127.0.0.1`，显式 port，DTO 版本匹配。 | 禁止任意 URL、远端 endpoint、凭据注入和 renderer 选择进程路径。 |
| Local model health | `HEAD /health` 或 `GET /v1/models`；仅登记 loopback endpoint，并把 probe 结果视作只读 metadata。 | 复用既有本地端点/Provider Profile，不自动下载模型、修改驱动、发送 prompt 或把 health 变成权限。 |
| 桌面发布 | 在未来宿主中启用 CSP、process sandbox、context isolation/能力 scopes、导航和新窗口限制。 | v1 不打包桌面 runtime；先完成可独立测试的 platform-neutral bridge contract。 |

Electron 官方安全指南要求 remote/untrusted content 不启用 Node integration、使用 context isolation 与 process sandbox，并验证所有 IPC sender。其 context isolation 文档特别指出：不要直接暴露 `ipcRenderer.send`；应只公开每个 IPC message 对应的窄方法。[1] [2]

Tauri 的能力系统按窗口/WebView 约束 permissions，且强调 IPC 是前端与拥有完整系统资源的 core 之间的信任边界。Tauri 也提醒 capability 并不能修复核心实现中的宽松 scope 或错误检查。因此 AI Work OS 可借用「能力文件 + command scope」的抽象，而不能把配置当作 policy 的替代。[3] [4]

## P3 最小实现

1. 定义 `DesktopBridgeManifestV1`：host/renderer protocol version、唯一 window label、只读 command allowlist、`canExecute: false`。
2. 定义 `DesktopBridgeGuard`：只接受已登记 command，拒绝未知字段、非本地端点、写入/执行类 command；每次请求生成不可执行审计结果。
3. 定义 `LocalModelHealthRegistry`：注册前校验 loopback URL；probe 时只允许 HEAD health 或 GET models，记录延迟、HTTP 状态、可见 model IDs 和检查时间；无 secret。
4. 不引入 Electron/Tauri 二进制或真实 OS 权限，等宿主计划和目标平台明确后再选择；该取舍避免为“桌面化”而跨越当前受控执行边界。

## References

[1] [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)

[2] [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)

[3] [Tauri Capabilities](https://v2.tauri.app/security/capabilities/)

[4] [Tauri Security and Trust Boundaries](https://v2.tauri.app/security/)
