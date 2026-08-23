# AtomCode Windows 直连兼容性对照

**核验日期：** 2026-08-23  
**目标：** 修复 AI Work OS 在 Windows 上对 MiMo 的原生 HTTPS 建连失败，不引入 Gateway。

## 现场证据

AI Work OS 0.1.5 的本地诊断报告显示：Provider 配置成功，但 `probe` 和 `stream-test` 在 691–720 ms 内均为 `provider-connect-failed`。这说明请求没有抵达认证、模型或图片能力阶段。

在同一 Windows 系统上，未携带密钥的 MiMo 中国区主机检测确认 DNS、TCP 443 和 HTTPS 响应可达。系统 Internet Settings 的静态代理同时处于启用状态且有代理服务器条目。因此，浏览器/`curl` 与 Rustls-only Tauri 客户端的网络路径不等价。

## AtomCode 对照结论

| AtomCode 实践 | AI Work OS 0.1.5 原状态 | 0.1.6 适配 |
|---|---|---|
| Windows 启用 reqwest `native-tls`，以 SChannel 兼容浏览器/系统证书及对 Rustls TLS 指纹敏感的网络。 | 仅启用 `rustls-tls`。 | Windows target 额外启用 `native-tls`，保持其他系统上的 Rustls 路径。 |
| `follow_system` 默认保留环境代理，并读取 Windows `Internet Settings` 静态代理作为后备。 | 未读取 Windows 系统代理。 | Provider HTTP 客户端只在 Windows 上读取已启用的静态 HTTPS/HTTP 代理并交给 reqwest；代理地址不会返回 WebView、聊天、诊断、日志或 Provider 上下文。 |
| 代理仅属于 HTTP 客户端网络策略，不是应用内网关或中转服务。 | 普通聊天已直接调用 Tauri 原生 HTTPS/SSE。 | 保持相同直连拓扑；不启动/不打包 Gateway sidecar。 |

## 许可证与复用边界

本轮未复制 AtomCode 源码，仅依据其 Rust `reqwest` 特征组合、系统代理策略和注释所表达的兼容性设计进行独立适配。AtomCode 的来源与许可证声明继续按项目既有第三方记录维护。

## 相关源码定位

* `atomcode-auth/Cargo.toml`：Windows 下叠加 `reqwest` 的 `native-tls` 特征。
* `atomcode-config/src/system_proxy.rs`：读取 Windows `ProxyEnable`、`ProxyServer`、`ProxyOverride` 的容错解析。
* `atomcode-config/src/proxy.rs`：默认遵循系统/环境代理而非默认为 `no_proxy`。
* `atomcode-capabilities/src/provider/openai_compat.rs`：异步 Provider 客户端在 Windows 依赖原生 TLS，并把代理策略施加在 HTTP client builder 上。
