# 由账号2生成
<!-- file-id: acct2-20260819-tauri-phenomenon-architecture ; 作者: 账号2 ; 日期: 2026-08-19 -->

# "AI 执行桌面端" 现象级产品 · Tauri 架构定稿

> 以你指定的架构（Tauri 2 + Rust 本地控制平面 + TS Agent 编排 + Python 重计算 + SQLite 事件日志 + 统一接口）为基准，融合全部 30 个开源项目优势，再平衡成一块「现象级产品」拼合架构。
> 可行性已验证：AgentForge（Tauri2+Node SEA sidecar）、OpenWorker（Tauri2+Python FastAPI sidecar+离线STT）、cc-switch（Tauri2 Rust 控制平面+进程内 axum 代理）三条真实路线全部落地过本方案。

## 一、总体架构（一壳三语，各司其职）

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri 2 壳 + React/Vite 前端（渲染层）                       │
│  业务走 FS→HTTP/WS 直连 sidecar；系统级走 Rust invoke         │
└───────────────┬──────────────────────────┬───────────────────┘
                │ invoke(系统能力)          │ HTTP/WS(业务,带token)
┌───────────────▼───────────┐  ┌───────────▼───────────────────┐
│ Rust 本地控制平面           │  │ TS Agent 编排引擎 (domain pkg) │
│ ·窗口/生命周期/崩溃恢复      │  │ ·Agent Loop/上下文/工具编排     │
│ ·权限与密钥(安全边界)        │  │ ·Provider API + MCP            │
│ ·子进程监督(拉起/自杀/日志)   │  │ ·事件协议(JSON-RPC/EventStream)│
│ ·SQLite + append-only 事件日志│ │  更新 → Rust / 重算 → Python    │
│ ·沙箱/更新/托盘/离线STT(Rust) │  └───────────┬───────────────────┘
│ ·进程内代理(cc-switch式)     │              │ 重计算调用
└───────────────┬───────────┘  ┌───────────▼───────────────────┐
                │ sidecar拉起   │ Python sidecar（重计算/文档）    │
                └──────────────→│ ·文档解析/OCR/Embedding/RAG    │
                                │ ·语音(Whisper)/本地模型适配      │
                                │ ·FastAPI /v1 + WS（OpenWorker式）│
                                └─────────────────────────────────┘
