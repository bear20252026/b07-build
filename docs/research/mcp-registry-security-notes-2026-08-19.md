# 受控 MCP 注册表安全设计笔记

**作者：Manus AI**  
**日期：2026-08-19**

## 可复用的公开安全原则

MCP 安全文档指出本地 MCP server 可直接接触用户系统，因此启动命令和下载载荷必须在执行前得到审查与同意；OAuth 场景还必须实行按客户端的明确同意、精确 redirect URI 校验和状态校验。[1] Open WebUI 将 MCP server 注册限制为管理员操作，并说明 MCP 的状态与能力范围远大于固定 HTTP/OpenAPI 接口；已登记 server 仍需在具体会话中启用工具。[2] OpenCode 以 allow / ask / deny 表达权限，并说明显式 deny 在自动模式下仍应生效。[3]

| 本项目决策 | 公开模式依据 | 强制边界 |
| --- | --- | --- |
| MCP manifest 默认为 `registered`，只有操作者显式 `enable` 后才可供运行时查询 | MCP server 需管理员登记；会话工具需明确启用。[2] | 禁止自动安装、自动下载、自动启动和自动连接。 |
| manifest 仅记录 transport、端点/命令摘要、风险、声明工具与哈希；不保存密钥 | MCP server/工具属于高权限边界，凭据与授权须单独管理。[1] [2] | 不接受 token passthrough；注册表不存 OAuth token/API key。 |
| 每个工具须在 declaredTools 白名单中，按风险映射为 allow/approval/deny，外部能力仍受既有 CapabilityPolicy 收紧 | 显式 deny 不得被自动批准覆盖；工具范围需受控。[3] | manifest 不能放宽默认拒绝 CapabilityPolicy。 |
| 支持 append-only 审计状态 (`registered → enabled → disabled/revoked`) | 明确同意和审计是 MCP 代理安全控制基础。[1] | 禁用或撤销后无运行时可用条目；历史保留供审查。 |

> **实现边界：** MCP Registry 不解析或运行 MCP 协议、不会启动 stdio 命令、不会下载包，也不接触 OAuth token。它仅输出经审查、显式启用的不可变 manifest DTO；真实连接必须经后续受控工具运行器和审批层。

## 参考文献

[1]: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices "MCP Security Best Practices"
[2]: https://docs.openwebui.com/features/extensibility/mcp/ "Open WebUI MCP"
[3]: https://opencode.ai/docs/permissions/ "OpenCode Permissions"

## References

[1] [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)  
[2] [Open WebUI MCP](https://docs.openwebui.com/features/extensibility/mcp/)  
[3] [OpenCode Permissions](https://opencode.ai/docs/permissions/)
