# Extension Center 浏览器验证记录

**日期：2026-08-19**  
**验证范围：v0.17.0 工作台 Extension Center**

本地工作台已在 React 19、石墨浅色主题和真实本地网关连接下完成浏览器验证。验证使用临时 SQLite 目录和仅作 UI 审查的本地 metadata：一个 `model-provider` extension 与一个 Provider Profile；没有下载、加载、启动 extension，也没有提供或读取任何密钥。

| 验证点 | 结果 |
| --- | --- |
| Extension Center 初始空态 | 正常显示 `0/0`、只读控制面说明、诊断/Profile/计划空态。 |
| Gateway DTO 刷新 | 正常读取 `GET /api/extensions`、`/doctor`、`/providers/profiles`，刷新控件不触发写入。 |
| 已安装 extension 卡片 | 正常显示清单标识、revision、来源类型与摘要前缀、数据边界、声明/请求能力、资源预算、入口模式和审查 note。 |
| Provider Profile 卡片 | 正常显示 allowlist、数据边界、credential reference 名称与审核者；未显示 API key、token 或 password。 |
| 安全边界 | UI 明确提示仅读取网关 DTO，且页面不存在下载、启动、执行或授权扩展的控制入口。 |
| 视觉与布局 | 三栏石墨布局、信息层级、状态色和窄屏滚动行为正常；Extension Center 在主栏中保持紧凑可读。 |

> 本次 UI 验证不代表 extension 已被加载或执行。`installed` 仅表示受审 metadata 的摘要已被核验；真实运行仍必须经过激活计划、Rust 监督宿主、实时 policy、审批和预算。
