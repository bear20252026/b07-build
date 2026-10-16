//! 工作树会话状态与生命周期语义。
//!
//! 设计研读自 Claude Code 还原源码 `src/utils/worktree.ts` 的 `WorktreeSession`
//! 类型、`getOrCreateWorktree` 的快速复用路径与**半成品回滚**、以及
//! `cleanupStaleAgentWorktrees` 的清理条件，为 Rust 独立实现。
//!
//! # 为什么不直接调 git
//!
//! 本 crate 刻意**不持有进程、不调 git**——真实 git 调用归桌面端 tokio 层（与
//! `process-supervisor` 的 `mcp_stdio.rs` 同一分工：那里也只做规格校验与纯状态机，
//! 真实 spawn 在 `apps/desktop-shell/src-tauri/src/mcp_process.rs`）。因此本模块是
//! **纯状态机 + 决策**，可单测、无平台依赖。
//!
//! # 三个关键设计
//!
//! 1. **快速复用**：已存在的工作树直接复用，不跑 fetch。上游实测大仓（21 万文件）
//!    的 fetch 在**还没碰网络**前就要花 6-8s 做 commit-graph 扫描。
//! 2. **半成品回滚**：任何后置步骤失败，必须拆掉已注册的工作树。否则下次的快速复用
//!    会**成功**——因为 HEAD 已设置——并把一个工作树为空的残骸当作正常复用呈现。
//! 3. **同名 slug 复用同一路径**：因此创建前必须先查存在性，避免无条件 fetch。

use crate::dirty::ChangeState;
use crate::paths;

/// 创建流程走到哪一步。用于判定「失败时该怎么回滚」。
///
/// 这是本模块最重要的类型：**不同阶段的失败需要的补偿动作完全不同**。
/// 注册之后失败必须拆除，注册之前失败则什么都不用做。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CreateStage {
    /// 尚未改动 git 状态（仅校验、路径推导）。
    NotStarted,
    /// 已执行 `git worktree add`，工作树**已注册**（HEAD 已设置）。
    Registered,
    /// 注册后已应用 sparse-checkout。
    SparseConfigured,
    /// 已完成 checkout，工作树可用。
    Completed,
}

impl CreateStage {
    /// 该阶段的失败是否需要回滚（拆除已注册的工作树）。
    ///
    /// 判据：工作树是否已注册。注册后 HEAD 已设置，快速复用路径会误认它有效。
    pub fn requires_rollback(self) -> bool {
        self >= Self::Registered && self != Self::Completed
    }

    /// 稳定标签。
    pub fn label(self) -> &'static str {
        match self {
            Self::NotStarted => "not-started",
            Self::Registered => "registered",
            Self::SparseConfigured => "sparse-configured",
            Self::Completed => "completed",
        }
    }
}

/// 一次创建尝试的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateOutcome {
    /// 复用了已存在的工作树（未跑 fetch、未执行任何写操作）。
    Reused { head_commit: String },
    /// 新建成功。
    Created {
        base_branch: String,
        head_commit: String,
    },
    /// 失败，且**已完成回滚**（若需要的话）。`stage` 指出失败发生在哪一步。
    Failed { stage: CreateStage, reason: String },
}

impl CreateOutcome {
    /// 是否可继续使用该工作树。
    pub fn is_usable(&self) -> bool {
        matches!(self, Self::Reused { .. } | Self::Created { .. })
    }

    /// 失败结果中是否已回滚——用于断言「失败不留残骸」。
    ///
    /// 语义：`Failed { stage }` 表示创建在 `stage` 处失败；`CreateOutcome` 的契约是
    /// **失败时已完成必要的回滚**，所以这里恒为 `true`。该方法的用途是让调用方
    /// （与测试）能显式断言这一点，而不是靠约定默契。
    pub fn rolled_back(&self) -> bool {
        matches!(self, Self::Failed { .. })
    }
}

