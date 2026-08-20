# P7：Windows Desktop Shell 调研笔记

**状态：** 调研中。目标是将 AI Work OS 现有 Workbench、Gateway 与 Windows native helper 组合为可双击启动的本地桌面应用，而不把 native helper 或任意系统权限暴露给前端。

## 现状

当前仓库已有 React/Vite Workbench、Node/TypeScript runtime gateway、Rust process supervisor 与 Windows x64 native-host helper。现有 `awo-native-host-helper` 安装器只安装一个 framed-stdio 协议 helper；该 helper 仅接受 `health` 与 `release-info`，没有图形界面，也不具有执行、认证或构件管理能力。因此它不能替代完整桌面应用。

## 桌面壳选择

| 候选 | 优势 | 对当前边界的主要风险 | P7 决策 |
|---|---|---|---|
| Tauri 2 | Rust core + 现有 TypeScript/Vite 前端；Windows 使用系统 WebView2；可用 capabilities 限制 IPC；可打 Windows setup executable | sidecar 默认具备强 OS 能力，若直接授予前端 shell 执行权限会破坏默认拒绝策略 | **采用**，但 P7.0 不使用 shell sidecar 或自动启动 Gateway |
| Electron | 成熟、多进程、对 Node 生态友好 | 若暴露宽泛 IPC 或开启 Node 集成，会让 Web 内容取得强大本机能力 | 作为兼容备选；不作为首个实现 |
| 浏览器标签页 | 无额外桌面打包成本 | 不能提供窗口、安装、生命周期与本地桌面身份边界 | 不满足用户的“可双击打开桌面程序”目标 |

Tauri 官方的安全模型明确将 Rust core 与 WebView 前端视为不同信任域，并要求所有 IPC 都经由能力声明与命令实现约束。官方 sidecar 文档明确要求为执行/启动 sidecar 单独授予权限，因此本阶段不能向 WebView 暴露泛化 shell 或进程启动 API。[1] [2]

Windows 11 已自带 WebView2；Tauri 可构建 Windows 的 `-setup.exe` 安装程序。官方也指出 WebView2 采用系统运行时而不是将 Chromium 打入应用包，安全补丁能更快随系统发布。[1] [3]

## P7.0 最小边界

1. 新建独立的 `apps/desktop-shell`，Rust 是唯一桌面主进程；现有 Workbench 保持 UI-only。
2. 仅加载本地静态 Workbench 资产；禁止任意导航、远程 URL、文件系统读取、shell、插件加载和外部二进制启动。
3. 首个版本只暴露一项只读 `desktop_posture` IPC，用于显示“桌面壳已启动；Gateway/helper 均未自动启动、未受信任”。
4. Gateway 仍由显式开发会话启动；native helper 仍需独立认证与人工管理流程，安装、桌面启动和 bridge trust 永不等价。
5. Windows x64 先行；WebView2 使用 Windows 11 系统运行时，macOS/Linux 不实现也不受信。
6. Windows `Setup.exe` 打包只安装桌面壳与静态 UI，不自动执行 Gateway/helper，也不创建服务、自启动、协议处理器或权限提升。

## 后续阶段

P7.1 才会设计受控 Gateway attach：必须经过具体 loopback origin、健康状态、显式用户意图与可观测性；它不得通过客户端获得数据库、环境变量、任意命令或 provider 凭据访问。P7.2 才考虑为已认证原生 helper 添加窄化、单用途操作。

## 参考资料

[1]: https://v2.tauri.app/security/ "Tauri Security"
[2]: https://v2.tauri.app/develop/sidecar/ "Tauri — Embedding External Binaries"
[3]: https://v2.tauri.app/distribute/windows-installer/ "Tauri — Windows Installer"
[4]: https://www.electronjs.org/docs/latest/tutorial/context-isolation "Electron — Context Isolation"

[1] [2] [3] [4]

## P7.0 实现设计

