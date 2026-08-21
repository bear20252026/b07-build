# P18：三步式第三方 API 连接与精简页面导航设计

**状态：** 已设计，待实现

## 1. 体验目标

连接一个已知第三方模型时，用户在一张页面内完成：**选择服务 → 粘贴 key → 保存并在需要时手动测试**。自定义 Provider 也保持同样的三步结构；由于远程兼容服务必须明确协议、Base URL 和模型名，这三项被聚合在第二步的“连接信息”块内，而不会拆成额外页面或额外导航层。

> **原则：** 本机 Gateway 是连接控制点，不是“第四步”。用户点保存后，Gateway 才从当前 WebView 接收 key 并按已选择的远程 Provider 发起真实请求；响应只返回本机 Workbench 展示和受控任务运行时。

## 2. 新页面结构

| 步骤 | 已知 Provider | 自定义 Provider | 主动作 |
|---|---|---|---|
| 1. 选择服务 | 紧凑 Provider 卡片组；DeepSeek 默认选中 | 选择“自定义兼容 API”后，才显示 OpenAI / Anthropic 协议二选一 | 选中一张服务卡片。 |
| 2. 填写连接 | 默认仅显示 API key；显示已选服务和默认模型。显示名与模型覆盖收进“调整模型”折叠项。 | Base URL、模型名、API key 同处一个连接块，紧随远程数据提示。 | 粘贴 key；自定义时补齐必填 endpoint/model。 |
| 3. 保存并测试 | 保存会话连接；成功后显示“已连接到本机 Gateway”与“稍后手动测试”出口。 | 同左；custom 不会持久化到下一次 Gateway 会话。 | 明确点击“保存连接”；测试永远不是自动动作。 |

## 3. 页面跳转

连接页只保留两个外部跳转：顶部“返回工作区”和成功状态中的“查看已连接模型”。这遵循 AFFiNE Page Mode 的线性阅读顺序：每个内容块在同一页自然向下，不要求用户在设置树中跳转完成一个动作。[1]

服务卡选择和协议选择只是同页局部状态，不改变 URL、不启动 Gateway、不探测远程服务。保存成功后才更新当前页面的连接状态；用户若选择“查看已连接模型”，才进入 LobeHub 式的独立管理视图做显式 probe 或受限文本试用。

## 4. 文案与视觉

保留既有黑白主题、圆润表面和语义状态色。移除长段说明，改为短句：

| 位置 | 文案 |
|---|---|
| 顶部 | “三步连接第三方模型。所有请求由本机 Gateway 发起，结果回到本机工作台。” |
| 已知服务 key | “只需粘贴 API key；默认模型已为你选择。” |
| 自定义连接 | “你的提示会发送到该服务。只接受公开 HTTPS Base URL。” |
| 完成状态 | “连接仅在当前 Gateway 会话有效。可在已连接模型页手动测试。” |

## 5. 不变量

P18 不修改 Provider catalog、HTTP 路由、custom URL 验证、密钥会话保管、driver、SSE、任务运行时或审批链。它只重组 Workbench 页面显示和同页状态，以减少认知负担而不通过“自动连接”降低用户控制。

## References

[1]: https://docs.affine.pro/core-concepts/elements-of-affine/page-mode "AFFiNE Page Mode"
[2]: https://docs.affine.pro/core-concepts/elements-of-affine/workspaces "AFFiNE Workspaces"

## 浏览器级验证

P18 的真实 Workbench 页面以连续三块呈现：步骤 1 Provider 卡片，步骤 2 连接字段，步骤 3 保存与后续手动测试。DeepSeek 等已知 Provider 选中后仅显示 API key 和“调整模型或名称（可选）”；点击 custom API 后，同一页面的步骤 2 才按需展开 OpenAI / Anthropic 协议、HTTPS Base URL、模型名称、显示名称与 API key。两种路径均没有自动附着 Gateway、自动保存、自动 probe 或远程请求。

## 最终验证

P18 在实际浏览器中验证了已知 Provider 的“仅 key 默认字段 + 可选模型调整”和 custom Provider 的“按需展开协议/URL/模型”两条路径；两条路径均停留在同一页面，保存前不会附着 Gateway、提交凭据、probe 或调用远程 API。

全量质量门通过：架构检查、严格 TypeScript、225/225 测试、Workbench 生产构建、Rust process supervisor 11/11、Windows helper 2/2、Python sidecar 编译、Gateway sidecar 打包、生产依赖审计 0 vulnerabilities、桌面 CSP/sidecar 契约 7/7。P18 只改动页面层，不增加远程服务、浏览器直连 Provider、API key 持久化或自动请求。
