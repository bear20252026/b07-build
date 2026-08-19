# Knowledge Workspace 与引用工作流设计笔记

**作者：Manus AI**  
**日期：2026-08-19**

## 可复用的公开模式

AnythingLLM 明确区分线程范围的临时附件与工作区范围的嵌入文档；后者可被同一工作区的所有线程检索，而 RAG 仅选择少量相关片段以避免超过上下文窗口。[1] Open WebUI 将知识库作为可附加的作用域，允许重点检索与全文上下文两种模式，并强调检索结果应带出处；其目录组织不改变同一知识库的检索边界。[2] 旧版 AnythingLLM RAG 说明模型只能看到已嵌入当前 workspace 的文档，而不是自动浏览完整文件系统。[3]

| 本项目决策 | 公开模式依据 | 强制边界 |
| --- | --- | --- |
| 每个文档必须绑定单一 `workspaceId`，检索请求也必须带 workspaceId | 工作区决定模型可见的嵌入文档。[1] [3] | 不做跨工作区默认搜索；未绑定范围即拒绝。 |
| 每次检索返回 `RetrievalPlan`（范围、查询、模式、排序理由、预算）与可验证引用 | 聚焦检索只选择有限相关片段；知识回答需要出处。[1] [2] | 结果 citation 必须能反查到同一工作区的文档和分块。 |
| 支持 `focused` 和 `full_context`，全文仅对已显式固定的短文档开放 | RAG 和全文注入使用场景不同。[2] | 全文受单文档和总 token 预算硬限制，不能绕过上下文装配预算。 |
| incognito 禁止摄取、索引和检索持久知识 | 本项目既定隐私不变量。 | 不允许创建 workspace 文档或返回既有工作区内容。 |

> **实现边界：** Knowledge Workspace 只管理文档归属、检索计划与引用验证；它不解析不受信任文件、不调用模型、不授予工具权限。文档解析仍位于受控 Python sidecar/工具路径。

## 参考文献

[1]: https://docs.anythingllm.com/chatting-with-documents/introduction "AnythingLLM: Using Documents"
[2]: https://docs.openwebui.com/features/workspace/knowledge/ "Open WebUI: Knowledge"
[3]: https://docs.useanything.com/chatting-with-documents/rag-in-anythingllm "AnythingLLM: RAG in AnythingLLM"

## References

[1] [AnythingLLM: Using Documents](https://docs.anythingllm.com/chatting-with-documents/introduction)  
[2] [Open WebUI: Knowledge](https://docs.openwebui.com/features/workspace/knowledge/)  
[3] [AnythingLLM: RAG in AnythingLLM](https://docs.useanything.com/chatting-with-documents/rag-in-anythingllm)
