# P6.5：Windows 原生认证适配器与发布证据调研

**日期：** 2026-08-20
**发布范围：** 仅 Windows 11 x64。本阶段不为 macOS/Linux 生成适配器、安装包、签名声明或受信状态；跨平台领域接口继续存在，但只能保持未实现/未受信。

## 证据边界

当前仓库运行时位于 Linux 开发环境；已连接 Windows 11 Home x64 设备，但尚未提供待签名的 Windows native helper 二进制、证书身份或 Windows app package。因此，P6.5 将交付 **source-confirmed** 的 Windows-only evidence contract、PowerShell 受限读取 adapter 协议、摘要验证和 append-only 发布账本，并可在 Windows 设备上对非敏感、已存在的系统二进制执行本机安全读取验证。任何“已使用某证书签名”“平台身份已验证”或“可发布”结论均为 **requires runtime evidence**，除非对应的真实 helper 二进制及签名状态被明确采集、摘要绑定并经过发布门验证。

## 官方基线与收敛

| 来源 | 官方事实 | P6.5 收敛 | 证据状态 |
|---|---|---|---|
| Microsoft Authenticode | Authenticode 结合数字签名和 CA 信任链识别发布者，并校验签名后软件未被改变。 | Windows adapter 只接受 native host 已采集的 Authenticode `Valid` 状态、签名者证书 thumbprint 与 SHA-256 文件摘要；三者和 bridge identity 绑定。 | source-confirmed；具体 helper 签名需 runtime evidence。 |
| `Get-AuthenticodeSignature` | 该 cmdlet 仅在 Windows 可用，可读取文件/字节内容的 Authenticode 签名信息。 | 仅在 Windows adapter 进程内执行固定、非交互、无 profile 的安全读取；不接受浏览器提供的路径，不执行任意 PowerShell，不安装/启动二进制。 | source-confirmed。 |
| WebView2 安全指南 | WebView 内容不可信，应校验 origin 与 message；WebView host 推荐标准用户完整性，提升工作应分离到专用进程。 | Windows UI/renderer 不读证书、不运行 PowerShell、不调用 release gate；平台 adapter 与 WebView 进程隔离，只有最小 typed evidence 进入 P6.4 专属 nativeHost 端口。 | source-confirmed；实际进程完整性需 runtime evidence。 |

> “Authenticode … identifies the publisher … [and] verifies the software has no changes since it was signed and published.” — Microsoft Authenticode。[1]

## Windows-only 契约

| 阶段 | 受限输入 | 产物 | 明确禁止 |
|---|---|---|---|
| Evidence capture | 固定的 Windows adapter 配置中已声明的 helper ID、已验证的二进制 SHA-256 与 Authenticode 摘要 | `WindowsNativeHostReleaseEvidenceV1` | Renderer/HTTP path、任意命令、私钥、证书正文、安装/启动 |
| Release gate | Evidence 的 helper ID、bridge ID、publisher thumbprint digest、协议版本、检查时间 | `release-ready` 或拒绝 reason | 仅凭 `Valid` 自动设为 trusted、自动登记 bridge、自动激活构件 |
| Bridge registration | 显式 Windows operator/native host 管理意图 + release-ready evidence | P6.4 `registered` bridge metadata | 浏览器/HTTP 调用、macOS/Linux 标记、自动 trust transition |
| Trust promotion | 独立人工审查与现有 Trusted Desktop Issuer 状态机 | `trusted` bridge revision | release evidence 自动升级、跨平台复用 Windows 证据 |

## Windows 本机只读验证记录

已在连接的 **Windows 11 Home x64（PowerShell 5.1）** 设备上对系统自带 `notepad.exe` 执行了 P6.5 采集器的受限运行时验证。`Get-AuthenticodeSignature` 返回 `Valid`；采集器基于 `Get-FileHash -Algorithm SHA256`、Authenticode 状态和 `Win32_Processor` 架构信息生成了字段白名单 JSON。随后的内存 schema 检查确认输出仅含版本、脱敏 identity、摘要、状态、时间和 `canExecute: false` / `canAutoTrust: false`，临时脚本副本已删除。

这只证明 **Windows 采集器可在该版本 PowerShell 上以只读方式处理已签名系统二进制**。它不涉及 AI Work OS native helper、代码签名证书、bridge 注册或 trust promotion；这些仍必须在项目 helper 构建后按下列发布门另行采集证据。

## Windows 发布门

1. OS 必须为 Windows 11 x64；否则 Windows adapter 返回 `platform-not-windows`，不产生 release-ready。
2. Helper 文件摘要必须与预计 SHA-256 完全匹配；不一致时拒绝，且不重新计算或更新 lock/provenance。
3. Authenticode `Status` 必须为 `Valid`，签名者 thumbprint 必须和受控期望摘要匹配；未签名、未知、哈希不匹配或证书读取失败均拒绝。
4. 证据必须绑定单个 `issuerId`、`bridgeId`、helper ID、protocol version 和短时 capture 时间；不得跨 helper/bridge 复用。
5. 证据账本只保存摘要与状态，不保存路径、文件名、证书主题、证书正文、私钥、签名 blob 或 PowerShell 原始输出。
6. Windows UI/WebView2 进程必须保持标准用户完整性；任何未来提升动作另行走专用进程，不能通过认证桥或渲染器获得。

## 参考资料

[1]: https://learn.microsoft.com/en-us/windows-hardware/drivers/install/authenticode "Authenticode digital signatures"
[2]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature?view=powershell-7.6 "Get-AuthenticodeSignature"
[3]: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security "Develop secure WebView2 apps"

[1] [2] [3]
