# P10：Windows 显式本机 Gateway 伴随程序设计

## 问题

P9 的模型连接向导已将 API key 配置简化为预设、显示名称、模型 ID 和密码输入，但 Gateway 仍需用户在命令行手动运行。这会导致普通用户看到“未附着本机 Gateway”，阻断后续配置。因此 Windows 发布包必须提供一种**用户显式点击即可启动**的本机 Gateway 路径，同时绝不在桌面壳启动、安装或系统登录时自动执行。

## 方案选择

| 方案 | 用户体验 | 安全边界 | 结论 |
|---|---|---|---|
| 将 Gateway 转换为 Windows 自包含 Node.js 伴随程序，并由桌面应用中“启动 Gateway”按钮显式触发 | 无需用户安装 Node.js 或打开命令行；点击后等待健康检查，再附着 | 只监听 `127.0.0.1:4318`；仅允许固定 `serve` 参数；不接受任意命令、路径或外网绑定 | 采用 |
| 在安装器中创建登录启动项或桌面启动时自动拉起 Gateway | 表面便利，但后台进程在用户没有操作时出现 | 违反项目“启动默认断开、不自动启动 Gateway”的铁律 | 拒绝 |
| 提供开始菜单脚本、要求系统已有 Node.js | 实现成本低，但普通用户仍需知道脚本和 Node 环境 | 无自动运行，但交付不完整且错误难诊断 | 仅保留为开发备用，不作为产品主路径 |

## 技术实现

Gateway 使用 Node.js 官方 SEA（single executable application）打包为 Windows x64 可执行文件。构建脚本先以 esbuild 生成单个 CommonJS 入口，再由 Node 24 的 `--experimental-sea-config` 产生准备 blob，并以 `postject` 按官方要求注入 `NODE_SEA_BLOB` 资源和 sentinel fuse；因此最终用户无需安装 Node.js。SEA 文档明确要求先 bundle 依赖图，以保证注入入口的模块加载确定性，并允许以 `execArgvExtension: "none"` 屏蔽 `NODE_OPTIONS` 扩展。[1] 脚本不使用仅在后续 Node 版本提供的 `--build-sea` 参数。Tauri 的官方 sidecar 文档支持将符合目标三元组命名规范的可执行文件作为 `externalBin` 交付；启动该可执行文件必须显式授予能力且只能匹配已审核的 sidecar 名称。[2]

本项目不向 WebView 暴露 shell 插件。Rust 主进程将只暴露单一的 `start_local_gateway` Tauri command：它只允许启动内嵌的 `awo-runtime-gateway` sidecar，参数固定为 `serve`，不接受外部参数或路径；启动前只检查固定 `127.0.0.1:4318` 的 loopback 可达性，启动后在有限窗口内等待同一端口可达。命令返回仅包含 `started | already-running | unavailable` 和脱敏诊断码，不含进程句柄、路径、环境变量、密钥或子进程输出。

启动命令将 sidecar 工作目录固定为 Tauri 的每用户 `app_local_data_dir`，并且只预创建其受控 `.awo/` 子目录；Gateway composition root 的全部相对 SQLite 文件均因此落入该用户私有位置，不依赖安装目录、启动目录或用户传入路径。sidecar 的 `serve` 子命令固定绑定 loopback `127.0.0.1:4318`，忽略端口环境变量、额外命令行参数和 `NODE_OPTIONS` 扩展。API key 仅通过 Workbench 用户提交进入 Gateway 当前进程内存，进程退出即失效。安装器只复制 sidecar；不创建 Windows 服务、注册表 Run 项、计划任务、登录启动项或自动信任。

GitHub Windows provenance 工作流在 `desktop:build` 前运行受控 `gateway:sidecar` 脚本，验证预期 `x86_64-pc-windows-msvc` SEA 文件存在，再构建并证明安装器；工作流不安装或启动桌面候选程序或 Gateway。

## 用户流

1. 用户打开应用，默认看到“模型连接”。
2. 点击“启动本机 Gateway”。桌面壳才允许调用固定 sidecar。
3. 成功后页面自动附着 `127.0.0.1:4318` 并显示“可配置”。
4. 用户选择 OpenAI-compatible 或 Anthropic/Claude 协议，填写显示名称、模型 ID 和 API key。
5. 用户点击“保存并启用连接”，再按需点击“测试连接”或发送一次受限文本请求。
6. 退出桌面应用时，已由其显式启动的 Gateway 被有序关闭；已存在的外部 Gateway 不会被接管或终止。

## 不变量与验收

- 桌面启动、安装和登录时不自动启动 Gateway。
- 只有用户点击后才调用 Rust command；command 只启动打包 sidecar 的固定 `serve` 模式。
- sidecar 永远只绑定 `127.0.0.1:4318`，不监听 LAN、IPv6 通配地址或公网地址，且不接受端口环境变量覆盖。
- Gateway 的相对 `.awo/` 持久化根目录只能位于当前用户的应用本地数据目录；首次启动仅创建该固定目录。
- 不为启动 sidecar 授予 WebView 任意 shell、文件、环境、数据库或进程枚举权限。
- 安装器中不产生服务、任务计划、Run 项或组件信任变更。
- 端到端测试覆盖首次启动、已运行、启动失败、关闭时有序回收和 API key 不落盘。
- Windows 安装器、sidecar 摘要与 GitHub 来源证明均可独立验证。

## References

[1] [Node.js — Single executable applications](https://nodejs.org/api/single-executable-applications.html)

[2] [Tauri — Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)