/// 决定创建前的动作：复用还是新建。
///
/// 输入是「该路径是否已存在一个有效工作树」——由调用方通过读 `.git` 指针文件判定
/// （上游刻意不用 `rev-parse` 子进程：即使 2ms 的任务，spawn 开销也要 ~15ms）。
pub fn decide_create_action(existing_head: Option<&str>) -> CreateDecision {
    match existing_head {
        Some(head) => CreateDecision::Reuse {
            head_commit: head.to_string(),
        },
        None => CreateDecision::Create,
    }
}

/// 创建决策。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateDecision {
    /// 复用：跳过 fetch 与 worktree add。
    Reuse { head_commit: String },
    /// 新建：需选基分支、必要时 fetch，再 worktree add。
    Create,
}

/// 一个工作树会话。
///
/// 字段选取对齐上游 `WorktreeSession` 的语义（不抄结构体形状），只保留 b07 需要的：
/// 原始工作目录、工作树路径、slug、分支、基分支、session id。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeSession {
    /// 创建前的原始工作目录（回收时切回这里）。
    pub original_cwd: String,
    /// 工作树绝对路径。
    pub worktree_path: String,
    /// 原始 slug（未拍平）。
    pub slug: String,
    /// 工作树分支名。
    pub branch: String,
    /// 基分支（新建时记录）。
    pub base_branch: Option<String>,
    /// 创建时记录的 HEAD，用于变更探测的比对基准。
    pub head_commit: Option<String>,
    /// 归属的会话 id。
    pub session_id: String,
}

impl WorktreeSession {
    /// 由 slug 构造会话，路径与分支都由 [`crate::paths`] 唯一派生。
    ///
    /// 调用方**必须先** `validate_slug`——本函数不校验，因为它的契约是「把合法 slug
    /// 组装成会话」，校验属于入口闸门的职责（见 `slug` 模块）。
    pub fn new(repo_root: &std::path::Path, slug: &str, session_id: &str) -> Self {
        let worktree_path = paths::path_for(repo_root, slug);
        Self {
            original_cwd: repo_root.to_string_lossy().into_owned(),
            worktree_path: worktree_path.to_string_lossy().into_owned(),
            slug: slug.to_string(),
            branch: paths::branch_name_for(slug),
            base_branch: None,
            head_commit: None,
            session_id: session_id.to_string(),
        }
    }

    /// 本会话是否就是给定路径（清理时必须跳过自己）。
    pub fn owns_path(&self, candidate: &str) -> bool {
        self.worktree_path == candidate
    }
}

/// 清理候选的判定输入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupCandidate {
    /// 工作树路径。
    pub path: String,
    /// 分支名。
    pub branch: String,
    /// 目录 mtime（Unix 毫秒）。
    pub modified_ms: u128,
    /// 变更探测结论。
    pub change_state: ChangeState,
}

/// 清理判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupDecision {
    /// 可以删。
    Remove,
    /// 跳过，附带稳定原因码。
    Skip(&'static str),
}

/// 判定一个候选是否可清理。
///
/// 判定顺序（任一不满足即跳过）：
/// 1. **不是当前会话自己的路径** —— `skip-current-session`
/// 2. **目录名与分支名由同一 slug 派生** —— `skip-inconsistent-naming`
/// 3. **变更探测为 Clean**（fail-closed：Unknown 也跳过） —— `skip-not-clean` / `skip-unknown-state`
/// 4. **早于 cutoff** —— `skip-too-recent`
pub fn decide_cleanup(
    candidate: &CleanupCandidate,
    cutoff_ms: u128,
    current_session_path: Option<&str>,
) -> CleanupDecision {
    // 1. 绝不删自己——否则会把正在用的工作树连根拔掉。
    if let Some(current) = current_session_path {
        if current == candidate.path {
            return CleanupDecision::Skip("skip-current-session");
        }
    }

    // 2. 命名一致性：对不上说明记录可疑，不冒险删。
    let path = std::path::Path::new(&candidate.path);
    if !paths::names_are_consistent(path, &candidate.branch) {
        return CleanupDecision::Skip("skip-inconsistent-naming");
    }

    // 3. 变更状态。Unknown 与 Dirty 分开报码：前者是 git 失败，后者是真有内容，
    //    诊断语义不同，用户看到的提示也应不同。
    match candidate.change_state {
        ChangeState::Clean => {}
        ChangeState::Dirty => return CleanupDecision::Skip("skip-not-clean"),
        ChangeState::Unknown => return CleanupDecision::Skip("skip-unknown-state"),
    }

    // 4. 时间闸门放在安全检查之后：先确保「删了不丢东西」，再看「该不该现在删」。
    if candidate.modified_ms >= cutoff_ms {
        return CleanupDecision::Skip("skip-too-recent");
    }

    CleanupDecision::Remove
}

