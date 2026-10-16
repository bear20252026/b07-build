//! 工作树 slug 的校验与拍平。
//!
//! 这是工作树隔离的第一道闸门，也是唯一一处「在任何副作用之前同步失败」的地方。
//! 设计研读自 Claude Code 还原源码 `src/utils/worktree.ts` 的 `validateWorktreeSlug`
//! 与 `flattenSlug`，为 Rust 独立实现。
//!
//! # 为什么必须校验 slug
//!
//! slug 会被拼进 `<仓库根>/.claude/worktrees/<slug>`。拼接用的规范化函数会消解 `..`
//! 段，因此 `../../../target` 会**逃出** worktrees 目录；而绝对路径（前导 `/`，或
//! Windows 的 `C:\`）在部分拼接实现中会**直接丢弃前缀**。两种都是目录逃逸。
//!
//! # 为什么嵌套 slug 必须拍平
//!
//! 上游允许 `user/feature` 这种嵌套写法，但直接使用会在两处出问题：
//!
//! 1. **git ref 的 D/F 冲突**：`refs/heads/worktree-user` 是文件、而
//!    `refs/heads/worktree-user/feature` 需要目录，二者不能共存，git 会拒绝。
//! 2. **目录嵌套的连带删除**：`.claude/worktrees/user/feature/` 落在 `user` 工作树
//!    **内部**；对父级执行 `git worktree remove` 会连同子级**未提交的工作**一起删掉。
//!
//! 因此本模块把 `/` 替换为 `+`。选择 `+` 的理由：它在 git 分支名与文件系统路径中都是
//! 合法字符，但**不在** slug 段白名单 `[A-Za-z0-9._-]` 内——这意味着拍平后的字符串
//! 不可能与另一个合法 slug 撞名，映射是**单射**的（可证不碰撞）。

/// slug 单段允许的字符集：字母、数字、点、下划线、连字符。
///
/// 刻意不含 `/`（分隔符）、`+`（拍平替身）、以及任何空白与 shell 元字符。
const ALLOWED_SEGMENT_CHARS: fn(char) -> bool =
    |c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-';

/// slug 的最大长度（字符数）。
///
/// 与上游一致的 64：既够表达 `asm/feature-foo` 这类语义化名字，又不至于让
/// 拼出的路径超出常见文件系统的单段长度限制。
pub const MAX_SLUG_LENGTH: usize = 64;

/// 拍平嵌套 slug 时使用的替身字符。
///
/// 必须在 [`ALLOWED_SEGMENT_CHARS`] 之外，否则映射不再单射。
pub const SLUG_FLATTEN_SEPARATOR: char = '+';

/// slug 校验失败的原因。每个变体都携带足够定位问题的信息，且**不含用户输入原文**
/// 之外的内容（slug 本身不是敏感数据，可直接回显给调用方）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlugError {
    /// slug 为空。
    Empty,
    /// slug 长度超过 [`MAX_SLUG_LENGTH`]。
    TooLong { length: usize, max: usize },
    /// 含 `.` 或 `..` 段——目录逃逸的主要手法。
    RelativeSegment { segment: String },
    /// 某一段含白名单之外的字符，或为空段（如 `a//b`、前导或尾随 `/`）。
    InvalidSegment { segment: String },
}

impl std::fmt::Display for SlugError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(formatter, "worktree-slug-empty"),
            Self::TooLong { length, max } => write!(
                formatter,
                "worktree-slug-too-long: {length} characters exceeds the {max} character limit"
            ),
            Self::RelativeSegment { segment } => write!(
                formatter,
                "worktree-slug-relative-segment: \"{segment}\" may not be a \".\" or \"..\" path segment"
            ),
            Self::InvalidSegment { segment } => write!(
                formatter,
                "worktree-slug-invalid-segment: \"{segment}\" must be non-empty and contain only letters, digits, dots, underscores, and dashes"
            ),
        }
    }
}

impl std::error::Error for SlugError {}