```

## 二、三语言职责边界（任务 #3 的第 2 步）

| 层 | 语言 | 职责（只做这些） | 参考项目 |
|---|---|---|---|
| **壳/控制平面** | **Rust** | 窗口/生命周期、崩溃恢复、子进程监督（拉起 Python sidecar、随父自杀、日志）、权限与密钥（安全边界）、SQLite+事件日志、进程内代理、沙箱、自动更新、离线 STT（ocw-stt crate）、托盘 | cc-switch（重控制平面）+ OpenWorker（监督）+ AgentForge（薄壳） |
| **Agent 编排** | **TypeScript** | Agent Loop、上下文治理、工具编排、Provider API、MCP、事件协议实现、插件/Skill | 对标 ClaudeCode query.ts + CoreCoder agent + Lobe/AionUi |
| **重计算** | **Python** | 文档解析、OCR、Embedding、RAG、语音、本地模型适配——迭代快的重活下沉，不阻塞 shell | OpenWorker（FastAPI sidecar）+ AnythingLLM collector |
| **数据** | SQLite + append-only | 本地优先、可审计、可恢复、为团队同步留位 | cc-switch(DB) + OpenWorker(append-only) |

## 三、通信协议（任务 #3 的第 3 步）——统一接口

**统一调用面：Provider API + MCP + JSON-RPC/Event Stream，语言无关**

1. **前端 → Rust（系统能力）**：`tauri invoke` + Event（托盘/代理 failover 推送）。只管窗口、权限、STT、更新、崩溃。
2. **前端 → TS 编排引擎 → sidecar（业务）**：
   - **HTTP/SSE 流式**（对话/工具事件）：AgentForge 式 fetch + SSE（token/thinking/tool_start/approval_request）
   - **WebSocket 事件流**（会话/审批/后台任务）：OpenWorker 式 `ws/session/{id}` + `ws/events`
   - 鉴权：Rust 生成 **launch token** 注入 `initialization_script` 全局（`__API_TOKEN__`），REST 走 header、WS 走 subprotocol
3. **TS → Rust（写事件日志/权限）**：JSON-RPC 事件上报（可审计、可恢复）
4. **TS → Python（重计算）**：JSON-RPC over 本地 HTTP/WS——文档解析/Embedding/RAG/STT 请求，**语言无关的事件协议**（事件 schema 用 JSON，跨三语共享）
5. **安全边界**：本地服务器一律绑定 `127.0.0.1`，token 鉴权 401，CORS 固定本地 webview（OpenWorker `require_sidecar_token` 模式）

## 四、最小接口路线（保留，接口少好维护）

| # | 协议类 | 覆盖 |
|---|---|---|
| ① | OpenAI Chat Completions | OpenAI/DeepSeek/Qwen/MiniMax/Kimi/智谱/Groq… **统一 golang-like base_url** |
| ② | Anthropic Messages | Claude |
| ③ | Google Gemini | Gemini |
| ④ | **自定义 OpenAI 兼容端点** | **自建服务器落点**（含在接口内，不新造） |
| ⑤ | OpenAI Responses API | Codex 新规范（可选） |
| ⑥ | LiteLLM 兜底 | 上百家非兼容 provider |

→ **Rust 进程内代理**（cc-switch axum 式）做统一网关：模型路由、故障转移、多 key 轮换（AionUi RotatingApiClient）。Provider 注册表 + models.dev 元数据 + 厂商别名归一（Eigent）。

## 五、融合优势清单（30 项目取长补短，落到哪层）

- **Rust 控制平面**：cc-switch（SQLite+进程内代理+配置管理+崩溃恢复）+ OpenWorker（监督+免费端口+launch token+keep-awake)+ AgentForge（sidecar 拉起/注入 env/退出清理）
- **离线 STT**：OpenWorker `ocw-stt`（Rust whisper-rs+cpal）
- **TS Agent 引擎**：CoreCoder agent.py 逻辑（for 上限+中断回填+工具配对）+ ClaudeCode query.ts（4 层上下文+孤儿 tool 防护）+ ClawCode Provider trait+审批台账 + DeepSeek Harness 一切皆插件 + OpenWorker TurnEngine 装配（权限+AGENTS.md+记忆+skill 增量展示）+ AgentForge loop 守卫
- **工具/权限（安全边界）**：ClaudeCode Hook 链（参数校验→规则→确认→Hook→执行→回写）+ CoreCoder bash 黑名单 + unique-edit + 路径穿越防御 + ClawCode ApprovalTokenLedger + OpenWorker workspace trust/auto_allow/append-only 审计
- **多 Agent/ACP**：AionUi ACP 桥（统一 adapter 管 IPC+WebUI）+ Team Mode + RotatingApiClient + 平台服务抽象；OpenClaw 157 渠道 + Gateway；LobeHub 7×24
- **桌面自动化/模态**：UI-TARS（字节屏幕/GUI）+ Wove CDP + PiDesk + Witsy 引擎清单（图/音视频/PDF/YouTube）
- **RAG/本地**：AnythingLLM 文档管道 + ModelRouter；Askimo 离线 BM25；Jan 本地 llama.cpp；ClawCode qdrant
- **UI/生态**：Cherry 商业 UI + workspaice OAuth/model-registry + aime-chat 协议最全 + 5ire MCP

## 六、数据层：SQLite + append-only 事件日志
- 主状态（provider/session/profile）→ SQLite（rusqlite，cc-switch 式）
- **append-only 事件日志**（每次工具执行/Hook 决策/审批/模型调用/崩溃）→ 可审计、可恢复、可团队同步（OpenWorker append-only 审计 + ClaudeCode#6 会话/任务/工作树隔离）
- 可选对象存储（大附件/模型缓存）
- 工作树隔离 + 会话持久化 + 后台任务恢复

## 七、商业化（现象级差异化）
- **BYOK + 免费本地核心**（降低冷启动阻力）
- **云同步 / 团队治理 / 企业部署 / 模型路由**（增值，不锁死单模型）
- 三端（桌面+iOS/Android+WebUI 远程）：OpenWorker/AionUi 的浏览器+桌面同一代码库范式
- 差异化卖点：**工具执行安全边界（审计日志）+ 统一接口（云/本地/CLI/GUI Agent 全兼容）+ 离线能力（本地推理+STT）+ 隐私**

## 八、工程与实施（从拼合到现象级）
**分层测试**：协议 mock（ClawCode mock-anthropic 差分）+ Agent loop（可替换模型/工具）+ 工具（孤儿 tool/路径穿越/并发竞态，CoreCoder 86 测试）+ 三语言集成测试
**CI/build**：Rust cargo + TS tsc/vitest + Python pytest；electron/PyInstaller 打包；三平台矩阵
**里程碑（每步可交付）**：
1. Rust 控制平面壳 + TS 引擎 + 4 协议 + Provider + 会话/日志 + 7 工具 + 权限 Hook → CoreCoder 水平
2. React UI 商用化 + 注册表 + models.dev + RAG → Cherry/Lobe 水平
3. Agent 进阶（4 层压缩/子代理/Team/ACP/MCP 全能力）→ AionUi/ClawCode 水平
4. 自动化/模态（浏览器/图音/桌面控制/离线STT）→ UI-TARS/OpenWorker 水平
5. 渠道/多端/云同步/商业化（WebUI/移动/代理网关/订阅）→ 现象级

—— 本架构已融合 30 个已存镜像项目的取长补短，接口收敛为 6 类（核心 4+自建端点+LiteLLM），三语言职责与事件协议语言无关。 ——
