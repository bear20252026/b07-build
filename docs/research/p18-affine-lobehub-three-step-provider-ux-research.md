# P18：AFFiNE / LobeHub 三步 Provider 连接体验调研

**日期：** 2026-08-21

## 1. AFFiNE 可本地化的页面设计原则

AFFiNE 将 Page Mode 定义为随屏幕响应的线性阅读页面，并把块视作可互换的内容单元；Edgeless Mode 则承担无限画布。这说明高频、目标明确的连接配置不应模拟复杂画布，而应使用有稳定阅读顺序的线性块式流程。[1]

AFFiNE Workspace 文档区分本地工作区和云工作区，并将本地设备持有的数据与云端同步能力分开说明。[2] 对 AI Work OS 的适配是：Provider 本身远程运行，但用户的配置动作、会话 key、请求编排、任务记录和模型响应展示由本机 Gateway / Workbench 承担；不把连接设置页面设计成账户托管或服务器同步页面。

| AFFiNE 原则 | P18 本地化到 API 配置 |
|---|---|
| 线性、响应式 Page Mode | 一张连续配置页，不让用户在设置树中寻找多处字段。 |
| 可组合 blocks | 每一步是独立 block：选择、连接、验证；状态只在对应 block 内出现。 |
| 明确阅读顺序 | 页面顺序固定为“服务 / 协议 → 最小字段 → 保存并测试”。 |
| 右侧面板不取代阅读主线 | 已连接模型仍是后续管理页，而不是初次配置的必经步骤。 |

## 2. LobeHub 可本地化的组织原则

LobeHub 公开资料将 Provider 管理定位为独立的模型配置能力，支持多 Provider 和自定义 Provider。其可借鉴之处是“模型目录选择”和“已连接模型管理”分离，而不是复制其服务端部署或品牌页面。公开产品页仍以 Agent、任务与工作区为持续可见的工作单元。[3]

P18 保留该分离：首次连接只完成到“可用 session”，已连接模型页才提供手动 probe / 受限文本试用。所有真实第三方 API 调用继续只通过 `127.0.0.1` Gateway 发起；浏览器不会直接持有或发送 Provider key。

## 3. 三步 UX 结论

| 步骤 | 用户动作 | 页面只展示 | 页面不展示 / 不执行 |
|---|---|---|---|
| 1. 选择 | 选常用服务，或选自定义兼容协议 | Provider 卡片、协议、默认模型建议 | endpoint 细节、调试选项、连接历史。 |
| 2. 连接 | 填 API key；自定义时额外填 HTTPS Base URL | 显示名、模型名、必要的 Base URL 与远程数据提示 | header、driver、请求 body、工具列表、任何隐藏字段。 |
| 3. 确认 | 保存并启用；必要时进入后续页手动测试 | 一句本机 Gateway / 会话内 key 状态反馈 | 自动 probe、自动推理、自动联网或后台任务。 |

P18 的视觉策略保持既有黑白主题与圆润块表面：减少解释性段落，将每个步骤限制为一个标题、一行帮助、一组输入或卡片和一个清晰的主动作。页面跳转只有“返回工作区”“查看已连接模型”两个低频出口。

## References

[1]: https://docs.affine.pro/core-concepts/elements-of-affine/page-mode "AFFiNE Page Mode"
[2]: https://docs.affine.pro/core-concepts/elements-of-affine/workspaces "AFFiNE Workspaces"
[3]: https://lobehub.com/ "LobeHub"
