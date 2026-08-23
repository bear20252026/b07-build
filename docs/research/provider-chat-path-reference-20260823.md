# Provider 测试与真实聊天调用链参考（2026-08-23）

## 外部来源

- OpenWorker 仓库与 README：https://github.com/andrewyng/openworker
- AtomCode 仓库：https://atomgit.com/atomgit_atomcode/atomcode

## 可核验结论

OpenWorker 的 README 描述其桌面应用由原生 Shell 与 GUI、同机 Python agent server、工具和模型 Provider 组成；Tauri Shell 在完整桌面模式下负责监督本地服务。README 也明确区分开发时基于 user-only sidecar token 的调用和桌面应用的 in-memory launch token。

对 AI Work OS 的直接 Provider 聊天故障，适合借鉴的不是其本地服务结构本身，而是以下职责边界：配置、模型选择、真实请求和流式事件应当使用同一个已验证的 Provider 会话快照；每一次请求应当保留可诊断但不含密钥的 URL 协议、模型、HTTP 状态和超时阶段。

AtomCode 的公开仓库说明其面向终端的 AI 编码交互、任意模型连接和实时流式 Markdown 渲染。它可作为“真实会话请求与 UI 流事件必须同链路”的交互参考；本轮不复制其实现。

## 当前 AI Work OS 初步差异

当前 Rust 原生层的 `probe_direct_provider` 和 `start_direct_provider_stream` 都复用 `url_for`、`headers_for` 与 `payload_for`。不过真实聊天会带入完整会话、附件文本、研究原文和图像内容块，而探测只发送单句文本；因此供应商在超长载荷、流式连接、特定模型或多模态字段上失败时，现有 UI 容易被统一映射为“第三方服务未响应”。

后续修复应让聊天使用与测试一致的会话快照，并为真实聊天增加不泄露密钥的请求诊断和本地回归测试：基础单消息流、历史消息流、长上下文流、图片请求流、HTTP 非成功和流中断。
