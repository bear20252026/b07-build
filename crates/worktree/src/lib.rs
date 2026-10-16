// crates/worktree/src/lib.rs —— 一个文件=一个作用：crate 根，仅声明模块
//
// 工作树隔离（对应 b07 的 Claude Code 7 项工程设计基线之「基线 6：会话、任务与
// 工作树隔离」）。设计研读自 Claude Code 还原源码 `src/utils/worktree.ts`（1519 行），
// 本 crate 为 Rust 独立实现，不搬运上游代码。设计约束来源与差异见
// `THIRD-PARTY-NOTICES.md`。
//
// 模块划分（一文件=一作用）：
//   slug      —— slug 校验与拍平（路径穿越防护 + 单射映射）
//   session   —— 工作树会话状态与生命周期语义
//   paths     —— 目录/分支命名策略（唯一命名事实源）
//   dirty     —— 变更探测（fail-closed）
//   git_env   —— 无提示的 git 子进程环境
pub mod dirty;
pub mod git_env;
pub mod paths;
pub mod session;
pub mod slug;
