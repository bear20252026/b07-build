# Tauri Windows 与 Android 发布路径调研

**调研日期：** 2026-08-22

## 官方结论

| 主题 | 官方要点 | 本项目适用决策 |
| --- | --- | --- |
| Windows NSIS | Tauri 在 Windows 可输出 NSIS `-setup.exe`；在 Windows 运行 `tauri build` 是首选路径。NSIS 可跨编译但官方说明其测试程度较低。 | 使用 GitHub `windows-latest` 工作流构建 Windows x64 Setup.exe；不把 Linux 交叉构建当作唯一发布证明。 |
| WebView2 | `downloadBootstrapper` 产生较小安装器，但要求安装时联网；Windows 10 1803+ 和 Windows 11 通常已有 WebView2。`offlineInstaller` 会显著增大安装器。 | 维持当前 `downloadBootstrapper`，并在安装说明中说明首次无 WebView2 时需联网；以后可增加离线版本。 |
| Windows 安装位置 | NSIS `currentUser` 不需要管理员权限，安装至当前用户本地路径；`perMachine`/`both` 涉及管理员权限。 | 保持 `currentUser`，符合个人工具的最小权限发布。 |
| Android 工程 | Tauri Android 需要 Android Studio、SDK Platform、Platform-Tools、NDK、Build-Tools、Command-line Tools，并设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME` 和 Android Rust targets。 | 未满足前置条件时不伪造 APK；先初始化 Android Studio/Gradle 工程与平台边界，SDK 准备后执行真实 APK/AAB 构建。 |
| Android 输出 | `tauri android build -- --apk` 可生成 APK；`--aab` 可生成 Play AAB。最低 Android API 为 24；输出可在 `gen/android/app/build/outputs/...` 找到。 | 计划默认构建 arm64 与 armv7；APK 用于本机测试，AAB 仅在签名和 Play 发布准备完成后生成。 |
| 平台配置 | Tauri 支持 `tauri.android.conf.json` 和 `tauri.windows.conf.json`，采用 JSON Merge Patch；数组是整体替换。 | Windows-only sidecar、桌面窗口与原生命令必须通过 Android 平台配置与 capabilities 隔离，不让移动端继承。 |
| Capabilities | capability 可使用 `platforms` 限制为 windows / android；桌面与移动插件权限应分文件配置。 | 新增 Android 最小 capability，禁止 Shell、sidecar、目录全盘选择、桌面 Companion 和无边界系统控制。 |

## 来源

[1]: https://v2.tauri.app/distribute/windows-installer/ "Tauri Windows Installer"
[2]: https://v2.tauri.app/start/prerequisites/ "Tauri Prerequisites"
[3]: https://v2.tauri.app/develop/ "Tauri Develop"
[4]: https://v2.tauri.app/distribute/google-play/ "Tauri Google Play"
[5]: https://v2.tauri.app/develop/configuration-files/ "Tauri Configuration Files"
[6]: https://v2.tauri.app/develop/sidecar/ "Tauri Embedding External Binaries"
[7]: https://v2.tauri.app/security/capabilities/ "Tauri Capabilities"
