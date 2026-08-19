# 本地知识引用预览验收记录

**验收日期：** 2026-08-19  
**验收范围：** `SqliteVectorKnowledgeStore`、本地运行时网关与工作台右侧“引用”预览标签。

| 步骤 | 观察结果 | 结论 |
|---|---|---|
| 文档摄取 | `POST /api/knowledge/documents` 接受带 `id`、标题、`file://` 来源 URI 与文本的本地文档，并返回 1 个分块 | 文档与来源进入服务端 SQLite 向量存储；浏览器不直连数据库 |
| 相似度检索 | `GET /api/knowledge/search?q=SQLite 引用预览` 返回单一命中，包含 chunk、文档、来源、片段及 `0.3266…` 得分 | SQLite 持久化的稀疏向量检索可用于中英文混合关键词 |
| 工作台交互 | 在右侧“引用”标签输入 `SQLite 引用预览` 并提交 | 浏览器通过 `HttpKnowledgeSearchClient` 调用本地网关，而不是执行本地 SQL |
| 引用呈现 | 侧栏显示“本地知识运行时说明”、得分 `0.33`、可读片段及 `/docs/knowledge-runtime.md` 来源链接 | 每项检索结果都保有可追溯来源与片段预览 |

> 当前 Node 内置 SQLite 未提供 FTS5 模块，因此实现采用普通 SQLite 表持久化的确定性稀疏向量。该适配器符合 `SearchableKnowledgeStore` 端口；未来可在不改变工作流或工作台 DTO 的前提下替换为 SQLite FTS5、sqlite-vec 或密集 embedding adapter。
