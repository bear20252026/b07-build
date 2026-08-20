# P6.6：Windows 原生 Helper 受控发布候选包调研

**日期：** 2026-08-20
**范围：** Windows 11 x64。macOS/Linux 不构建、不打包、不签名、不发布。

## 证据边界

本阶段将生成 **source-confirmed** 的最小 Windows helper 源码、可重复的候选打包脚本、ZIP 候选包、SHA-256 清单、最小 SPDX 2.2 SBOM、发布清单与验证脚本。候选包可以在 Windows 11 x64 上完成安全的内容/摘要验证，但没有项目代码签名证书、Microsoft Store 身份或生产 SignTool 验证记录时，必须标为 **candidate / unsigned / quarantined**，不可宣称 production release、受信 bridge 或可自动安装。

## 官方基线

| 基线 | 官方信息 | P6.6 收敛 |
|---|---|---|
| MSIX/SignTool | SignTool 能对包/文件签名和验证；包签名能够证明签名后数据未变化及签名者身份。签名时应明确采用包一致的摘要算法，例如 SHA-256。 | 本阶段不伪造签名。发布清单只接受 `unsigned-candidate`；未来签名门必须以 SignTool/Authenticode 验证、证书摘要和 ZIP/MSIX 摘要重新记录。 |
| SignTool 验证 | `SignTool verify /pa` 按默认认证策略验证签名；成功/失败/告警存在明确退出码。 | Windows 验证脚本对候选包只执行 ZIP/manifest/SHA-256 自检；签名验证另作为缺失且阻断 release promotion 的外部发布门。 |
| SBOM | Microsoft SBOM Tool 支持 SPDX 2.2/3.0，并将发布目录文件纳入 SBOM；可单独校验。 | 为最小无第三方依赖的 helper 输出手工、结构可校验的 SPDX 2.2 JSON。未来接入正式工具链后可替换生成器，但清单、摘要与发布门的字段保持稳定。 |

## 候选包内容

| 文件 | 作用 | 约束 |
|---|---|---|
| `awo-native-host-helper.exe` | 最小 Windows x64 native host：仅支持 `release-info` 与 `health` 的 length-prefixed JSON 读取请求。 | 没有文件系统代理、shell、网络、管理、bridge trust 或构件执行能力。 |
| `release-manifest.json` | 版本、平台、架构、协议、构件摘要、SBOM 摘要、签名状态。 | 签名状态固定为 `unsigned-candidate`，不得由打包过程改写为 signed/released。 |
| `sbom.spdx.json` | 最小 SPDX 2.2 SBOM。 | 只描述 helper 自身与 Rust 标准库构建事实；不伪造依赖/许可证。 |
| `SHA256SUMS.txt` | 包内文件摘要清单。 | 打包后重新计算并验证；任何差异均失败关闭。 |
| `VERIFY-CANDIDATE.ps1` | 只读包验证器。 | 不安装、解压到系统路径、执行 helper、导入证书或调用 SignTool signing。 |

## Windows 本机构建与候选验证记录

已在连接的 **Windows 11 Home x64 / Rust stable x86_64-pc-windows-msvc / PowerShell 5.1** 环境中成功执行：helper 的 `cargo test --locked`、`cargo build --locked --release --target x86_64-pc-windows-msvc`、候选打包、staging 目录验证、ZIP 外部 SHA-256 验证与 ZIP 内文件白名单验证。候选 ZIP 固定包含 helper、最小 SPDX SBOM、发布清单、包内 SHA-256 清单与只读验证器。

该记录属于 **runtime-confirmed 的候选构建/摘要完整性验证**。它不包含项目代码签名、时间戳、证书信任链、MSIX、安装、Microsoft Store 提交、bridge 注册或 trust promotion。候选包的 `signingStatus` 固定为 `unsigned-candidate`，依旧只能处于隔离状态。

## Windows 发布门

1. 候选包仅允许 Windows x64；helper 的 PE 目标必须是 `x86_64-pc-windows-msvc`。
2. 打包前后的 manifest、SBOM、二进制与摘要清单均须一致；验证脚本必须成功。
3. `unsigned-candidate` 是唯一自动可生成的状态；任何 `signed`、`trusted`、`released` 字样都必须由未来、独立的真实 SignTool 验证流程产生。
4. 将来导入证书、签名或上传 Microsoft Store 前，应先请求操作确认；当前阶段完全不触发这些外部/敏感发布操作。
5. 发布候选包绝不自动登记 P6.4 bridge、升级 P6.5 release evidence、发放管理 attestation 或加载/激活构件。

## 参考资料

[1]: https://learn.microsoft.com/en-us/windows/msix/package/sign-app-package-using-signtool "Sign an app package using SignTool"
[2]: https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature "Use SignTool to verify a file signature"
[3]: https://github.com/microsoft/sbom-tool "Microsoft SBOM Tool"

[1] [2] [3]
