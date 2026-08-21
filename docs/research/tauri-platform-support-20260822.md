# AI Work OS 跨平台支持评估

**日期：** 2026-08-22

## 当前结论

当前仓库**已经正式配置并验证 Windows x64**。`apps/desktop-shell/src-tauri/tauri.conf.json` 的 bundle target 为 `nsis`，图标为 Windows `.ico` 组合，且安装模式为每用户安装。最新 Windows 构建与来源证明工作流已完成，因此可将 Windows 作为当前唯一可下载、可追溯的桌面候选。

Android 手机、Android 平板、iPhone/iPad 和 macOS 在 Tauri 2 技术栈上均有可行路线，但本仓库**尚未初始化移动原生工程、尚未配置移动权限/安全边界、尚未构建 APK/AAB/IPA/DMG，也未进行实体设备测试**。因此它们不得在产品界面或发布说明中标为“已支持”。[1] [2]

| 平台 | 当前仓库状态 | 技术可行性 | 仍需完成的工作 |
| --- | --- | --- | --- |
| Windows x64 | 已配置 NSIS，每用户安装，已构建/证明 | 已支持 | 继续改善签名与安装体验；当前候选仍应按证据链说明其签名状态。 |
| Android 手机 | 未初始化 | Tauri 2 支持 `tauri android dev`、APK 与 AAB 构建 | 初始化 Android 工程；重做窄屏任务画布；将 loopback Gateway/sidecar 方案改为受移动操作系统约束的本机服务；配置 Android 网络、存储、后台生命周期及签名。 |
| Android 平板 | 未初始化 | 与 Android 手机同一原生项目 | 在响应式工作台上增加平板断点、双栏/三栏审查、横竖屏及触控目标测试；不要把桌面三栏简单压缩到平板。 |
| macOS（Intel / Apple Silicon） | 未配置 | Tauri 2 支持 macOS bundle 与 DMG | 在 macOS runner 上构建 x86_64 与 aarch64；替换 Windows 专用 sidecar/安装假设；完成 Apple Developer 证书、签名和公证。 |
| iPhone / iPad | 未初始化 | Tauri 2 支持 `tauri ios dev` | 需要 macOS、Xcode、Apple Developer 签名、移动服务边界与适配后的单列/两列 UI；iPad 可与 iOS 工程共享，但仍需实体设备验证。 |

## 推荐顺序

Windows 保持唯一发布平台直到 Windows 安装、升级、Gateway 启动与恢复路径稳定。下一平台应优先选择 Android，而不是同时开启 macOS 与 iOS：它可以先验证移动任务发起、项目浏览、审计阅读和 Provider 会话配置的窄屏交互。Android 平板属于同一工程的响应式验收，而不是另一个独立产品。

macOS 可在用户取得 Mac 和 Apple 开发者签名条件后启动。由于当前桌面壳包含 Windows 侧的 NSIS、WebView2 与受控 Gateway sidecar 假设，macOS 不是重新打包即可完成的目标；必须先将平台专属安装/sidecar 启动策略拆成明确的目标适配层。iPad/iOS 的前置条件与 macOS 共享 Xcode 和 Apple 签名，因此应在 macOS 适配稳定后开展。

## 安全与产品边界

移动端不应复制 Windows 的常驻 sidecar 行为或假设可任意监听本机端口。Provider key 继续只存在于进程会话或操作系统安全存储的引用中，不能进入 SQLite、任务事件或 UI DTO。浏览会话能力仍维持当前的无执行控制面，直到针对移动 WebView、登录、文件和支付风险设计独立审批边界。

## References

[1] [Tauri v2 — Develop](https://v2.tauri.app/develop/)

[2] [Tauri v2 — Distribute](https://v2.tauri.app/distribute/)

[3] [Tauri v2 — Google Play distribution](https://v2.tauri.app/distribute/google-play/)

[4] [Tauri v2 — macOS code signing](https://v2.tauri.app/distribute/sign/macos/)
