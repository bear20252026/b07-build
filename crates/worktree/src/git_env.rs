//! 无提示的 git 子进程环境。
//!
//! 设计研读自 Claude Code 还原源码 `src/utils/worktree.ts` 的 `GIT_NO_PROMPT_ENV`
//! 常量族，为 Rust 独立实现。
//!
//! # 要解决的问题
//!
//! 工作树创建/回收会跑多条 git 命令（fetch、worktree add、worktree remove、
//! rev-list 等）。这些命令在缺凭据时会**打开终端等待输入**：
//!
//! - `git fetch` 遇到需要认证的远端会提示用户名/密码；
//! - 若配置了 GUI askpass（如 macOS 的钥匙串助手、Windows 的 Git Credential
//!   Manager），它会**弹窗**——在无人值守的宿主进程里表现为**永久挂起**。
//!
//! 对一个由产品进程驱动的 git 调用，挂起比失败更糟：调用方拿不到错误，只能等超时。
//! 因此本模块统一构造「宁可失败、绝不提问」的环境。

use std::collections::BTreeMap;

/// 关闭 git 的终端交互式提问。
///
/// `GIT_TERMINAL_PROMPT=0` 让 git 在需要凭据时**直接失败**，而不是打开 `/dev/tty`。
pub const GIT_TERMINAL_PROMPT: &str = "GIT_TERMINAL_PROMPT";

/// 禁用 askpass（GUI 凭据助手）。
///
/// 置空字符串即足以让 git 认为「没有可用的 askpass 程序」，从而回落到
/// [`GIT_TERMINAL_PROMPT`] 的失败路径。
pub const GIT_ASKPASS: &str = "GIT_ASKPASS";

/// 关闭 stdin，使任何交互式提示都无法阻塞。
///
/// 这对子进程而言是「标准输入已关闭」的语义——即便某条 git 路径绕过了上述两个
/// 环境变量，读 stdin 也会立刻得到 EOF 而不是等待。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdinPolicy {
    /// 关闭 stdin（工作树相关的 git 调用一律使用这个）。
    Closed,
    /// 继承 stdin（仅用于确实需要交互的场景；本 crate 不提供此类调用）。
    Inherit,
}

/// 一组「无提示」的 git 环境变量覆盖项。
///
/// 用 [`BTreeMap`] 而非 `HashMap`：输出顺序稳定，便于测试断言与日志比对。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitNoPromptEnv {
    vars: BTreeMap<String, String>,
}

impl GitNoPromptEnv {
    /// 构造标准的无提示环境。
    pub fn new() -> Self {
        let mut vars = BTreeMap::new();
        vars.insert(GIT_TERMINAL_PROMPT.to_string(), "0".to_string());
        // 空字符串是刻意的：git 用「变量存在但为空」表示没有 askpass 程序。
        vars.insert(GIT_ASKPASS.to_string(), String::new());
        Self { vars }
    }

    /// 以 `KEY=VALUE` 形式逐项覆盖到给定环境上，返回新的环境集合。
    ///
    /// 调用方应传入父进程环境的快照（如 `std::env::vars()` 收集的 map），本方法
    /// 会在其之上强制写入两个变量——**父进程若已设置也一律覆盖**，因为这些是不可
    /// 协商的安全约束，不是默认值。
    pub fn apply_to(&self, base: BTreeMap<String, String>) -> BTreeMap<String, String> {
        let mut merged = base;
        for (key, value) in &self.vars {
            merged.insert(key.clone(), value.clone());
        }
        merged
    }

    /// 当前覆盖项（只读），供测试与诊断使用。
    pub fn overrides(&self) -> &BTreeMap<String, String> {
        &self.vars
    }

    /// stdin 策略：工作树 git 调用一律关闭 stdin。
    pub fn stdin_policy(&self) -> StdinPolicy {
        StdinPolicy::Closed
    }
}

impl Default for GitNoPromptEnv {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两个关键变量必须都被设置，且取值符合 git 的语义。
    #[test]
    fn sets_both_prompt_suppression_vars() {
        let env = GitNoPromptEnv::new();
        assert_eq!(
            env.overrides().get(GIT_TERMINAL_PROMPT),
            Some(&"0".to_string())
        );
        // 空字符串而非 "none"：git 的判定是「变量存在但为空」。
        assert_eq!(env.overrides().get(GIT_ASKPASS), Some(&String::new()));
    }

    /// stdin 必须关闭，否则绕过上述变量的路径仍可能阻塞。
    #[test]
    fn closes_stdin() {
        assert_eq!(GitNoPromptEnv::new().stdin_policy(), StdinPolicy::Closed);
    }

    /// 覆盖语义：父进程若**已**设置这些变量，也必须被强制改写。
    ///
    /// 这是安全约束不是默认值——如果允许父进程把 `GIT_TERMINAL_PROMPT` 设回 `1`，
    /// 某个上层配置就能让工作树调用重新变得可挂起。
    #[test]
    fn overrides_parent_values() {
        let mut base = BTreeMap::new();
        base.insert(GIT_TERMINAL_PROMPT.to_string(), "1".to_string());
        base.insert("PATH".to_string(), "/usr/bin".to_string());

        let merged = GitNoPromptEnv::new().apply_to(base);

        assert_eq!(merged.get(GIT_TERMINAL_PROMPT), Some(&"0".to_string()));
        // 无关变量原样保留。
        assert_eq!(merged.get("PATH"), Some(&"/usr/bin".to_string()));
    }

    /// 覆盖结果顺序稳定（BTreeMap），便于日志比对。
    #[test]
    fn override_order_is_deterministic() {
        let env = GitNoPromptEnv::new();
        let keys: Vec<&str> = env.overrides().keys().map(String::as_str).collect();
        // GIT_ASKPASS < GIT_TERMINAL_PROMPT（字典序）。
        assert_eq!(keys, vec![GIT_ASKPASS, GIT_TERMINAL_PROMPT]);
    }
}
