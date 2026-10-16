//! 工作树目录与分支的命名策略——唯一事实源。
//!
//! 设计研读自 Claude Code 还原源码 `src/utils/worktree.ts` 的 `worktreesDir` /
//! `worktreeBranchName` / `worktreePathFor`，为 Rust 独立实现。
//!
//! # 为什么把命名集中在一个模块
//!
//! 目录名与分支名必须**同时**从同一个 slug 派生，且必须用同一种拍平规则。上游
//! 的注释给出了反例：若目录用嵌套、分支用单段（或反之），会产生「分支已存在但目录
//! 不存在」这类不一致状态，清理逻辑就再也收不干净。因此本模块是这两者的唯一出口，
//! 其它模块不得自行拼接。crate 内用 `pub(crate)` 收敛可见性。
//!
//! # 目录位置
//!
//! 固定为 `<仓库根>/.claude/worktrees/`。放在仓库内而非临时目录，是因为工作树需要
//! 与主仓库共享 `.git`，且必须能被 `git worktree list` 看见——这是 git 的硬要求。

use std::path::{Path, PathBuf};

use crate::slug::flatten_slug;

/// 工作树目录相对仓库根的路径段（位于仓库内的隐藏目录）。
pub(crate) const WORKTREES_DIR_RELATIVE: [&str; 2] = [".claude", "worktrees"];

/// 分支名前缀。所有工作树分支都以它开头，便于识别与批量清理。
pub(crate) const BRANCH_PREFIX: &str = "worktree-";

/// 工作树根目录：`<repo_root>/.claude/worktrees`。
pub fn worktrees_dir(repo_root: &Path) -> PathBuf {
    let mut dir = repo_root.to_path_buf();
    for segment in WORKTREES_DIR_RELATIVE {
        dir.push(segment);
    }
    dir
}

/// 工作树分支名：`worktree-<拍平后的 slug>`。
///
/// 拍平是必须的：分支是 git ref，嵌套会产生 ref 的 D/F 冲突（见 `slug` 模块文档）。
pub fn branch_name_for(slug: &str) -> String {
    format!("{BRANCH_PREFIX}{}", flatten_slug(slug))
}

/// 工作树目录：`<repo_root>/.claude/worktrees/<拍平后的 slug>`。
pub fn path_for(repo_root: &Path, slug: &str) -> PathBuf {
    worktrees_dir(repo_root).join(flatten_slug(slug))
}

/// 目录名与分支名是否由同一个 slug 派生（一致性自检）。
///
/// 用于清理路径上的防御：若某条记录声称的目录名与分支名对不上同一个 slug，说明
/// 记录被篡改或使用了旧版命名规则，此时**不应**继续删除操作。返回 `false` 即拒绝。
pub fn names_are_consistent(path: &Path, branch: &str) -> bool {
    let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(slug_part) = branch.strip_prefix(BRANCH_PREFIX) else {
        return false;
    };
    dir_name == slug_part
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 目录落在仓库内的 `.claude/worktrees`。
    #[test]
    fn worktrees_dir_is_inside_repo() {
        let dir = worktrees_dir(Path::new("/repo"));
        assert_eq!(dir, PathBuf::from("/repo/.claude/worktrees"));
    }

    /// 分支名带固定前缀，且嵌套 slug 被拍平。
    #[test]
    fn branch_name_uses_prefix_and_flattens() {
        assert_eq!(branch_name_for("asm"), "worktree-asm");
        assert_eq!(branch_name_for("user/feature"), "worktree-user+feature");
    }

    /// 目录名与分支名从同一 slug 派生，必须一致。
    #[test]
    fn path_uses_same_flattening_as_branch() {
        let path = path_for(Path::new("/repo"), "user/feature");
        assert_eq!(path, PathBuf::from("/repo/.claude/worktrees/user+feature"));
        // 关键：目录末段等于分支前缀之后的部分。
        let dir_name = path.file_name().unwrap().to_str().unwrap();
        let branch = branch_name_for("user/feature");
        assert_eq!(dir_name, branch.strip_prefix(BRANCH_PREFIX).unwrap());
    }

    /// 一致性自检：正常配对通过。
    #[test]
    fn consistency_accepts_matching_pair() {
        let path = path_for(Path::new("/repo"), "user/feature");
        assert!(names_are_consistent(&path, "worktree-user+feature"));
    }

    /// 一致性自检：不匹配即拒绝——清理路径上不能靠猜。
    #[test]
    fn consistency_rejects_mismatched_pair() {
        let path = path_for(Path::new("/repo"), "asm");
        // 分支来自另一个 slug。
        assert!(!names_are_consistent(&path, "worktree-other"));
        // 分支名没有前缀。
        assert!(!names_are_consistent(&path, "asm"));
    }

    /// 无文件名的路径（如根 `/`）必须安全返回 false，而不是 panic。
    #[test]
    fn consistency_handles_path_without_file_name() {
        assert!(!names_are_consistent(Path::new("/"), "worktree-asm"));
    }
}