P7.0 采用独立的 `apps/desktop-shell` Tauri 2 workspace。它在 Windows x64 上生成一个可双击启动的 `AI Work OS` 窗口，并加载 `apps/workbench` 的生产静态资源。它不是 Electron 或浏览器页面，也不是 P6.8 的 helper 安装器升级替代品。

| 层 | P7.0 行为 | 不做的事 |
|---|---|---|
| React Workbench | 复用既有 Vite 生产构建；保留 UI-only 和唯一 HTTP 客户端边界 | 不导入 Rust/Node/SQLite/环境变量或 Tauri shell API |
| Tauri Rust core | 创建主窗口、只加载 bundle 中的本地静态资产、允许退出 | 不声明 IPC commands；不访问文件系统；不启动进程；不注册协议/自启动/服务 |
| Gateway | Workbench 继续按既有 loopback HTTP 契约请求只读或显式任务接口 | 桌面启动不自动启动 Gateway、SQLite、监听端口或恢复演练 |
| Native helper | 保持独立安装、认证与发布证据流程 | 不打包为 Tauri sidecar；不随桌面窗口启动；不授予 bridge trust |
| Windows installer | Tauri NSIS current-user setup executable，Windows x64 only | 不提升权限、不自动运行应用、创建服务或修改系统级设置 |

桌面主进程没有 `invoke` 命令，WebView 也没有任何 shell、filesystem、dialog、notification、updater、deep-link 或 sidecar permissions。CSP 仅允许 bundle 静态资产、`data:` 图像和既有 `http://127.0.0.1:4310` Gateway 连接；不允许远程脚本或任意导航。

Windows 本机已确认 Node `v24.18.0`、npm `11.16.0`、Rust/Cargo `1.97.1` 与 Tauri CLI `2.11.4` 可用。现有 Windows 11 x64 是 P7.0 的唯一目标。WebView2 在 Windows 11 由系统分发；安装器采用 Tauri 官方默认的下载 bootstrapper 兼容路径，而不会捆绑固定运行时。[3]

P7.0 完成后，用户将可双击启动真正的 **AI Work OS** 图形窗口；若 Gateway 未被显式启动，WorkBench 会按已有错误 UI 显示本地服务不可用，而不是让桌面壳自行获得或执行任何后台权限。

## Windows 11 实机构建与安装记录

P7.0 在 Windows 11 x64 上完成了真实的 Tauri release 构建与 NSIS 打包。首次构建暴露两个确定性配置缺口：Tauri Windows 资源编译需要 `icons/icon.ico`；主窗口查询需要导入 `tauri::Manager` trait。现已使用 Tauri 官方图标命令从原创方形应用图标生成所需多尺寸 Windows ICO 层，并在 Rust core 中显式导入该 trait。

修复后验证结果如下。

| 验证项目 | 结果 |
|---|---|
| Rust release binary | `awo-desktop-shell.exe`，8,758,272 bytes，构建通过 |
| NSIS desktop setup | `AI Work OS_0.1.0_x64-setup.exe`，2,012,370 bytes，构建通过 |
| 实际安装 | 静默 current-user 安装退出码 `0`，已登记卸载项 |
| 安装位置 | `C:\Users\17296\AppData\Local\AI Work OS` |
| 图形窗口启动 | 已安装的 `awo-desktop-shell.exe` 成功启动并保持运行 |
| Gateway 自动启动 | `false` |
| native helper 自动启动 | `false` |

桌面候选的 GitHub Actions 工作流会在显式触发或 `desktop-v*` tag 时使用最小权限构建 Setup.exe、生成 manifest、上传工件并使用 GitHub Attestation 生成 SLSA provenance。工作流不安装候选、不启动桌面应用、不启动 Gateway/helper，也不拥有代码签名证书或仓库写权限。

桌面壳尚不是完全自带 Gateway 的单体应用。这是刻意的首阶段设计：用户可以双击启动完整 Workbench UI；Gateway 附着和 native helper 认证仍是后续显式、可观测、人工治理的步骤，而不是桌面窗口启动的副作用。
