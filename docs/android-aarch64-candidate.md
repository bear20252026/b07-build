# NOVA Android 候选版说明

## 交付范围

NOVA Android 候选版面向 Android 7.0（API 24）及更高版本，首个可安装 APK 仅覆盖 `aarch64`，并同时生成包含 `aarch64`、`armv7`、`i686` 与 `x86_64` 目标的 universal AAB 候选。该候选通过独立 GitHub hosted Ubuntu workflow 构建，随 artifact 发布 SHA-256 manifest 与 SLSA provenance。[1]

普通聊天保持同一条原生直连路径：**WebView → Tauri invoke/events → Rust reqwest HTTPS/SSE → 用户明确配置的第三方 Provider**。Android 版本不引入 Gateway、请求中转或对预设/自定义 Provider 的差别待遇。

| 能力 | Android 候选状态 |
| --- | --- |
| Provider 配置、连接测试、模型发现、流式聊天、多会话、项目、Markdown 历史、Halo、开屏 | 支持 |
| 用户点击的 HTTP(S) 搜索来源 | 支持，通过 Android 默认浏览器打开；不会接收文件路径或自定义 scheme。[2] |
| 文本/图片附件 | 复用 WebView 文件选择器和现有 Provider 请求契约；Provider/模型不接受的载荷会显示真实原因。 |
| 终端执行、GitHub 本地工作区协作、Desktop Companion、Windows/macOS Save As | 不支持；不会注册相应 Android 原生命令。 |
| 内嵌 SearXNG、last30days Python runtime、混合检索中的本地 Python 后端 | 不支持；不会打入 APK/AAB，也不会在 Android 上尝试启动。 |

## 签名与信任边界

当前 APK/AAB 使用 CI 中临时生成、构建后销毁的 test signing key。它仅用于候选安装与构建完整性验证，**不是** Google Play 发布签名、长期更新签名或受信任分发声明。

正式 Google Play 发布需由产品所有者创建/保管 Android upload keystore，并以 CI secrets 传入 GitHub Actions。Google Play 建议使用 App Signing：上传者使用独立 upload key，而 Play 持有并使用 app signing key 对交付 APK 签名。[3] [4]

## 版本与安装注意事项

候选 AAB 不可直接安装；它用于 Google Play Console 的内部测试/预检。用户可在 Android 设备上安装 `aarch64` candidate APK 进行功能验证。首次 Play 上传仍需在 Play Console 手动完成，并处理应用标识、数据安全、隐私政策和内部测试轨道等发布材料。[1]

## 参考资料

[1] [Tauri: Google Play distribution](https://v2.tauri.app/distribute/google-play/)

[2] [Tauri: Opener plugin](https://v2.tauri.app/plugin/opener/)

[3] [Tauri: Android code signing](https://v2.tauri.app/distribute/sign/android/)

[4] [Android Developers: Sign your app](https://developer.android.com/studio/publish/app-signing)