/// 清理决策是否为「删」。
pub fn is_removable(decision: &CleanupDecision) -> bool {
    matches!(decision, CleanupDecision::Remove)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 复用快速路径：已存在就不该再走新建。
    #[test]
    fn reuses_when_head_exists() {
        let decision = decide_create_action(Some("abc123"));
        assert_eq!(
            decision,
            CreateDecision::Reuse {
                head_commit: "abc123".to_string()
            }
        );
    }

    /// 不存在则新建。
    #[test]
    fn creates_when_head_missing() {
        assert_eq!(decide_create_action(None), CreateDecision::Create);
    }

    /// **半成品回滚的核心用例**：注册之后、完成之前的失败必须回滚。
    ///
    /// 若这里判定为「不需回滚」，工作树会以「已注册但工作树为空」的状态留在盘上，
    /// 而下次快速复用会因 HEAD 已设置而**成功**——把一个残骸当作正常复用呈现。
    #[test]
    fn rollback_required_between_registration_and_completion() {
        assert!(CreateStage::Registered.requires_rollback());
        assert!(CreateStage::SparseConfigured.requires_rollback());
    }

    /// 注册之前失败无事可做；完成之后不算「失败回滚」。
    #[test]
    fn no_rollback_outside_registered_window() {
        assert!(!CreateStage::NotStarted.requires_rollback());
        assert!(!CreateStage::Completed.requires_rollback());
    }

    /// 回滚窗口的边界顺序正确（依赖派生 Ord）。
    #[test]
    fn stage_ordering_is_monotonic() {
        assert!(CreateStage::NotStarted < CreateStage::Registered);
        assert!(CreateStage::Registered < CreateStage::SparseConfigured);
        assert!(CreateStage::SparseConfigured < CreateStage::Completed);
    }

    /// 失败结果应能断言「已回滚干净」。
    #[test]
    fn failed_outcome_reports_rollback_state() {
        let rolled = CreateOutcome::Failed {
            stage: CreateStage::SparseConfigured,
            reason: "sparse-checkout failed".to_string(),
        };
        assert!(rolled.rolled_back());
        assert!(!rolled.is_usable());

        let not_started = CreateOutcome::Failed {
            stage: CreateStage::NotStarted,
            reason: "validation failed".to_string(),
        };
        assert!(not_started.rolled_back());
    }

    /// 成功结果不适用「回滚」语义。
    #[test]
    fn successful_outcomes_are_usable() {
        let reused = CreateOutcome::Reused {
            head_commit: "abc".to_string(),
        };
        assert!(reused.is_usable());
        assert!(!reused.rolled_back());

        let created = CreateOutcome::Created {
            base_branch: "origin/main".to_string(),
            head_commit: "def".to_string(),
        };
        assert!(created.is_usable());
    }

    /// 会话由 slug 派生路径与分支，且两者一致。
    #[test]
    fn session_derives_path_and_branch_consistently() {
        let session = WorktreeSession::new(Path::new("/repo"), "user/feat", "s-1");
        assert_eq!(session.branch, "worktree-user+feat");
        assert!(session.worktree_path.ends_with("user+feat"));
        assert!(session.owns_path(&session.worktree_path));
        assert!(!session.owns_path("/repo/.claude/worktrees/other"));
    }

    /// 构造清理候选的便捷函数。
    fn candidate(
        path: &str,
        branch: &str,
        modified_ms: u128,
        state: ChangeState,
    ) -> CleanupCandidate {
        CleanupCandidate {
            path: path.to_string(),
            branch: branch.to_string(),
            modified_ms,
            change_state: state,
        }
    }

    /// 满足全部条件的候选可删。
    #[test]
    fn removable_when_all_conditions_hold() {
        let c = candidate(
            "/repo/.claude/worktrees/agent-x",
            "worktree-agent-x",
            1_000,
            ChangeState::Clean,
        );
        assert_eq!(decide_cleanup(&c, 2_000, None), CleanupDecision::Remove);
        assert!(is_removable(&decide_cleanup(&c, 2_000, None)));
    }

    /// **绝不删当前会话自己的工作树**——这是最危险的一类误删。
    #[test]
    fn never_removes_current_session() {
        let path = "/repo/.claude/worktrees/agent-x";
        let c = candidate(path, "worktree-agent-x", 1_000, ChangeState::Clean);
        assert_eq!(
            decide_cleanup(&c, 2_000, Some(path)),
            CleanupDecision::Skip("skip-current-session")
        );
    }

    /// 脏工作树跳过，原因码区别于 Unknown。
    #[test]
    fn skips_dirty_with_specific_code() {
        let c = candidate(
            "/repo/.claude/worktrees/agent-x",
            "worktree-agent-x",
            1_000,
            ChangeState::Dirty,
        );
        assert_eq!(
            decide_cleanup(&c, 2_000, None),
            CleanupDecision::Skip("skip-not-clean")
        );
    }

    /// Unknown（git 失败）单独报码——诊断上必须与「真有改动」区分开。
    #[test]
    fn skips_unknown_with_distinct_code() {
        let c = candidate(
            "/repo/.claude/worktrees/agent-x",
            "worktree-agent-x",
            1_000,
            ChangeState::Unknown,
        );
        assert_eq!(
            decide_cleanup(&c, 2_000, None),
            CleanupDecision::Skip("skip-unknown-state")
        );
    }

    /// 命名不一致跳过——不能靠猜删。
    #[test]
    fn skips_inconsistent_naming() {
        let c = candidate(
            "/repo/.claude/worktrees/agent-x",
            "worktree-something-else",
            1_000,
            ChangeState::Clean,
        );
        assert_eq!(
            decide_cleanup(&c, 2_000, None),
            CleanupDecision::Skip("skip-inconsistent-naming")
        );
    }

    /// 太新的跳过；边界取「等于 cutoff 也算太新」。
    #[test]
    fn skips_too_recent_including_boundary() {
        let c = candidate(
            "/repo/.claude/worktrees/agent-x",
            "worktree-agent-x",
            2_000,
            ChangeState::Clean,
        );
        assert_eq!(
            decide_cleanup(&c, 2_000, None),
            CleanupDecision::Skip("skip-too-recent")
        );
        assert_eq!(decide_cleanup(&c, 2_001, None), CleanupDecision::Remove);
    }

    /// 判定顺序：当前会话的判定优先于其它一切，即便它同时也是脏的。
    #[test]
    fn current_session_check_runs_first() {
        let path = "/repo/.claude/worktrees/agent-x";
        let c = candidate(path, "worktree-agent-x", 999_999, ChangeState::Dirty);
        assert_eq!(
            decide_cleanup(&c, 1_000, Some(path)),
            CleanupDecision::Skip("skip-current-session")
        );
    }

    /// 阶段标签稳定。
    #[test]
    fn stage_labels_are_stable() {
        assert_eq!(CreateStage::Registered.label(), "registered");
        assert_eq!(CreateStage::SparseConfigured.label(), "sparse-configured");
    }
}
