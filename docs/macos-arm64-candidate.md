# NOVA macOS arm64 候选构建

NOVA 的 macOS 候选通过独立的 GitHub hosted `macos-latest` runner 构建。该 workflow 只生成 Apple Silicon `aarch64-apple-darwin` DMG、平台独立 manifest、SHA-256 和 GitHub SLSA provenance；它不修改、调用或替代 Windows NSIS workflow。

候选使用 macOS ad-hoc signing identity（`-`），因此 manifest 会标记为 `ad-hoc-candidate`，而非受 Apple notarization 信任的公开发布。Gatekeeper 仍可能要求用户手动允许安装。正式对外分发需要 Apple Developer 的 Developer ID Application 证书与 notarization。

核心 Workbench、Tauri IPC 和用户配置的第三方 Provider 原生 HTTPS/SSE 直连均保留。Windows 内嵌 Python runtime 不会打入 macOS DMG；因此首版候选将显式拒绝本地 SearXNG 与 last30days Python 运行时，而不是悄然下载或错误执行 Windows 二进制。Exa、已配置 Provider 与不依赖本地 Python 的功能不受该限制。

当前透明、置顶的 Desktop Companion 使用 Windows 专属窗口构建 API。macOS 首版候选会明确返回 `desktop-companion-macos-unavailable`，不伪装为可用；该可选表面将在单独完成 macOS 窗口适配后再开放，且不会影响聊天、搜索、项目或 Provider 连接。

官方依据：

1. [Tauri Configuration Files](https://v2.tauri.app/develop/configuration-files/)
2. [Tauri macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
3. [Tauri Additional Resources](https://v2.tauri.app/develop/resources/)