/// 校验一个 slug，成功返回 `Ok(())`。
///
/// 这是纯函数、无 I/O、**同步**返回——调用方依赖它在任何副作用（git 命令、hook
/// 执行、切换工作目录）**之前**就完成校验。
///
/// 规则：
/// - 非空，且字符数不超过 [`MAX_SLUG_LENGTH`]；
/// - 按 `/` 分段，每段非空；
/// - 每段不得为 `.` 或 `..`；
/// - 每段字符须全部落在 [`ALLOWED_SEGMENT_CHARS`] 内。
///
/// 注意：长度按**字符**而非字节计，与上游一致；ASCII 限制下两者等价，但保持字符
/// 语义可以让错误消息对人类友好。
pub fn validate_slug(slug: &str) -> Result<(), SlugError> {
    if slug.is_empty() {
        return Err(SlugError::Empty);
    }

    let length = slug.chars().count();
    if length > MAX_SLUG_LENGTH {
        return Err(SlugError::TooLong {
            length,
            max: MAX_SLUG_LENGTH,
        });
    }

    // 逐段校验。空段（前导 `/`、尾随 `/`、`a//b`）会因不满足「非空」而失败——
    // 前导 `/` 若放行会产出绝对路径，尾随 `/` 会产出悬空段，两者都必须拒绝。
    for segment in slug.split('/') {
        if segment.is_empty() {
            return Err(SlugError::InvalidSegment {
                segment: String::new(),
            });
        }
        if segment == "." || segment == ".." {
            return Err(SlugError::RelativeSegment {
                segment: segment.to_string(),
            });
        }
        if !segment.chars().all(ALLOWED_SEGMENT_CHARS) {
            return Err(SlugError::InvalidSegment {
                segment: segment.to_string(),
            });
        }
    }

    Ok(())
}

/// 把一个**已校验**的 slug 拍平为单段形式：`user/feature` → `user+feature`。
///
/// 调用方必须先跑 [`validate_slug`]。本函数不做校验，因为它的契约是「把合法输入做
/// 无损改写」；对非法输入调用它只会得到一个同样非法的字符串，没有额外风险，但会让
/// 错误消息指错地方。
pub fn flatten_slug(slug: &str) -> String {
    slug.replace('/', &SLUG_FLATTEN_SEPARATOR.to_string())
}

