// crates/process-supervisor/src/lib.rs —— 一个文件=一个作用：crate 根，仅声明模块
pub mod command_policy;
pub mod control_plane;
pub mod extension_host;
pub mod mcp_stdio;
pub mod resource_isolation;
pub mod scheduler_stats_ipc;
pub mod supervisor;
