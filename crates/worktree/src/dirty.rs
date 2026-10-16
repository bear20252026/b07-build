//! 工作树的变更探测——清理前的安全检查。
//!
//! 设计研读自 Claude Code 还原源码 `src/utils/worktree.ts` 的
//! `cleanupStaleAgentWorktrees` 与 `hasWorktreeChanges`，为 Rust 独立实现。
//!
//! # 核心原则：fail-closed
//!
//! 「这个工作树能不能删」的判定必须**偏保守**。上游注释把这层意思讲得很直白：
//! 只有当两项检查都成功**且输出为空**时才可删；任一命令非零退出（工作树损坏、
//! git 不认识它等）就**跳过**——因为「我们不知道里面是什么」。
//!
//! 反之若把非零退出当成「干净」放行，一次 git 故障就会删掉用户未提交的工作。
//! 这是不可逆的数据丢失，所以本模块把所有不确定情形一律判定为「有变更 / 不可删」。

/// 一个工作树的变更探测结论。
///
/// 注意这不是布尔值而是三态：`Unknown` 与 `Clean` 有本质区别——前者对应 git 命令
/// 失败，必须当作「不可删」处理，但**在诊断里要能与真正的脏工作区分开**，
/// 否则用户会以为自己的改动丢了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeState {
    /// 确认干净：无未提交改动、无未推送提交。
    Clean,
    /// 确认有内容：存在未提交改动或未推送提交。
    Dirty,
    /// 无法判定：至少一条 git 命令失败。**调用方必须按「不可删」处理。**
    Unknown,
}

impl ChangeState {
    /// 是否安全可删。只有 [`ChangeState::Clean`] 返回 `true`。
    ///
    /// 把判定收在这里，是为了让调用方无法「忘记处理 Unknown」——想删就必须问这个方法。
    pub fn is_safely_removable(self) -> bool {
        matches!(self, Self::Clean)
    }

    /// 稳定的诊断标签。
    pub fn label(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Dirty => "dirty",
            Self::Unknown => "unknown",
        }
    }
}

/// 两条 git 命令的原始结果，用于判定 [`ChangeState`]。
///
/// 上游用 `git status --porcelain -uno` 查未提交改动、`git rev-list --max-count=1
/// HEAD --not --remotes` 查未推送提交。这里只承载结果，不自己跑命令——保持本 crate
/// 是「策略」而非「I/O」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOutput {
    /// 命令是否以 0 退出。
    pub success: bool,
    /// 标准输出（调用方应已 trim）。
    pub stdout_empty: bool,
}

impl ProbeOutput {
    /// 命令成功且输出为空才算「这一项没问题」。
    pub fn is_clear(&self) -> bool {
        self.success && self.stdout_empty
    }

    /// 命令失败。
    pub fn failed() -> Self {
        Self {
            success: false,
            stdout_empty: true,
        }
    }

    /// 命令成功且无输出。
    pub fn clear() -> Self {
        Self {
            success: true,
            stdout_empty: true,
        }
    }

    /// 命令成功但有输出。
    pub fn has_output() -> Self {
        Self {
            success: true,
            stdout_empty: false,
        }
    }
}

/// 综合两条探测结果给出结论。
///
/// 判定顺序刻意如此：**先判失败，再判有内容**。这样当命令失败时，即便 `stdout_empty`
/// 恰好为真也不会误判成 `Clean`。
pub fn classify(uncommitted: &ProbeOutput, unpushed: &ProbeOutput) -> ChangeState {
    // 任一命令失败 → 不知道里面是什么 → Unknown（不可删）。
    if !uncommitted.success || !unpushed.success {
        return ChangeState::Unknown;
    }
    // 两者都成功：只要有一项有输出就是脏。
    if !uncommitted.stdout_empty || !unpushed.stdout_empty {
        return ChangeState::Dirty;
    }
    ChangeState::Clean
}

/// 判断一个已探测的工作树是否应当**跳过**清理。
///
/// 语义与 [`ChangeState::is_safely_removable`] 相反，但用独立函数表达可以让清理
/// 循环的意图在调用点直接可读（`if should_skip_cleanup(..) { continue }`）。
pub fn should_skip_cleanup(state: ChangeState) -> bool {
    !state.is_safely_removable()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两项都成功且无输出 → 干净，可删。
    #[test]
    fn clean_when_both_probes_are_clear() {
        let state = classify(&ProbeOutput::clear(), &ProbeOutput::clear());
        assert_eq!(state, ChangeState::Clean);
        assert!(state.is_safely_removable());
        assert!(!should_skip_cleanup(state));
    }

    /// 有未提交改动 → 脏，不可删。
    #[test]
    fn dirty_when_uncommitted_output_exists() {
        let state = classify(&ProbeOutput::has_output(), &ProbeOutput::clear());
        assert_eq!(state, ChangeState::Dirty);
        assert!(!state.is_safely_removable());
        assert!(should_skip_cleanup(state));
    }

    /// 有未推送提交 → 脏，不可删。这是最容易造成「提交丢失」的一类。
    #[test]
    fn dirty_when_unpushed_commits_exist() {
        let state = classify(&ProbeOutput::clear(), &ProbeOutput::has_output());
        assert_eq!(state, ChangeState::Dirty);
        assert!(!state.is_safely_removable());
    }

    /// **核心 fail-closed 用例**：命令失败 → Unknown，绝不可删。
    ///
    /// 这正是上游注释强调的场景——工作树损坏、git 不识别它时，`status` 会非零退出。
    /// 如果这里放行，损坏的工作树会被当作「干净」删掉，里面可能有的工作就没了。
    #[test]
    fn unknown_when_probe_fails() {
        let state = classify(&ProbeOutput::failed(), &ProbeOutput::clear());
        assert_eq!(state, ChangeState::Unknown);
        assert!(!state.is_safely_removable());
        assert!(should_skip_cleanup(state));

        let state = classify(&ProbeOutput::clear(), &ProbeOutput::failed());
        assert_eq!(state, ChangeState::Unknown);
    }

    /// 两条都失败仍是 Unknown（不是更糟的其它状态）。
    #[test]
    fn unknown_when_both_probes_fail() {
        let state = classify(&ProbeOutput::failed(), &ProbeOutput::failed());
        assert_eq!(state, ChangeState::Unknown);
    }

    /// 失败命令的空输出**不得**被误读为「这一项没问题」。
    #[test]
    fn failed_probe_with_empty_stdout_is_not_clear() {
        let probe = ProbeOutput::failed();
        assert!(probe.stdout_empty, "前提：失败探针的输出确实是空的");
        assert!(!probe.is_clear(), "但失败就不算 clear");
    }

    /// 三态标签稳定，便于诊断与日志。
    #[test]
    fn labels_are_stable() {
        assert_eq!(ChangeState::Clean.label(), "clean");
        assert_eq!(ChangeState::Dirty.label(), "dirty");
        assert_eq!(ChangeState::Unknown.label(), "unknown");
    }
}
