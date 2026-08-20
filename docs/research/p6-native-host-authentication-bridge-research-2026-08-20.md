# P6.4：可信原生宿主认证桥调研

**日期：** 2026-08-20
**证据边界：** 本阶段会交付 **source-confirmed** 的 typed challenge、签名验证抽象、nonce 一次性消费、issuer/action/payload 绑定、进程内 Gateway 端口及单元/loopback 回归。不会声称已完成 Windows/macOS/Linux 代码签名、OS keystore、Chrome Native Messaging manifest 或 WebView2 实机来源验证；这些属于 **requires runtime evidence** 的后续发布门。

## 外部基线与收敛设计

| 基线 | 官方要求/建议 | P6.4 收敛实现 | 证据状态 |
|---|---|---|---|
| Chrome Native Messaging | 宿主 manifest 以无通配符 `allowed_origins` 限制扩展来源；宿主可使用传入调用 origin 识别消息来源；通信是独立进程的长度前缀 JSON。 | 不将浏览器 window label、HTTP header 或 renderer payload 当 issuer。仅接收 future native bridge 已验证的 `NativeHostAuthenticatedEnvelope`，并要求固定 `bridgeId` / `issuerId` / scope。 | source-confirmed；实际 manifest/调用 origin 需 runtime evidence。 |
| WebView2 安全指南 | 所有 Web 内容不可信；每次接收 Web message/host 参数前验证 origin；避免 generic proxy；保持 WebView host 非提升权限，提升工作隔离到专用进程。 | 浏览器永不获取 challenge、签名私钥、管理 attestation 或 `manage()`；认证服务没有 HTTP route，WebView/renderer 输入不能跨越 native bridge。 | source-confirmed；实际 WebView origin/进程完整性需 runtime evidence。 |
| OWASP replay 防护 | nonce 唯一、短时、消费后拒绝重放；验证时限与消息绑定。 | challenge 有短 TTL、issuer/bridge/action/component/payload digest 绑定、append-only consumed nonce store；签名失败、过期、错配、重放均失败关闭。 | source-confirmed。 |

> “Always check the origin of the document … Validate web messages and host object parameters before consuming them … Avoid generic proxies.” — Microsoft WebView2 security guidance。[2]

## P6.4 契约

| 组件 | 输入 | 输出 | 强制拒绝 |
|---|---|---|---|
| `NativeHostChallengeIssuer` | 进程内 host 请求（仅受信 issuer）+ 固定 action/component/payload digest | 有效期 ≤ 60 秒、单次 nonce、canonical challenge digest | HTTP/renderer 请求、未知 issuer、任意 action、空/不合规摘要 |
| `NativeHostEnvelopeVerifier` | challenge + native bridge 提供的验证签名/调用来源 facts | 受限的 `VerifiedComponentManagementAttestationV1` | 非 allowlist bridge、issuer/bridge/scope 错配、签名无效、过期/消费 nonce、challenge 内容替换 |
| `ComponentManagementAuthority` | 仅上述验证后的 attestation | 构件管理回执 | 不会下载、扫描、安装、加载、激活、自动升级 |
| Gateway/Workbench | 只读认证摘要 | 无敏感字段的审计 report | 不暴露 challenge、nonce、签名、payload digest、管理入口 |

## 平台发布门（本阶段未宣称完成）

1. Windows：native bridge 必须运行在标准用户完整性；若有高权限工作，必须分离为专用、最小接口的进程，并在真实 WebView2 `Source` 上执行来源门禁。[2]
2. macOS/Linux：必须使用操作系统认可的签名/沙箱/密钥材料与固定 helper bundle identity；不能以路径、进程名或 UI label 代替。
3. Chrome/Edge 扩展宿主：native messaging manifest 的 `allowed_origins` 必须为精确 extension ID，禁止通配符；需要真实安装包与浏览器环境测试。[1]
4. 所有平台：在发布 CI 中记录签名身份、二进制摘要、桥协议版本、失败闭合测试与 nonce 重放回归；任何证据缺失阻断“可信宿主已验证”的发布声明。

## 参考资料

[1]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging "Chrome Native Messaging"
[2]: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security "Develop secure WebView2 apps"
[3]: https://scs.owasp.org/SCWE/SCSVS-COMM/SCWE-022/ "OWASP SCWE-022: Message Replay Vulnerabilities"

[1] [2] [3]
