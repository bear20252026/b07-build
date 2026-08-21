# P1–P2：Workbench 简洁体验、受控 API 与动态玩偶实施规格

**日期：** 2026-08-21
**范围：** Windows x64 AI Work OS；受控本机 Gateway；第三方 API 显式连接；不改变首页极简信息架构。

## 目标

P1–P2 的目标是将现有的真实能力呈现得更简洁、更具层次，而不是增加一个视觉空壳。首页保持任务发起、Profile、项目入口、模板、工作方式与模型连接摘要；Provider、连接测试、知识导入、运行记录、扩展和安全控制仍只位于二级页面。所有可点击控件均必须具备明确行为、禁用原因、`title` 悬浮说明或可见说明文本。

| 主题 | 设计决定 | 不允许的退化 |
| --- | --- | --- |
| Provider | 保留“选择 → 最少字段 → 保存 → 已连接模型中显式启用/测试/受限推理”的真实调用链。 | 不将 API key 回显、持久化或放入任务事件；不以假成功替代 Gateway 返回。 |
| 动态玩偶 | 使用现有原创 PNG 作为身份锚点，以 CSS transform/keyframe 与显式点击/键盘交互表现 idle、attention、celebrate 三种本地 UI 状态。 | 不把角色映射为独立 Agent、权限或后台执行者；不通过外链脚本、视频播放器或高频动画增加启动负担。 |
| Gateway | 将资源创建与领域服务装配拆为独立 feature composition，Gateway root 只保留路径解析、组装顺序、HTTP host 启动。 | route 直接创建 SQLite、读环境变量或监听端口；为缩短代码删除 close 责任。 |
| Workbench | 将 App 的页面状态/任务水合/Provider 控制面拆为独立 hook 或 controller；页面只消费 view model 与 intent。 | UI 导入 `node:`、SQLite、`process.env`、凭据、绝对路径。 |
| 知识 | 用户明确选择来源，导入状态机可取消与恢复，检索范围可见且引用可审查。 | 自动扫描本地文件、上传用户内容、在 DTO 回显全文/路径。 |
| 性能 | 从 bundle 预算扩展至冷启动、Gateway ready、首屏可输入、RSS、SQLite p95、事件积压。 | 为指标通过而取消 WAL、审计、审批或收据。 |

## 动态玩偶交互规格

动态玩偶位于左侧栏工作区态，仅作为阅读和情绪提示，不承载业务控制。角色选择仍然只切换视觉风格。动画必须尊重 `prefers-reduced-motion`，在系统降低动态效果时停用连续位移并改为静态 focus ring。

| 状态 | 触发 | 动效 | 文本与可访问性 |
| --- | --- | --- | --- |
| `idle` | 默认、无请求 | 低频呼吸、轻微漂浮、光晕脉冲；总时长 ≥ 4s。 | `aria-live` 不播报；按钮名称含角色和职责。 |
| `attention` | 鼠标悬停、键盘聚焦、角色切换 | 轻微抬升与点头；显示角色职责提示。 | 通过 `title` 和 tooltip 描述“仅改变界面风格，不改变 Agent 或权限”。 |
| `celebrate` | 用户切换角色后短暂触发 | 单次弹跳和星点 CSS 伪元素，完成后回到 idle。 | 不播报成功执行，不暗示任务已完成。 |

## Provider 简洁菜单规格

Provider Setup 继续采用三步，但预设卡片改为更紧凑的菜单式选择：每一服务都有名称、兼容协议、默认模型与 tooltip。保存成功后，页面有明确“前往已连接模型”操作；在连接列表中由状态决定唯一主动作：登记、启用或测试。受限文本请求是展开式区域，只有 active profile 才会出现。

| 交互 | 真实行为 | 失败/禁用语义 |
| --- | --- | --- |
| 保存连接 | 调用 Gateway session-only 连接登记接口。 | Gateway 未启动、key 为空或自定义 URL 不合规时不可提交。 |
| 登记连接 | 创建 Profile metadata。 | 不发送模型请求。 |
| 启用 Profile | 使用 Gateway 中可用凭据引用启用。 | 缺凭据引用时禁用并说明原因。 |
| 测试连接 | 由操作者点击后执行受限只读 probe。 | 显示可达性、延迟或账户/网络失败。 |
| 发送文本请求 | 只向 active provider 发出一次受限文本推理。 | 不启动工具、MCP、Shell、浏览器或其他 Provider。 |

## 代码实施顺序

1. 提取 Gateway 的路径、store、provider、control-plane 和 lifecycle feature composition，并以显式 close 组合保留所有资源关闭顺序。
2. 提取 Workbench controller/hook，先保持外部 props 与 Gateway DTO 不变，再在二级 Settings 中升级紧凑菜单和工具提示。
3. 实现 `CompanionPresence` UI 组件与定向测试，不新增远程资产或系统权限。
4. 建立知识导入状态机、范围选择和摘要/预算 DTO；在完成可恢复账本前不更换检索算法。
5. 增加 Windows 性能采样，先报告后阻断；Skill Pack 只增加审查证据，不增加可执行入口。

## 验收

- `gateway-application.ts` 不超过 220 行，且 composition helper 各自只有明确的资源所有权。
- `App.tsx` 不超过 420 行，页面导航、任务水合和 Provider 控制面都有独立定向测试。
- 动态玩偶在鼠标、键盘和 `prefers-reduced-motion` 场景下均可用；不会触发 Gateway 请求。
- Provider 关键操作仍经过现有真实 Gateway client，API key 不出 Gateway 进程内存。
- 全量架构、TypeScript、测试、Workbench build、Rust、Python、sidecar、供应链与 CSP 契约均通过。