/// 校验并拍平，一步到位。错误直接来自 [`validate_slug`]。
pub fn validated_flat_slug(slug: &str) -> Result<String, SlugError> {
    validate_slug(slug)?;
    Ok(flatten_slug(slug))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最普通的用法必须通过——否则整个隔离机制不可用。
    #[test]
    fn accepts_simple_slug() {
        assert_eq!(validate_slug("feature-foo"), Ok(()));
        assert_eq!(validate_slug("asm"), Ok(()));
    }

    /// 嵌套是允许的（上游同款），但要先拍平。
    #[test]
    fn accepts_nested_slug() {
        assert_eq!(validate_slug("user/feature-foo"), Ok(()));
        assert_eq!(flatten_slug("user/feature-foo"), "user+feature-foo");
    }

    /// **核心安全用例**：`..` 段必须被拒——这是目录逃逸的主要手法。
    #[test]
    fn rejects_parent_segment() {
        assert_eq!(
            validate_slug("../../../target"),
            Err(SlugError::RelativeSegment {
                segment: "..".to_string()
            })
        );
        // 混在合法段里也不行。
        assert_eq!(
            validate_slug("asm/../../etc"),
            Err(SlugError::RelativeSegment {
                segment: "..".to_string()
            })
        );
        assert_eq!(
            validate_slug(".."),
            Err(SlugError::RelativeSegment {
                segment: "..".to_string()
            })
        );
    }

    /// 单个 `.` 段同样拒绝：它会指回父目录自身，让路径语义含糊。
    #[test]
    fn rejects_current_dir_segment() {
        assert_eq!(
            validate_slug("a/./b"),
            Err(SlugError::RelativeSegment {
                segment: ".".to_string()
            })
        );
    }

    /// 前导 `/` 会产出绝对路径，必须拒绝。
    #[test]
    fn rejects_leading_slash() {
        assert_eq!(
            validate_slug("/etc/passwd"),
            Err(SlugError::InvalidSegment {
                segment: String::new()
            })
        );
    }

    /// 尾随 `/` 与连续 `/` 都会产出空段。
    #[test]
    fn rejects_empty_segments() {
        assert_eq!(
            validate_slug("asm/"),
            Err(SlugError::InvalidSegment {
                segment: String::new()
            })
        );
        assert_eq!(
            validate_slug("a//b"),
            Err(SlugError::InvalidSegment {
                segment: String::new()
            })
        );
    }

    /// 反斜杠、空格、shell 元字符都不在白名单内。
    #[test]
    fn rejects_disallowed_characters() {
        for bad in ["a\\b", "a b", "a;b", "a$b", "a`b", "a*b", "a\"b", "a'b"] {
            assert!(
                matches!(validate_slug(bad), Err(SlugError::InvalidSegment { .. })),
                "expected {bad:?} to be rejected"
            );
        }
    }

    /// `+` 不在白名单内——这正是拍平映射单射的前提。
    #[test]
    fn rejects_flatten_separator_in_input() {
        assert!(matches!(
            validate_slug("a+b"),
            Err(SlugError::InvalidSegment { .. })
        ));
    }

    /// 空 slug 单独报错，便于调用方区分「没填」与「填错了」。
    #[test]
    fn rejects_empty() {
        assert_eq!(validate_slug(""), Err(SlugError::Empty));
    }

    /// 长度上限按字符计；刚好 64 通过、65 拒绝。
    #[test]
    fn enforces_length_limit() {
        let ok: String = "a".repeat(MAX_SLUG_LENGTH);
        let too_long: String = "a".repeat(MAX_SLUG_LENGTH + 1);
        assert_eq!(validate_slug(&ok), Ok(()));
        assert_eq!(
            validate_slug(&too_long),
            Err(SlugError::TooLong {
                length: MAX_SLUG_LENGTH + 1,
                max: MAX_SLUG_LENGTH
            })
        );
    }

    /// **单射性回归**：对**合法**输入，拍平不会让两个不同 slug 撞名。
    ///
    /// 注意单射论证的完整形式是两条：
    /// - (a) 拍平（`/`→`+`）本身可逆，所以在**合法 slug 集合内**是单射；
    /// - (b) `+` 被白名单排除，所以任何**拍平结果**都不可能同时是一个合法 slug——
    ///   这保证拍平输出不会被误当成另一个未拍平的输入。
    ///
    /// 这里两个性质都固定下来。特别地，输入里**不能**放 `"a+b"`：它不是合法 slug，
    /// 拿它参与比对会把 (b) 的前提破坏掉，从而得到一个假阴性。
    #[test]
    fn flattening_is_injective_on_valid_slugs() {
        // (a) 在合法输入集合内不碰撞。
        let inputs = ["a/b", "a/b/c", "x/y", "a-b", "a_b"];
        for input in inputs {
            assert_eq!(validate_slug(input), Ok(()), "{input:?} 应当是合法 slug");
        }
        let mut outputs: Vec<String> = inputs.iter().map(|s| flatten_slug(s)).collect();
        let original_len = outputs.len();
        outputs.sort();
        outputs.dedup();
        assert_eq!(outputs.len(), original_len, "扁平化后的 slug 发生碰撞");

        // (b) 拍平结果含 `+`，因此永远不是合法 slug——不会与未拍平的输入混淆。
        for flat in ["a+b", "a+b+c", "x+y"] {
            assert!(
                validate_slug(flat).is_err(),
                "{flat:?} 含 '+'，不能是合法 slug"
            );
        }
    }

    /// `validated_flat_slug` 把两步合一时行为一致。
    #[test]
    fn validated_flat_slug_combines_both_steps() {
        assert_eq!(
            validated_flat_slug("user/feature"),
            Ok("user+feature".to_string())
        );
        assert!(validated_flat_slug("../escape").is_err());
    }

    /// 错误消息可读，且能作为稳定的诊断码前缀使用。
    #[test]
    fn error_messages_are_stable_codes() {
        assert_eq!(SlugError::Empty.to_string(), "worktree-slug-empty");
        assert!(SlugError::TooLong {
            length: 65,
            max: 64
        }
        .to_string()
        .starts_with("worktree-slug-too-long"));
        assert!(SlugError::RelativeSegment {
            segment: "..".to_string()
        }
        .to_string()
        .starts_with("worktree-slug-relative-segment"));
    }
}
