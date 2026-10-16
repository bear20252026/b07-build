// crates/cdp-client/src/lib.rs —— 一个文件=一个作用：crate 根，仅声明模块
//
// CDP（Chrome DevTools Protocol）是本 crate 唯一的协议对象。它是一条**公开标准协议**
// （Chrome/Edge/Brave 等 Chromium 系浏览器共同暴露），不涉及任何上游仓库的代码，
// 因此本 crate 无第三方许可附着——与 `command_policy.rs` 那种"移植自 ZCode"的模块
// 有本质区别，声明策略见 THIRD-PARTY-NOTICES.md。
//
// 分层动机：浏览器自动化真正的失败点不在"连不上"，而在"连上了但把事件当响应、
// 把别人的响应当自己的、或连到了一个恶意 websocket 端点"。这三类错误都**不会**
// 表现为连接失败——它们表现为"偶尔拿到错的结果"或"结果永远不返回"。因此把它们
// 全部收敛进本 crate 的纯函数里，用纯数据单测钉死，而不是留到 tokio 层靠调试发现。
// 本 crate 的测试名用中文描述行为（仓库既有风格）。中文标识符与 `snake_case`
// 互斥——`non_snake_case` 对中文没有意义；而当测试名需要引用协议里的 camelCase
// 字段名（`profileName`/`targetId`/`timeoutMs`）时，按 snake_case 改写反而会
// 让读者对不上协议字段。故在 crate 级关闭该 lint，理由记录于此。
#![allow(non_snake_case)]

pub mod frame;
pub mod session;
pub mod target;
pub mod tool_map;
