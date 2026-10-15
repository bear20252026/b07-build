//! 终端命令准入与「逐命令 / 逐标志」只读判定。
//!
//! 本模块把 ZCode v3.15.1（Apache-2.0）的 bash 只读策略家族
//! （上游 `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-*`）
//! 移植为 Rust 实现，并叠加 b07 自己的白名单与硬拒绝规则。来源与差异见
//! `THIRD-PARTY-NOTICES.md`。
//!
//! 判定分四档，顺序即优先级：
//!
//! 1. `Denied` —— 硬拒绝。会丢数据或改系统状态的片段、命令拼接、以及不在白名单里的
//!    可执行文件。`confirm_dangerous` 也不能放行。
//! 2. `ReadOnly` —— 可证明只读。命令名与每一个标志都在只读策略表里，且不含重定向、
//!    危险 git 全局选项、`find` 写入动作等。
//! 3. `StateChanging` —— 允许，但会对外发布、丢弃未提交工作或改写历史，需要调用方
//!    显式确认。
//! 4. `Routine` —— 允许且不需要确认的常规动作（构建、测试、检查等）。
//!
//! 相比移植前的子串匹配，本实现把「`npm run clean` 被误判为 `git clean`」这类
//! 假阳性、以及「`find . -delete` / `find . -exec rm {} +` 不被识别为写入」这类
//! 假阴性一并修掉。

use std::collections::BTreeSet;

/// 一条命令的准入结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandClass {
    /// 可证明只读。
    ReadOnly,
    /// 允许且无需确认的常规动作。
    Routine,
    /// 允许，但需要显式确认。
    StateChanging,
    /// 拒绝执行，附带稳定的错误码。
    Denied(&'static str),
}

impl CommandClass {
    /// 拒绝原因（错误码）；非拒绝返回 `None`。
    pub fn denial(self) -> Option<&'static str> {
        match self {
            CommandClass::Denied(reason) => Some(reason),
            _ => None,
        }
    }

    /// 是否需要调用方勾选「最后确认」。
    pub fn requires_confirmation(self) -> bool {
        matches!(self, CommandClass::StateChanging)
    }

    /// 是否可证明只读。
    pub fn is_read_only(self) -> bool {
        matches!(self, CommandClass::ReadOnly)
    }

    /// 稳定的枚举名，供 Tauri 命令面序列化。
    pub fn as_str(self) -> &'static str {
        match self {
            CommandClass::ReadOnly => "read-only",
            CommandClass::Routine => "routine",
            CommandClass::StateChanging => "state-changing",
            CommandClass::Denied(_) => "denied",
        }
    }
}

/// 允许执行的可执行文件名。终端只用于构建、测试与查看，不用于系统管理。
///
/// 刻意用「白名单」而不是「危险名单」：危险名单永远补不完，
/// 而漏掉一个白名单条目最坏的结果只是某个命令跑不了。
pub const ALLOWED_EXECUTABLES: &[&str] = &[
    // 版本控制
    "git", // Node 生态
    "npm", "npx", "pnpm", "yarn", "node", "bun", "deno", // Rust
    "cargo", "rustc", "rustup", // Python
    "python", "python3", "pip", "pip3", "uv", "poetry", "pytest",
    // 其它语言工具链
    "go", "java", "mvn", "gradle", "dotnet", "make", "cmake", // 检查与测试
    "ls", "dir", "cat", "type", "echo", "pwd", "find", "grep", "rg", "head", "tail", "wc", "tree",
    "which", "where", "env", "whoami", "tsc", "tsx", "eslint", "prettier", "vitest", "jest",
    "ruff", "mypy",
];

/// 无论可执行文件是否在白名单内都绝不执行的片段。
const DENIED_PATTERNS: &[&str] = &[
    "rm -rf",
    "rm -fr",
    "rmdir /",
    "del /",
    "del /f",
    "remove-item -recurse",
    "format ",
    "mkfs",
    "diskpart",
    "dd if=",
    "shutdown",
    "restart-computer",
    "stop-computer",
    "stop-process -force",
    "taskkill",
    "reg delete",
    "reg add",
    "net user",
    "schtasks",
    "runas",
    "-verb runas",
    "sudo",
    "git push --force",
    "git push -f",
    "chmod 777",
    "set-executionpolicy",
    "iex(",
    "invoke-expression",
    "curl | sh",
    "wget | sh",
    "| sh",
    "| bash",
    "| powershell",
    "| cmd",
];

/// 不允许命令拼接、管道与重定向。一条命令就是一条命令。
const FORBIDDEN_OPERATORS: &[&str] = &[
    "&&", "||", ";", "\n", "\r", "`", "$(", ">", "|", "<", "&", ">>",
];

/// 把命令行拆成 argv：尊重双引号包裹的参数，拒绝未闭合引号。
///
/// 既然管道、拼接、命令替换都已在 `FORBIDDEN_OPERATORS` 里被拒绝，
/// 这里唯一的解释自由度就是引号；拆出来的每个参数都会原样传给子进程。
pub fn split_argv(command: &str) -> Option<Vec<String>> {
    let mut argv: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for character in command.chars() {
        match character {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            ' ' | '\t' if !in_quotes => {
                if has_token {
                    argv.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            other => {
                current.push(other);
                has_token = true;
            }
        }
    }
    if in_quotes {
        return None;
    }
    if has_token {
        argv.push(current);
    }
    (!argv.is_empty()).then_some(argv)
}

/// 取出 argv 首项作为可执行文件名。带路径的一律不认，
/// 否则 `C:\Windows\System32\format` 之类能绕过白名单。
pub fn executable_name(argv: &[String]) -> Option<String> {
    let first = argv.first()?;
    if first.is_empty() || first.contains('/') || first.contains('\\') || first.contains(':') {
        return None;
    }
    Some(first.to_ascii_lowercase())
}

/// 判定一条命令的准入结论。
pub fn classify(command: &str) -> CommandClass {
    let value = command.to_ascii_lowercase();
    if DENIED_PATTERNS.iter().any(|needle| value.contains(needle)) {
        return CommandClass::Denied("terminal-command-denied");
    }
    if FORBIDDEN_OPERATORS
        .iter()
        .any(|needle| value.contains(needle))
    {
        return CommandClass::Denied("terminal-command-chaining-denied");
    }
    let Some(argv) = split_argv(command) else {
        return CommandClass::Denied("terminal-command-invalid");
    };
    match executable_name(&argv) {
        Some(name) if ALLOWED_EXECUTABLES.contains(&name.as_str()) => {}
        _ => return CommandClass::Denied("terminal-command-not-allowed"),
    }

    if is_read_only_argv(&argv) {
        return CommandClass::ReadOnly;
    }
    if has_state_changing_intent(&argv) {
        return CommandClass::StateChanging;
    }
    CommandClass::Routine
}

// ---------------------------------------------------------------------------
// 只读判定
// ---------------------------------------------------------------------------

/// 标志的取值形态。移植自上游 `SafeFlagValue`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlagKind {
    /// 不接受内联值（`--flag=value` 直接判非法）。
    None,
    /// 纯数字。
    Number,
    /// 任意字符串。
    Str,
}

type Flags = &'static [(&'static str, FlagKind)];

/// 一条只读策略：命令名 + 标志表 + 少数需要额外复核的回调。
struct CommandPolicy {
    /// 是否允许任意参数（不再逐标志检查）。
    allow_any_args: bool,
    /// 是否只允许命令名本身，不接受任何参数。
    command_only: bool,
    /// 标志表。
    flags: Flags,
    /// 是否认 `--` 终止符。
    respects_double_dash: bool,
    /// 是否允许 `-8` 这类紧凑数字计数（`git log -8`）。
    allow_compact_numeric_count: bool,
    /// 额外的危险判定。
    callback: Option<Callback>,
}

impl CommandPolicy {
    const fn any_args() -> Self {
        Self {
            allow_any_args: true,
            command_only: false,
            flags: &[],
            respects_double_dash: true,
            allow_compact_numeric_count: false,
            callback: None,
        }
    }

    const fn only() -> Self {
        Self {
            allow_any_args: false,
            command_only: true,
            flags: &[],
            respects_double_dash: true,
            allow_compact_numeric_count: false,
            callback: None,
        }
    }

    const fn with_flags(flags: Flags) -> Self {
        Self {
            allow_any_args: false,
            command_only: false,
            flags,
            respects_double_dash: true,
            allow_compact_numeric_count: false,
            callback: None,
        }
    }
}

/// 需要逐命令复核的危险判定。移植自上游的 `additionalCommandIsDangerousCallback`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Callback {
    /// `git branch`：只有 `--list` 形态是只读的。
    Branch,
    /// `git tag`：同上。
    Tag,
    /// `git reflog`：只允许 `show` / `list`。
    Reflog,
    /// `git ls-remote`：不允许远端位置参数。
    LsRemote,
    /// `git remote show`：必须带 `-n` 且只有一个合法远端名。
    RemoteShow,
    /// `git remote`：只允许 `-v` / `--verbose`。
    RemoteVerboseOnly,
    /// `--format` / `--pretty` 里不得出现签名或 GPG 占位符。
    RevisionFormat,
}

/// 允许任意参数的只读命令。移植自上游 `READONLY_ALLOW_ANY_ARG_COMMANDS`，
/// 末尾两条是 b07 的平台扩展（Windows 的 `where` 与 cmd 的 `dir`）。
const READONLY_ALLOW_ANY_ARGS: &[&str] = &[
    "basename", "cal", "cat", "cmp", "column", "comm", "cut", "df", "diff", "dirname", "du",
    "expand", "expr", "false", "fmt", "fold", "free", "groups", "head", "hexdump", "id", "locale",
    "nl", "nproc", "numfmt", "od", "paste", "pr", "readlink", "realpath", "rev", "seq", "sleep",
    "stat", "strings", "tac", "tail", "tr", "true", "tsort", "type", "uname", "unexpand", "uptime",
    "wc", "which", // b07 扩展
    "dir", "where",
];

/// 只允许命令名本身、不接受任何参数的只读命令。
const READONLY_COMMAND_ONLY: &[&str] = &["alias", "false", "pwd", "true", "whoami"];

/// 精确 argv 形态才只读的命令。移植自上游 `READONLY_EXACT_ARGV_COMMANDS`。
const READONLY_EXACT_ARGV: &[&[&str]] = &[
    &["ip", "addr"],
    &["node", "-v"],
    &["node", "--version"],
    &["python", "--version"],
    &["python3", "--version"],
];

/// `find` 里会写入文件系统的动作。
const FIND_WRITE_OPTIONS: &[&str] = &[
    "-delete",
    "-exec",
    "-execdir",
    "-files0-from",
    "-fls",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-ok",
    "-okdir",
];

/// `find` 里会吃掉下一个参数作为值的选项。
const FIND_VALUE_OPTIONS: &[&str] = &[
    "-Bmin",
    "-Bnewer",
    "-Btime",
    "-D",
    "-amin",
    "-anewer",
    "-atime",
    "-cmin",
    "-cnewer",
    "-context",
    "-ctime",
    "-f",
    "-flags",
    "-fstype",
    "-gid",
    "-group",
    "-ilname",
    "-iname",
    "-inum",
    "-ipath",
    "-iregex",
    "-iwholename",
    "-lname",
    "-links",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mnewer",
    "-mtime",
    "-name",
    "-newer",
    "-path",
    "-perm",
    "-printf",
    "-regex",
    "-regextype",
    "-samefile",
    "-size",
    "-type",
    "-used",
    "-user",
    "-wholename",
    "-xattrname",
    "-xtype",
    "-uid",
];

/// 上游 `git` 全局无值选项。
const GIT_GLOBAL_NO_VALUE_FLAGS: &[&str] = &["--no-pager", "--paginate"];

/// 上游 `git` 全局危险选项：可以改写仓库定位或注入配置。
const GIT_GLOBAL_DANGEROUS_FLAGS: &[&str] = &[
    "-c",
    "-C",
    "--attr-source",
    "--bare",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--shallow-file",
    "--super-prefix",
    "--work-tree",
];

// --- 只读标志表 -------------------------------------------------------------

const GIT_STATUS_SAFE_FLAGS: Flags = &[
    ("-b", FlagKind::None),
    ("-M", FlagKind::Str),
    ("-s", FlagKind::None),
    ("-u", FlagKind::Str),
    ("-v", FlagKind::None),
    ("--ahead-behind", FlagKind::None),
    ("--branch", FlagKind::None),
    ("--column", FlagKind::None),
    ("--find-renames", FlagKind::Str),
    ("--ignore-submodules", FlagKind::Str),
    ("--ignored", FlagKind::None),
    ("--long", FlagKind::None),
    ("--no-ahead-behind", FlagKind::None),
    ("--no-column", FlagKind::None),
    ("--no-renames", FlagKind::None),
    ("--porcelain", FlagKind::None),
    ("--renames", FlagKind::None),
    ("--short", FlagKind::None),
    ("--untracked-files", FlagKind::Str),
    ("--verbose", FlagKind::None),
];

const GIT_DIFF_SAFE_FLAGS: Flags = &[
    ("-B", FlagKind::None),
    ("-C", FlagKind::None),
    ("-D", FlagKind::None),
    ("-G", FlagKind::Str),
    ("-M", FlagKind::None),
    ("-O", FlagKind::Str),
    ("-R", FlagKind::None),
    ("-S", FlagKind::Str),
    ("-l", FlagKind::None),
    ("-p", FlagKind::None),
    ("-s", FlagKind::None),
    ("-u", FlagKind::None),
    ("--cached", FlagKind::None),
    ("--check", FlagKind::None),
    ("--color", FlagKind::None),
    ("--color-words", FlagKind::None),
    ("--diff-algorithm", FlagKind::Str),
    ("--diff-filter", FlagKind::Str),
    ("--dirstat", FlagKind::None),
    ("--exit-code", FlagKind::None),
    ("--find-copies", FlagKind::None),
    ("--find-copies-harder", FlagKind::None),
    ("--find-renames", FlagKind::None),
    ("--full-index", FlagKind::None),
    ("--function-context", FlagKind::None),
    ("--histogram", FlagKind::None),
    ("--ignore-all-space", FlagKind::None),
    ("--ignore-blank-lines", FlagKind::None),
    ("--ignore-space-at-eol", FlagKind::None),
    ("--ignore-space-change", FlagKind::None),
    ("--inter-hunk-context", FlagKind::Number),
    ("--irreversible-delete", FlagKind::None),
    ("--minimal", FlagKind::None),
    ("--name-only", FlagKind::None),
    ("--name-status", FlagKind::None),
    ("--no-color", FlagKind::None),
    ("--no-ext-diff", FlagKind::None),
    ("--no-index", FlagKind::None),
    ("--no-renames", FlagKind::None),
    ("--numstat", FlagKind::None),
    ("--patch-with-stat", FlagKind::None),
    ("--patience", FlagKind::None),
    ("--pickaxe-all", FlagKind::None),
    ("--pickaxe-regex", FlagKind::None),
    ("--quiet", FlagKind::None),
    ("--relative", FlagKind::Str),
    ("--shortstat", FlagKind::None),
    ("--staged", FlagKind::None),
    ("--stat", FlagKind::None),
    ("--summary", FlagKind::None),
    ("--word-diff", FlagKind::None),
    ("--word-diff-regex", FlagKind::Str),
    ("--ws-error-highlight", FlagKind::Str),
];

const GIT_LOG_SAFE_FLAGS: Flags = &[
    ("-G", FlagKind::Str),
    ("-S", FlagKind::Str),
    ("-n", FlagKind::Number),
    ("-p", FlagKind::None),
    ("-s", FlagKind::None),
    ("--abbrev-commit", FlagKind::None),
    ("--all", FlagKind::None),
    ("--after", FlagKind::Str),
    ("--ancestry-path", FlagKind::None),
    ("--author", FlagKind::Str),
    ("--author-date-order", FlagKind::None),
    ("--before", FlagKind::Str),
    ("--boundary", FlagKind::None),
    ("--branches", FlagKind::None),
    ("--cherry-mark", FlagKind::None),
    ("--cherry-pick", FlagKind::None),
    ("--color", FlagKind::None),
    ("--committer", FlagKind::Str),
    ("--date", FlagKind::Str),
    ("--date-order", FlagKind::None),
    ("--decorate", FlagKind::None),
    ("--dense", FlagKind::None),
    ("--diff-filter", FlagKind::Str),
    ("--first-parent", FlagKind::None),
    ("--format", FlagKind::Str),
    ("--full-history", FlagKind::None),
    ("--graph", FlagKind::None),
    ("--grep", FlagKind::Str),
    ("--left-right", FlagKind::None),
    ("--max-age", FlagKind::Number),
    ("--max-count", FlagKind::Number),
    ("--merges", FlagKind::None),
    ("--min-age", FlagKind::Number),
    ("--name-only", FlagKind::None),
    ("--name-status", FlagKind::None),
    ("--no-color", FlagKind::None),
    ("--no-decorate", FlagKind::None),
    ("--no-ext-diff", FlagKind::None),
    ("--no-max-parents", FlagKind::None),
    ("--no-merges", FlagKind::None),
    ("--no-min-parents", FlagKind::None),
    ("--no-patch", FlagKind::None),
    ("--no-walk", FlagKind::None),
    ("--numstat", FlagKind::None),
    ("--oneline", FlagKind::None),
    ("--patch", FlagKind::None),
    ("--pickaxe-all", FlagKind::None),
    ("--pickaxe-regex", FlagKind::None),
    ("--pretty", FlagKind::Str),
    ("--relative-date", FlagKind::None),
    ("--remotes", FlagKind::None),
    ("--reverse", FlagKind::None),
    ("--shortstat", FlagKind::None),
    ("--simplify-merges", FlagKind::None),
    ("--since", FlagKind::Str),
    ("--skip", FlagKind::Number),
    ("--source", FlagKind::None),
    ("--sparse", FlagKind::None),
    ("--stat", FlagKind::None),
    ("--tags", FlagKind::None),
    ("--topo-order", FlagKind::None),
    ("--until", FlagKind::Str),
    ("--walk-reflogs", FlagKind::None),
];

const GIT_SHOW_SAFE_FLAGS: Flags = &[
    ("-m", FlagKind::None),
    ("-p", FlagKind::None),
    ("-s", FlagKind::None),
    ("--abbrev-commit", FlagKind::None),
    ("--color", FlagKind::None),
    ("--color-words", FlagKind::None),
    ("--date", FlagKind::Str),
    ("--decorate", FlagKind::None),
    ("--diff-filter", FlagKind::Str),
    ("--first-parent", FlagKind::None),
    ("--format", FlagKind::Str),
    ("--graph", FlagKind::None),
    ("--name-only", FlagKind::None),
    ("--name-status", FlagKind::None),
    ("--no-color", FlagKind::None),
    ("--no-decorate", FlagKind::None),
    ("--no-ext-diff", FlagKind::None),
    ("--no-patch", FlagKind::None),
    ("--numstat", FlagKind::None),
    ("--oneline", FlagKind::None),
    ("--patch", FlagKind::None),
    ("--pretty", FlagKind::Str),
    ("--quiet", FlagKind::None),
    ("--raw", FlagKind::None),
    ("--relative-date", FlagKind::None),
    ("--shortstat", FlagKind::None),
    ("--stat", FlagKind::None),
    ("--word-diff", FlagKind::None),
    ("--word-diff-regex", FlagKind::Str),
];

const GIT_GREP_SAFE_FLAGS: Flags = &[
    ("-A", FlagKind::Number),
    ("-B", FlagKind::Number),
    ("-C", FlagKind::Number),
    ("-E", FlagKind::None),
    ("-F", FlagKind::None),
    ("-G", FlagKind::None),
    ("-H", FlagKind::None),
    ("-L", FlagKind::None),
    ("-P", FlagKind::None),
    ("-c", FlagKind::None),
    ("-e", FlagKind::Str),
    ("-h", FlagKind::None),
    ("-i", FlagKind::None),
    ("-l", FlagKind::None),
    ("-n", FlagKind::None),
    ("-o", FlagKind::None),
    ("-q", FlagKind::None),
    ("-v", FlagKind::None),
    ("-w", FlagKind::None),
    ("--after-context", FlagKind::Number),
    ("--and", FlagKind::None),
    ("--basic-regexp", FlagKind::None),
    ("--break", FlagKind::None),
    ("--cached", FlagKind::None),
    ("--color", FlagKind::None),
    ("--context", FlagKind::Number),
    ("--count", FlagKind::None),
    ("--extended-regexp", FlagKind::None),
    ("--files-with-matches", FlagKind::None),
    ("--files-without-match", FlagKind::None),
    ("--fixed-strings", FlagKind::None),
    ("--full-name", FlagKind::None),
    ("--heading", FlagKind::None),
    ("--ignore-case", FlagKind::None),
    ("--invert-match", FlagKind::None),
    ("--line-number", FlagKind::None),
    ("--max-depth", FlagKind::Number),
    ("--no-color", FlagKind::None),
    ("--no-index", FlagKind::None),
    ("--not", FlagKind::None),
    ("--only-matching", FlagKind::None),
    ("--or", FlagKind::None),
    ("--perl-regexp", FlagKind::None),
    ("--quiet", FlagKind::None),
    ("--recurse-submodules", FlagKind::None),
    ("--threads", FlagKind::Number),
    ("--untracked", FlagKind::None),
    ("--word-regexp", FlagKind::None),
];

const GREP_SAFE_FLAGS: Flags = &[
    ("-A", FlagKind::Number),
    ("-B", FlagKind::Number),
    ("-C", FlagKind::Number),
    ("-D", FlagKind::Str),
    ("-E", FlagKind::None),
    ("-F", FlagKind::None),
    ("-G", FlagKind::None),
    ("-H", FlagKind::None),
    ("-I", FlagKind::None),
    ("-L", FlagKind::None),
    ("-P", FlagKind::None),
    ("-R", FlagKind::None),
    ("-T", FlagKind::None),
    ("-U", FlagKind::None),
    ("-V", FlagKind::None),
    ("-Z", FlagKind::None),
    ("-a", FlagKind::None),
    ("-b", FlagKind::None),
    ("-c", FlagKind::None),
    ("-d", FlagKind::Str),
    ("-e", FlagKind::Str),
    ("-f", FlagKind::Str),
    ("-h", FlagKind::None),
    ("-i", FlagKind::None),
    ("-l", FlagKind::None),
    ("-m", FlagKind::Number),
    ("-n", FlagKind::None),
    ("-o", FlagKind::None),
    ("-q", FlagKind::None),
    ("-r", FlagKind::None),
    ("-s", FlagKind::None),
    ("-u", FlagKind::None),
    ("-v", FlagKind::None),
    ("-w", FlagKind::None),
    ("-x", FlagKind::None),
    ("-z", FlagKind::None),
    ("--after-context", FlagKind::Number),
    ("--basic-regexp", FlagKind::None),
    ("--before-context", FlagKind::Number),
    ("--binary", FlagKind::None),
    ("--binary-files", FlagKind::Str),
    ("--byte-offset", FlagKind::None),
    ("--color", FlagKind::Str),
    ("--colour", FlagKind::Str),
    ("--context", FlagKind::Number),
    ("--count", FlagKind::None),
    ("--dereference-recursive", FlagKind::None),
    ("--devices", FlagKind::Str),
    ("--directories", FlagKind::Str),
    ("--exclude", FlagKind::Str),
    ("--exclude-dir", FlagKind::Str),
    ("--exclude-from", FlagKind::Str),
    ("--extended-regexp", FlagKind::None),
    ("--file", FlagKind::Str),
    ("--files-with-matches", FlagKind::None),
    ("--files-without-match", FlagKind::None),
    ("--fixed-strings", FlagKind::None),
    ("--group-separator", FlagKind::Str),
    ("--help", FlagKind::None),
    ("--ignore-case", FlagKind::None),
    ("--include", FlagKind::Str),
    ("--initial-tab", FlagKind::None),
    ("--invert-match", FlagKind::None),
    ("--label", FlagKind::Str),
    ("--line-buffered", FlagKind::None),
    ("--line-number", FlagKind::None),
    ("--line-regexp", FlagKind::None),
    ("--max-count", FlagKind::Number),
    ("--no-filename", FlagKind::None),
    ("--no-group-separator", FlagKind::None),
    ("--no-ignore-case", FlagKind::None),
    ("--no-messages", FlagKind::None),
    ("--null", FlagKind::None),
    ("--null-data", FlagKind::None),
    ("--only-matching", FlagKind::None),
    ("--perl-regexp", FlagKind::None),
    ("--quiet", FlagKind::None),
    ("--recursive", FlagKind::None),
    ("--regexp", FlagKind::Str),
    ("--silent", FlagKind::None),
    ("--text", FlagKind::None),
    ("--unix-byte-offsets", FlagKind::None),
    ("--version", FlagKind::None),
    ("--with-filename", FlagKind::None),
    ("--word-regexp", FlagKind::None),
];

const RG_SAFE_FLAGS: Flags = &[
    ("-A", FlagKind::Number),
    ("-B", FlagKind::Number),
    ("-C", FlagKind::Number),
    ("-F", FlagKind::None),
    ("-H", FlagKind::None),
    ("-L", FlagKind::None),
    ("-N", FlagKind::None),
    ("-S", FlagKind::None),
    ("-T", FlagKind::Str),
    ("-c", FlagKind::None),
    ("-e", FlagKind::Str),
    ("-g", FlagKind::Str),
    ("-h", FlagKind::None),
    ("-i", FlagKind::None),
    ("-l", FlagKind::None),
    ("-m", FlagKind::Number),
    ("-n", FlagKind::None),
    ("-s", FlagKind::None),
    ("-t", FlagKind::Str),
    ("-u", FlagKind::None),
    ("-v", FlagKind::None),
    ("-w", FlagKind::None),
    ("-x", FlagKind::None),
    ("--after-context", FlagKind::Number),
    ("--before-context", FlagKind::Number),
    ("--case-sensitive", FlagKind::None),
    ("--context", FlagKind::Number),
    ("--count", FlagKind::None),
    ("--count-matches", FlagKind::None),
    ("--files", FlagKind::None),
    ("--files-with-matches", FlagKind::None),
    ("--fixed-strings", FlagKind::None),
    ("--follow", FlagKind::None),
    ("--glob", FlagKind::Str),
    ("--hidden", FlagKind::None),
    ("--iglob", FlagKind::Str),
    ("--ignore-case", FlagKind::None),
    ("--ignore-file", FlagKind::Str),
    ("--invert-match", FlagKind::None),
    ("--json", FlagKind::None),
    ("--line-number", FlagKind::None),
    ("--line-regexp", FlagKind::None),
    ("--max-count", FlagKind::Number),
    ("--max-depth", FlagKind::Number),
    ("--max-filesize", FlagKind::Str),
    ("--no-filename", FlagKind::None),
    ("--no-ignore", FlagKind::None),
    ("--no-ignore-parent", FlagKind::None),
    ("--no-ignore-vcs", FlagKind::None),
    ("--no-line-number", FlagKind::None),
    ("--pcre2", FlagKind::None),
    ("--regexp", FlagKind::Str),
    ("--smart-case", FlagKind::None),
    ("--sort", FlagKind::Str),
    ("--sortr", FlagKind::Str),
    ("--type", FlagKind::Str),
    ("--type-not", FlagKind::Str),
    ("--unrestricted", FlagKind::None),
    ("--with-filename", FlagKind::None),
    ("--word-regexp", FlagKind::None),
];

const CAT_SAFE_FLAGS: Flags = &[
    ("-A", FlagKind::None),
    ("-E", FlagKind::None),
    ("-T", FlagKind::None),
    ("-b", FlagKind::None),
    ("-e", FlagKind::None),
    ("-n", FlagKind::None),
    ("-s", FlagKind::None),
    ("-t", FlagKind::None),
    ("-u", FlagKind::None),
    ("-v", FlagKind::None),
    ("--number", FlagKind::None),
    ("--number-nonblank", FlagKind::None),
    ("--show-all", FlagKind::None),
    ("--show-ends", FlagKind::None),
    ("--show-nonprinting", FlagKind::None),
    ("--show-tabs", FlagKind::None),
    ("--squeeze-blank", FlagKind::None),
];

const HEAD_TAIL_SAFE_FLAGS: Flags = &[
    ("-c", FlagKind::Number),
    ("-n", FlagKind::Number),
    ("-q", FlagKind::None),
    ("-v", FlagKind::None),
    ("--bytes", FlagKind::Number),
    ("--lines", FlagKind::Number),
    ("--quiet", FlagKind::None),
    ("--silent", FlagKind::None),
    ("--verbose", FlagKind::None),
];

const WC_SAFE_FLAGS: Flags = &[
    ("-L", FlagKind::None),
    ("-c", FlagKind::None),
    ("-l", FlagKind::None),
    ("-m", FlagKind::None),
    ("-w", FlagKind::None),
    ("--bytes", FlagKind::None),
    ("--chars", FlagKind::None),
    ("--lines", FlagKind::None),
    ("--max-line-length", FlagKind::None),
    ("--words", FlagKind::None),
];

const TREE_SAFE_FLAGS: Flags = &[
    ("-A", FlagKind::None),
    ("-C", FlagKind::None),
    ("-D", FlagKind::None),
    ("-F", FlagKind::None),
    ("-H", FlagKind::Str),
    ("-I", FlagKind::Str),
    ("-J", FlagKind::None),
    ("-L", FlagKind::Number),
    ("-N", FlagKind::None),
    ("-P", FlagKind::Str),
    ("-Q", FlagKind::None),
    ("-S", FlagKind::None),
    ("-T", FlagKind::Str),
    ("-U", FlagKind::None),
    ("-X", FlagKind::None),
    ("-a", FlagKind::None),
    ("-c", FlagKind::None),
    ("-d", FlagKind::None),
    ("-f", FlagKind::None),
    ("-g", FlagKind::None),
    ("-h", FlagKind::None),
    ("-i", FlagKind::None),
    ("-l", FlagKind::None),
    ("-n", FlagKind::None),
    ("-p", FlagKind::None),
    ("-q", FlagKind::None),
    ("-r", FlagKind::None),
    ("-s", FlagKind::None),
    ("-t", FlagKind::None),
    ("-u", FlagKind::None),
    ("-v", FlagKind::None),
    ("-x", FlagKind::None),
    ("--authority", FlagKind::Str),
    ("--charset", FlagKind::Str),
    ("--device", FlagKind::None),
    ("--dirsfirst", FlagKind::None),
    ("--du", FlagKind::None),
    ("--fflinks", FlagKind::None),
    ("--filelimit", FlagKind::Number),
    ("--filesfirst", FlagKind::None),
    ("--fromfile", FlagKind::None),
    ("--fromtabfile", FlagKind::None),
    ("--gitfile", FlagKind::Str),
    ("--gitignore", FlagKind::None),
    ("--help", FlagKind::None),
    ("--hintro", FlagKind::Str),
    ("--houtro", FlagKind::Str),
    ("--hyperlink", FlagKind::None),
    ("--ignore-case", FlagKind::None),
    ("--inodes", FlagKind::None),
    ("--info", FlagKind::None),
    ("--infofile", FlagKind::Str),
    ("--matchdirs", FlagKind::None),
    ("--metafirst", FlagKind::None),
    ("--nolinks", FlagKind::None),
    ("--noreport", FlagKind::None),
    ("--prune", FlagKind::None),
    ("--scheme", FlagKind::Str),
    ("--si", FlagKind::None),
    ("--sort", FlagKind::Str),
    ("--timefmt", FlagKind::Str),
    ("--version", FlagKind::None),
];

const FILE_SAFE_FLAGS: Flags = &[
    ("-0", FlagKind::None),
    ("-F", FlagKind::Str),
    ("-L", FlagKind::None),
    ("-b", FlagKind::None),
    ("-c", FlagKind::None),
    ("-f", FlagKind::Str),
    ("-h", FlagKind::None),
    ("-i", FlagKind::None),
    ("-k", FlagKind::None),
    ("-l", FlagKind::None),
    ("-m", FlagKind::Str),
    ("-n", FlagKind::None),
    ("-p", FlagKind::None),
    ("-r", FlagKind::None),
    ("-s", FlagKind::None),
    ("-v", FlagKind::None),
    ("--apple", FlagKind::None),
    ("--brief", FlagKind::None),
    ("--check-encoding", FlagKind::None),
    ("--dereference", FlagKind::None),
    ("--exclude", FlagKind::Str),
    ("--exclude-quiet", FlagKind::Str),
    ("--help", FlagKind::None),
    ("--keep-going", FlagKind::None),
    ("--list", FlagKind::None),
    ("--magic-file", FlagKind::Str),
    ("--mime", FlagKind::None),
    ("--mime-encoding", FlagKind::None),
    ("--mime-type", FlagKind::None),
    ("--no-buffer", FlagKind::None),
    ("--no-dereference", FlagKind::None),
    ("--preserve-date", FlagKind::None),
    ("--print0", FlagKind::None),
    ("--raw", FlagKind::None),
    ("--separator", FlagKind::Str),
    ("--special-files", FlagKind::None),
    ("--version", FlagKind::None),
];

const SED_SAFE_FLAGS: Flags = &[
    ("-E", FlagKind::None),
    ("-e", FlagKind::Str),
    ("-l", FlagKind::Number),
    ("-n", FlagKind::None),
    ("-r", FlagKind::None),
    ("-s", FlagKind::None),
    ("-u", FlagKind::None),
    ("-z", FlagKind::None),
    ("--debug", FlagKind::None),
    ("--expression", FlagKind::Str),
    ("--help", FlagKind::None),
    ("--line-length", FlagKind::Number),
    ("--posix", FlagKind::None),
    ("--quiet", FlagKind::None),
    ("--regexp-extended", FlagKind::None),
    ("--separate", FlagKind::None),
    ("--silent", FlagKind::None),
    ("--unbuffered", FlagKind::None),
    ("--version", FlagKind::None),
    ("--zero-terminated", FlagKind::None),
];

const JQ_SAFE_FLAGS: Flags = &[
    ("-C", FlagKind::None),
    ("-M", FlagKind::None),
    ("-S", FlagKind::None),
    ("-c", FlagKind::None),
    ("-e", FlagKind::None),
    ("-n", FlagKind::None),
    ("-r", FlagKind::None),
    ("-s", FlagKind::None),
    ("--color-output", FlagKind::None),
    ("--compact-output", FlagKind::None),
    ("--exit-status", FlagKind::None),
    ("--indent", FlagKind::Number),
    ("--monochrome-output", FlagKind::None),
    ("--null-input", FlagKind::None),
    ("--raw-output", FlagKind::None),
    ("--slurp", FlagKind::None),
    ("--sort-keys", FlagKind::None),
    ("--tab", FlagKind::None),
];

/// 单命令只读策略表覆盖的命令名。
const READONLY_POLICY_COMMANDS: &[&str] = &[
    "cat", "cut", "diff", "dirname", "du", "echo", "egrep", "fgrep", "file", "find", "grep",
    "head", "hexdump", "id", "jq", "ls", "nl", "printf", "pwd", "readlink", "realpath", "rev",
    "rg", "sed", "sort", "stat", "strings", "tail", "tr", "tree", "uniq", "uname", "wc", "which",
    "whoami",
];

/// 单命令只读策略表（命令名 → 策略）。
fn command_policy(name: &str) -> Option<CommandPolicy> {
    let policy = match name {
        "cat" => CommandPolicy::with_flags(CAT_SAFE_FLAGS),
        "head" | "tail" => CommandPolicy::with_flags(HEAD_TAIL_SAFE_FLAGS),
        "wc" => CommandPolicy::with_flags(WC_SAFE_FLAGS),
        "grep" | "egrep" | "fgrep" => CommandPolicy::with_flags(GREP_SAFE_FLAGS),
        "rg" => CommandPolicy::with_flags(RG_SAFE_FLAGS),
        "tree" => CommandPolicy::with_flags(TREE_SAFE_FLAGS),
        "file" => CommandPolicy::with_flags(FILE_SAFE_FLAGS),
        "sed" => CommandPolicy::with_flags(SED_SAFE_FLAGS),
        "jq" => CommandPolicy::with_flags(JQ_SAFE_FLAGS),
        "diff" | "cut" | "dirname" | "du" | "echo" | "find" | "hexdump" | "id" | "ls" | "nl"
        | "printf" | "readlink" | "realpath" | "rev" | "sort" | "stat" | "strings" | "tr"
        | "uniq" | "uname" | "which" => CommandPolicy::any_args(),
        "pwd" | "whoami" => CommandPolicy::only(),
        _ => return None,
    };
    Some(policy)
}

/// `git` 子命令只读策略：前缀词 + 标志表 + 回调。
struct GitPolicy {
    prefix: &'static [&'static str],
    flags: Flags,
    callback: Option<Callback>,
    allow_compact_numeric_count: bool,
}

const GIT_POLICIES: &[GitPolicy] = &[
    GitPolicy {
        prefix: &["git", "config", "--get"],
        flags: &[
            ("-z", FlagKind::None),
            ("--bool", FlagKind::None),
            ("--bool-or-int", FlagKind::None),
            ("--default", FlagKind::Str),
            ("--expiry-date", FlagKind::None),
            ("--global", FlagKind::None),
            ("--int", FlagKind::None),
            ("--local", FlagKind::None),
            ("--name-only", FlagKind::None),
            ("--null", FlagKind::None),
            ("--path", FlagKind::None),
            ("--show-origin", FlagKind::None),
            ("--show-scope", FlagKind::None),
            ("--system", FlagKind::None),
            ("--type", FlagKind::Str),
            ("--worktree", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "for-each-ref"],
        flags: &[
            ("--contains", FlagKind::Str),
            ("--count", FlagKind::Number),
            ("--format", FlagKind::Str),
            ("--merged", FlagKind::Str),
            ("--no-contains", FlagKind::Str),
            ("--no-merged", FlagKind::Str),
            ("--points-at", FlagKind::Str),
            ("--sort", FlagKind::Str),
        ],
        callback: Some(Callback::RevisionFormat),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "ls-remote"],
        flags: &[
            ("-b", FlagKind::None),
            ("-h", FlagKind::None),
            ("-q", FlagKind::None),
            ("-t", FlagKind::None),
            ("--branches", FlagKind::None),
            ("--exit-code", FlagKind::None),
            ("--get-url", FlagKind::None),
            ("--heads", FlagKind::None),
            ("--quiet", FlagKind::None),
            ("--refs", FlagKind::None),
            ("--sort", FlagKind::Str),
            ("--symref", FlagKind::None),
            ("--tags", FlagKind::None),
        ],
        callback: Some(Callback::LsRemote),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "merge-base"],
        flags: &[
            ("--all", FlagKind::None),
            ("--fork-point", FlagKind::None),
            ("--independent", FlagKind::None),
            ("--is-ancestor", FlagKind::None),
            ("--octopus", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "remote", "show"],
        flags: &[("-n", FlagKind::None)],
        callback: Some(Callback::RemoteShow),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "stash", "list"],
        flags: &[
            ("-n", FlagKind::Number),
            ("--date", FlagKind::Str),
            ("--decorate", FlagKind::None),
            ("--graph", FlagKind::None),
            ("--max-count", FlagKind::Number),
            ("--no-decorate", FlagKind::None),
            ("--oneline", FlagKind::None),
            ("--relative-date", FlagKind::None),
            ("--all", FlagKind::None),
            ("--branches", FlagKind::None),
            ("--remotes", FlagKind::None),
            ("--tags", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "stash", "show"],
        flags: &[
            ("-p", FlagKind::None),
            ("-s", FlagKind::None),
            ("--abbrev", FlagKind::Number),
            ("--color", FlagKind::None),
            ("--diff-filter", FlagKind::Str),
            ("--name-only", FlagKind::None),
            ("--name-status", FlagKind::None),
            ("--no-color", FlagKind::None),
            ("--no-ext-diff", FlagKind::None),
            ("--no-patch", FlagKind::None),
            ("--numstat", FlagKind::None),
            ("--patch", FlagKind::None),
            ("--shortstat", FlagKind::None),
            ("--stat", FlagKind::None),
            ("--word-diff", FlagKind::None),
            ("--word-diff-regex", FlagKind::Str),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "worktree", "list"],
        flags: &[
            ("-v", FlagKind::None),
            ("--expire", FlagKind::Str),
            ("--porcelain", FlagKind::None),
            ("--verbose", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "cat-file"],
        flags: &[
            ("-e", FlagKind::None),
            ("-p", FlagKind::None),
            ("-s", FlagKind::None),
            ("-t", FlagKind::None),
            ("--allow-undetermined-type", FlagKind::None),
            ("--batch-check", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "ls-files"],
        flags: &[
            ("-c", FlagKind::None),
            ("-d", FlagKind::None),
            ("-f", FlagKind::None),
            ("-i", FlagKind::None),
            ("-k", FlagKind::None),
            ("-m", FlagKind::None),
            ("-o", FlagKind::None),
            ("-s", FlagKind::None),
            ("-t", FlagKind::None),
            ("-u", FlagKind::None),
            ("-v", FlagKind::None),
            ("-x", FlagKind::Str),
            ("-X", FlagKind::Str),
            ("-z", FlagKind::None),
            ("--abbrev", FlagKind::Number),
            ("--cached", FlagKind::None),
            ("--debug", FlagKind::None),
            ("--deleted", FlagKind::None),
            ("--directory", FlagKind::None),
            ("--eol", FlagKind::None),
            ("--error-unmatch", FlagKind::None),
            ("--exclude", FlagKind::Str),
            ("--exclude-from", FlagKind::Str),
            ("--exclude-per-directory", FlagKind::Str),
            ("--exclude-standard", FlagKind::None),
            ("--full-name", FlagKind::None),
            ("--ignored", FlagKind::None),
            ("--killed", FlagKind::None),
            ("--modified", FlagKind::None),
            ("--no-empty-directory", FlagKind::None),
            ("--others", FlagKind::None),
            ("--recurse-submodules", FlagKind::None),
            ("--stage", FlagKind::None),
            ("--unmerged", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "rev-parse"],
        flags: &[
            ("--abbrev-ref", FlagKind::None),
            ("--absolute-git-dir", FlagKind::None),
            ("--git-common-dir", FlagKind::None),
            ("--git-dir", FlagKind::None),
            ("--is-bare-repository", FlagKind::None),
            ("--is-inside-git-dir", FlagKind::None),
            ("--is-inside-work-tree", FlagKind::None),
            ("--is-shallow-repository", FlagKind::None),
            ("--is-shallow-update", FlagKind::None),
            ("--path-prefix", FlagKind::None),
            ("--short", FlagKind::Str),
            ("--show-cdup", FlagKind::None),
            ("--show-prefix", FlagKind::None),
            ("--show-superproject-working-tree", FlagKind::None),
            ("--show-toplevel", FlagKind::None),
            ("--symbolic", FlagKind::None),
            ("--symbolic-full-name", FlagKind::None),
            ("--verify", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "describe"],
        flags: &[
            ("--abbrev", FlagKind::Number),
            ("--always", FlagKind::None),
            ("--broken", FlagKind::None),
            ("--candidates", FlagKind::Number),
            ("--contains", FlagKind::None),
            ("--dirty", FlagKind::None),
            ("--exclude", FlagKind::Str),
            ("--exact-match", FlagKind::None),
            ("--first-match", FlagKind::None),
            ("--long", FlagKind::None),
            ("--match", FlagKind::Str),
            ("--tags", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "blame"],
        flags: &[
            ("-C", FlagKind::None),
            ("-L", FlagKind::Str),
            ("-M", FlagKind::None),
            ("-e", FlagKind::None),
            ("-f", FlagKind::None),
            ("-l", FlagKind::None),
            ("-n", FlagKind::None),
            ("-p", FlagKind::None),
            ("-s", FlagKind::None),
            ("-t", FlagKind::None),
            ("-w", FlagKind::None),
            ("--abbrev", FlagKind::Number),
            ("--color", FlagKind::None),
            ("--date", FlagKind::Str),
            ("--ignore-rev", FlagKind::Str),
            ("--ignore-revs-file", FlagKind::Str),
            ("--incremental", FlagKind::None),
            ("--line-porcelain", FlagKind::None),
            ("--no-color", FlagKind::None),
            ("--porcelain", FlagKind::None),
            ("--root", FlagKind::None),
            ("--score-debug", FlagKind::None),
            ("--show-email", FlagKind::None),
            ("--show-name", FlagKind::None),
            ("--show-number", FlagKind::None),
            ("--show-stats", FlagKind::None),
        ],
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "branch"],
        flags: &[
            ("-a", FlagKind::None),
            ("-i", FlagKind::None),
            ("-l", FlagKind::None),
            ("-r", FlagKind::None),
            ("-v", FlagKind::None),
            ("-vv", FlagKind::None),
            ("--abbrev", FlagKind::Number),
            ("--all", FlagKind::None),
            ("--color", FlagKind::None),
            ("--column", FlagKind::None),
            ("--contains", FlagKind::Str),
            ("--ignore-case", FlagKind::None),
            ("--list", FlagKind::None),
            ("--merged", FlagKind::None),
            ("--no-abbrev", FlagKind::None),
            ("--no-color", FlagKind::None),
            ("--no-column", FlagKind::None),
            ("--no-contains", FlagKind::Str),
            ("--no-merged", FlagKind::None),
            ("--points-at", FlagKind::Str),
            ("--remotes", FlagKind::None),
            ("--show-current", FlagKind::None),
            ("--sort", FlagKind::Str),
            ("--verbose", FlagKind::None),
        ],
        callback: Some(Callback::Branch),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "tag"],
        flags: &[
            ("-i", FlagKind::None),
            ("-l", FlagKind::None),
            ("-n", FlagKind::Number),
            ("--column", FlagKind::None),
            ("--contains", FlagKind::Str),
            ("--format", FlagKind::Str),
            ("--ignore-case", FlagKind::None),
            ("--list", FlagKind::None),
            ("--merged", FlagKind::Str),
            ("--no-column", FlagKind::None),
            ("--no-contains", FlagKind::Str),
            ("--no-merged", FlagKind::Str),
            ("--points-at", FlagKind::Str),
            ("--sort", FlagKind::Str),
        ],
        callback: Some(Callback::Tag),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "reflog"],
        flags: &[
            ("-n", FlagKind::Number),
            ("--date", FlagKind::Str),
            ("--decorate", FlagKind::None),
            ("--graph", FlagKind::None),
            ("--max-count", FlagKind::Number),
            ("--no-decorate", FlagKind::None),
            ("--oneline", FlagKind::None),
            ("--relative-date", FlagKind::None),
            ("--all", FlagKind::None),
            ("--branches", FlagKind::None),
            ("--remotes", FlagKind::None),
            ("--tags", FlagKind::None),
            ("--after", FlagKind::Str),
            ("--before", FlagKind::Str),
            ("--since", FlagKind::Str),
            ("--until", FlagKind::Str),
            ("--name-only", FlagKind::None),
            ("--name-status", FlagKind::None),
            ("--numstat", FlagKind::None),
            ("--shortstat", FlagKind::None),
            ("--stat", FlagKind::None),
            ("--grep", FlagKind::Str),
        ],
        callback: Some(Callback::Reflog),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "remote"],
        flags: &[("-v", FlagKind::None), ("--verbose", FlagKind::None)],
        callback: Some(Callback::RemoteVerboseOnly),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "rev-list"],
        flags: &[
            ("-n", FlagKind::Number),
            ("--abbrev", FlagKind::Number),
            ("--abbrev-commit", FlagKind::None),
            ("--after", FlagKind::Str),
            ("--all", FlagKind::None),
            ("--ancestry-path", FlagKind::None),
            ("--before", FlagKind::Str),
            ("--branches", FlagKind::None),
            ("--count", FlagKind::None),
            ("--dense", FlagKind::None),
            ("--first-parent", FlagKind::None),
            ("--format", FlagKind::Str),
            ("--full-history", FlagKind::None),
            ("--graph", FlagKind::None),
            ("--grep", FlagKind::Str),
            ("--max-age", FlagKind::Number),
            ("--max-count", FlagKind::Number),
            ("--max-parents", FlagKind::Number),
            ("--merges", FlagKind::None),
            ("--min-age", FlagKind::Number),
            ("--min-parents", FlagKind::Number),
            ("--no-max-parents", FlagKind::None),
            ("--no-merges", FlagKind::None),
            ("--no-min-parents", FlagKind::None),
            ("--oneline", FlagKind::None),
            ("--pretty", FlagKind::Str),
            ("--remotes", FlagKind::None),
            ("--reverse", FlagKind::None),
            ("--since", FlagKind::Str),
            ("--skip", FlagKind::Number),
            ("--source", FlagKind::None),
            ("--sparse", FlagKind::None),
            ("--tags", FlagKind::None),
            ("--until", FlagKind::Str),
            ("--walk-reflogs", FlagKind::None),
        ],
        callback: Some(Callback::RevisionFormat),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "shortlog"],
        flags: &[
            ("-c", FlagKind::None),
            ("-e", FlagKind::None),
            ("-n", FlagKind::None),
            ("-s", FlagKind::None),
            ("--after", FlagKind::Str),
            ("--all", FlagKind::None),
            ("--author", FlagKind::Str),
            ("--before", FlagKind::Str),
            ("--branches", FlagKind::None),
            ("--committer", FlagKind::None),
            ("--email", FlagKind::None),
            ("--format", FlagKind::Str),
            ("--group", FlagKind::Str),
            ("--no-merges", FlagKind::None),
            ("--numbered", FlagKind::None),
            ("--remotes", FlagKind::None),
            ("--since", FlagKind::Str),
            ("--summary", FlagKind::None),
            ("--tags", FlagKind::None),
            ("--until", FlagKind::Str),
        ],
        callback: Some(Callback::RevisionFormat),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "show"],
        flags: GIT_SHOW_SAFE_FLAGS,
        callback: Some(Callback::RevisionFormat),
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "status"],
        flags: GIT_STATUS_SAFE_FLAGS,
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "diff"],
        flags: GIT_DIFF_SAFE_FLAGS,
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "grep"],
        flags: GIT_GREP_SAFE_FLAGS,
        callback: None,
        allow_compact_numeric_count: false,
    },
    GitPolicy {
        prefix: &["git", "log"],
        flags: GIT_LOG_SAFE_FLAGS,
        callback: Some(Callback::RevisionFormat),
        allow_compact_numeric_count: true,
    },
];

/// 判定 argv 是否可证明只读。
fn is_read_only_argv(argv: &[String]) -> bool {
    let stripped = strip_safe_command_wrappers(argv);
    if stripped.is_empty() {
        return false;
    }
    if stripped.iter().any(|word| is_unsafe_windows_unc_path(word)) {
        return false;
    }
    let name = stripped[0].as_str();
    if name == "git" {
        return is_git_read_only(&stripped);
    }
    if READONLY_EXACT_ARGV
        .iter()
        .any(|expected| argv_matches_exact(&stripped, expected))
    {
        return true;
    }
    if name == "find" {
        return is_safe_find_argv(&stripped);
    }
    if name == "tree" && tree_argv_has_output_option(&stripped) {
        return false;
    }
    if READONLY_ALLOW_ANY_ARGS.contains(&name) {
        return true;
    }
    if READONLY_COMMAND_ONLY.contains(&name) {
        return stripped.len() == 1;
    }
    let Some(policy) = command_policy(name) else {
        return false;
    };
    if policy.callback.is_some() {
        return false;
    }
    if !flags_and_positionals_allowed(&stripped, &policy, name, 1) {
        return false;
    }
    if name == "sed" && stripped.iter().any(|word| is_sed_in_place_option(word)) {
        return false;
    }
    true
}

/// 剥掉 `command` / `builtin` / `noglob` 这类不改变语义的包装。
fn strip_safe_command_wrappers(argv: &[String]) -> Vec<String> {
    let mut stripped: Vec<String> = argv.to_vec();
    loop {
        match stripped.first().map(String::as_str) {
            Some("command") => {
                let mut index = 1;
                while stripped
                    .get(index)
                    .map(|word| is_dash_p_run(word))
                    .unwrap_or(false)
                {
                    index += 1;
                }
                if stripped.get(index).map(String::as_str) == Some("--") {
                    index += 1;
                }
                if index >= stripped.len() || stripped[index].starts_with('-') {
                    return stripped;
                }
                stripped = stripped[index..].to_vec();
            }
            Some("builtin") => {
                let index = if stripped.get(1).map(String::as_str) == Some("--") {
                    2
                } else {
                    1
                };
                if index >= stripped.len() {
                    return stripped;
                }
                stripped = stripped[index..].to_vec();
            }
            Some("noglob") => {
                if stripped.len() <= 1 {
                    return stripped;
                }
                stripped = stripped[1..].to_vec();
            }
            _ => return stripped,
        }
    }
}

fn is_dash_p_run(word: &str) -> bool {
    word.len() > 1 && word.starts_with('-') && word[1..].chars().all(|c| c == 'p')
}

fn argv_matches_exact(argv: &[String], expected: &[&str]) -> bool {
    argv.len() == expected.len()
        && expected
            .iter()
            .enumerate()
            .all(|(index, word)| argv[index] == *word)
}

fn is_unsafe_windows_unc_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 3 {
        return false;
    }
    let double_slash =
        (bytes[0] == b'/' && bytes[1] == b'/') || (bytes[0] == b'\\' && bytes[1] == b'\\');
    double_slash && bytes[2] != b'/' && bytes[2] != b'\\'
}

fn is_sed_in_place_option(word: &str) -> bool {
    word.starts_with("-i") || word == "--in-place" || word.starts_with("--in-place=")
}

fn tree_argv_has_output_option(argv: &[String]) -> bool {
    for word in argv.iter().skip(1) {
        if word == "--" {
            return false;
        }
        if word == "-o" || word == "--output" || word.starts_with("--output=") {
            return true;
        }
        if word.starts_with('-') && !word.starts_with("--") && word[1..].contains('o') {
            return true;
        }
    }
    false
}

fn is_find_write_option(word: &str) -> bool {
    FIND_WRITE_OPTIONS.contains(&word)
}

fn is_newer_variant(word: &str) -> bool {
    let bytes = word.as_bytes();
    if bytes.len() != 8 || !word.starts_with("-newer") {
        return false;
    }
    let first = bytes[6] as char;
    let second = bytes[7] as char;
    matches!(first, 'a' | 'B' | 'c' | 'm') && matches!(second, 'a' | 'B' | 'c' | 'm' | 't')
}

fn is_safe_find_argv(argv: &[String]) -> bool {
    let mut index = 1;
    while index < argv.len() {
        let word = argv[index].as_str();
        if is_find_write_option(word) {
            return false;
        }
        if FIND_VALUE_OPTIONS.contains(&word) || is_newer_variant(word) {
            index += 2;
            continue;
        }
        index += 1;
    }
    true
}

// ---------------------------------------------------------------------------
// 标志与位置参数
// ---------------------------------------------------------------------------

fn option_pattern(word: &str) -> bool {
    let bytes = word.as_bytes();
    bytes.len() >= 2
        && bytes[0] == b'-'
        && (bytes[1].is_ascii_alphanumeric() || bytes[1] == b'_' || bytes[1] == b'-')
}

fn lookup_flag(flags: Flags, name: &str) -> Option<FlagKind> {
    flags
        .iter()
        .find(|(flag, _)| *flag == name)
        .map(|(_, kind)| *kind)
}

fn is_compact_numeric(word: &str) -> bool {
    word.len() >= 2 && word.starts_with('-') && word[1..].chars().all(|c| c.is_ascii_digit())
}

/// 移植上游 `isArgvAllowedByPolicy`：逐个检查标志与位置参数。
fn flags_and_positionals_allowed(
    argv: &[String],
    policy: &CommandPolicy,
    command_name: &str,
    start_index: usize,
) -> bool {
    if argv.is_empty() {
        return false;
    }
    if policy.allow_any_args {
        return true;
    }
    if policy.command_only {
        return argv.len() == start_index;
    }
    let mut index = start_index;
    while index < argv.len() {
        let word = argv[index].as_str();
        if word.is_empty() {
            index += 1;
            continue;
        }
        if word == "--" {
            if !policy.respects_double_dash {
                index += 1;
                continue;
            }
            break;
        }
        if (command_name == "head" || command_name == "tail") && is_compact_numeric(word) {
            index += 1;
            continue;
        }
        if policy.allow_compact_numeric_count && is_compact_numeric(word) {
            index += 1;
            continue;
        }
        if word.len() > 1 && word.starts_with('-') && option_pattern(word) {
            let (flag, has_inline, inline_value) = parse_option_word(word);
            match lookup_flag(policy.flags, flag) {
                None => {
                    if let Some((short_flag, kind, value)) =
                        parse_short_flag_with_attached_value(word, policy.flags)
                    {
                        if !is_option_like_string_value_allowed(value, command_name, short_flag) {
                            return false;
                        }
                        if !matches_flag_value_kind(value, kind) {
                            return false;
                        }
                        index += 1;
                        continue;
                    }
                    if is_short_flag_cluster_allowed(flag, policy.flags) {
                        index += 1;
                        continue;
                    }
                    return false;
                }
                Some(FlagKind::None) => {
                    if has_inline {
                        return false;
                    }
                    index += 1;
                    continue;
                }
                Some(kind) => {
                    let value = if has_inline {
                        Some(inline_value)
                    } else {
                        argv.get(index + 1).map(String::as_str)
                    };
                    let Some(value) = value else { return false };
                    if kind == FlagKind::Str
                        && !has_inline
                        && !is_option_like_string_value_allowed(value, command_name, flag)
                    {
                        return false;
                    }
                    if !matches_flag_value_kind(value, kind) {
                        return false;
                    }
                    index += if has_inline { 1 } else { 2 };
                    continue;
                }
            }
        }
        index += 1;
    }
    true
}

fn parse_option_word(word: &str) -> (&str, bool, &str) {
    match word.find('=') {
        None => (word, false, ""),
        Some(index) => (&word[..index], true, &word[index + 1..]),
    }
}

fn parse_short_flag_with_attached_value(
    word: &str,
    flags: Flags,
) -> Option<(&str, FlagKind, &str)> {
    if !word.starts_with('-') || word.starts_with("--") || word.len() <= 2 {
        return None;
    }
    let flag = &word[..2];
    let kind = lookup_flag(flags, flag)?;
    if kind == FlagKind::None {
        return None;
    }
    Some((flag, kind, &word[2..]))
}

fn is_short_flag_cluster_allowed(flag: &str, flags: Flags) -> bool {
    if !flag.starts_with('-') || flag.starts_with("--") || flag.len() <= 2 {
        return false;
    }
    flag[1..]
        .chars()
        .all(|name| lookup_flag(flags, &format!("-{name}")) == Some(FlagKind::None))
}

fn is_option_like_string_value_allowed(value: &str, command_name: &str, flag: &str) -> bool {
    if !value.starts_with('-') || value.len() <= 1 || !option_pattern(value) {
        return true;
    }
    command_name == "git"
        && flag == "--sort"
        && value
            .strip_prefix('-')
            .map(|rest| {
                rest.chars()
                    .next()
                    .map(|c| c.is_ascii_alphabetic())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
}

fn matches_flag_value_kind(value: &str, kind: FlagKind) -> bool {
    match kind {
        FlagKind::None => false,
        FlagKind::Number => !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()),
        FlagKind::Str => true,
    }
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

fn has_dangerous_git_global_option_word(word: &str) -> bool {
    if has_dangerous_attached_git_short_option_word(word) {
        return true;
    }
    if GIT_GLOBAL_DANGEROUS_FLAGS.contains(&word) {
        return true;
    }
    GIT_GLOBAL_DANGEROUS_FLAGS
        .iter()
        .any(|flag| word.starts_with(&format!("{flag}=")))
}

fn has_dangerous_attached_git_short_option_word(word: &str) -> bool {
    ["-c", "-C"].iter().any(|flag| {
        word.len() > flag.len()
            && word.starts_with(flag)
            && (*flag == "-C" || !word[flag.len()..].starts_with('-'))
    })
}

fn is_git_read_only(argv: &[String]) -> bool {
    let Some(normalized) = normalize_git_argv(argv) else {
        return false;
    };
    // 前缀长的优先匹配（`git remote show` 先于 `git remote`）。
    let mut policies: Vec<&GitPolicy> = GIT_POLICIES.iter().collect();
    policies.sort_by_key(|policy| std::cmp::Reverse(policy.prefix.len()));
    for policy in policies {
        if !policy
            .prefix
            .iter()
            .enumerate()
            .all(|(index, word)| normalized.get(index).map(String::as_str) == Some(*word))
        {
            continue;
        }
        let args = &normalized[policy.prefix.len()..];
        if let Some(callback) = policy.callback {
            if git_callback_is_dangerous(callback, args) {
                return false;
            }
        }
        let policy_value = CommandPolicy {
            allow_any_args: false,
            command_only: false,
            flags: policy.flags,
            respects_double_dash: true,
            allow_compact_numeric_count: policy.allow_compact_numeric_count,
            callback: None,
        };
        return flags_and_positionals_allowed(
            &normalized,
            &policy_value,
            "git",
            policy.prefix.len(),
        );
    }
    false
}

fn normalize_git_argv(argv: &[String]) -> Option<Vec<String>> {
    let mut normalized = vec!["git".to_owned()];
    let mut index = 1;
    while index < argv.len() {
        let word = argv[index].as_str();
        if word.is_empty() {
            index += 1;
            continue;
        }
        if GIT_GLOBAL_NO_VALUE_FLAGS.contains(&word) {
            index += 1;
            continue;
        }
        if has_dangerous_git_global_option_word(word) {
            return None;
        }
        if word.starts_with('-') {
            return None;
        }
        normalized.extend(argv[index..].iter().cloned());
        return Some(normalized);
    }
    None
}

fn git_callback_is_dangerous(callback: Callback, args: &[String]) -> bool {
    match callback {
        Callback::RevisionFormat => git_revision_format_is_dangerous(args),
        Callback::Reflog => {
            let allowed = ["show", "list"];
            let dangerous = ["expire", "delete", "exists", "drop", "write"];
            if let Some(first) = args
                .iter()
                .find(|arg| !arg.is_empty() && !arg.starts_with('-'))
            {
                if !allowed.contains(&first.as_str()) {
                    return true;
                }
            }
            args.iter().any(|arg| dangerous.contains(&arg.as_str()))
        }
        Callback::LsRemote => {
            let mut after_double_dash = false;
            let mut index = 0;
            while index < args.len() {
                let arg = args[index].as_str();
                if !after_double_dash && arg == "--" {
                    after_double_dash = true;
                    index += 1;
                    continue;
                }
                if !after_double_dash && (arg.starts_with('-') || arg.is_empty()) {
                    if arg == "--sort" {
                        index += 1;
                    }
                    index += 1;
                    continue;
                }
                return true;
            }
            false
        }
        Callback::RemoteShow => {
            let double_dash_index = args.iter().position(|arg| arg == "--");
            let (option_args, positional_args): (Vec<&String>, Vec<&String>) =
                match double_dash_index {
                    None => (args.iter().collect(), Vec::new()),
                    Some(index) => (
                        args[..index].iter().collect(),
                        args[index + 1..].iter().collect(),
                    ),
                };
            if !option_args.iter().any(|arg| arg.as_str() == "-n") {
                return true;
            }
            let mut positionals: Vec<&str> =
                positional_args.iter().map(|arg| arg.as_str()).collect();
            positionals.extend(
                option_args
                    .iter()
                    .filter(|arg| arg.as_str() != "-n")
                    .map(|arg| arg.as_str()),
            );
            if positionals.len() != 1 {
                return true;
            }
            let name = positionals[0];
            let mut chars = name.chars();
            match chars.next() {
                Some(first) if first.is_ascii_alphanumeric() || first == '_' => {}
                _ => return true,
            }
            !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        }
        Callback::RemoteVerboseOnly => args
            .iter()
            .any(|arg| arg.as_str() != "-v" && arg.as_str() != "--verbose"),
        Callback::Tag => git_list_like_is_dangerous(
            args,
            &[
                "--contains",
                "--no-contains",
                "--merged",
                "--no-merged",
                "--points-at",
                "--sort",
                "--format",
                "-n",
            ],
        ),
        Callback::Branch => git_list_like_is_dangerous(
            args,
            &["--contains", "--no-contains", "--points-at", "--sort"],
        ),
    }
}

fn git_revision_format_is_dangerous(args: &[String]) -> bool {
    for (index, arg) in args.iter().enumerate() {
        let value = if let Some(position) = arg.find('=') {
            Some(&arg[position + 1..])
        } else {
            args.get(index + 1).map(String::as_str)
        };
        let is_format_flag = arg == "--format"
            || arg == "--pretty"
            || arg.starts_with("--format=")
            || arg.starts_with("--pretty=");
        if !is_format_flag {
            continue;
        }
        let Some(value) = value else { continue };
        if value.contains("%G") || value.contains("% G") || value.contains("%+G") {
            return true;
        }
        if value.contains("%(*signature") || value.contains("%(signature") {
            return true;
        }
    }
    false
}

fn git_list_like_is_dangerous(args: &[String], value_flags: &[&str]) -> bool {
    let mut has_list = false;
    let mut after_double_dash = false;
    let mut previous_flag = String::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg.is_empty() {
            index += 1;
            continue;
        }
        if arg == "--" && !after_double_dash {
            after_double_dash = true;
            previous_flag.clear();
            index += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') {
            if arg == "--list"
                || arg == "-l"
                || (arg.starts_with('-') && !arg.starts_with("--") && arg[1..].contains('l'))
            {
                has_list = true;
            }
            previous_flag = match arg.find('=') {
                Some(position) => arg[..position].to_owned(),
                None => arg.to_owned(),
            };
            if !arg.contains('=') && value_flags.contains(&previous_flag.as_str()) {
                index += 1;
            }
            index += 1;
            continue;
        }
        if !has_list && previous_flag != "--merged" && previous_flag != "--no-merged" {
            return true;
        }
        index += 1;
    }
    false
}

// ---------------------------------------------------------------------------
// 会改变状态的意图
// ---------------------------------------------------------------------------

/// `git` 子命令里会对外发布、丢弃未提交工作或改写历史的一批。
const GIT_STATE_CHANGING_SUBCOMMANDS: &[&str] = &[
    "push",
    "clean",
    "filter-branch",
    "gc",
    "prune",
    "repack",
    "update-ref",
    "apply",
    "am",
    "submodule",
];

/// 包管理器里会对外发布或改账号状态的一批。
const PUBLISH_STATE_CHANGING_SUBCOMMANDS: &[&str] = &[
    "publish",
    "unpublish",
    "deprecate",
    "dist-tag",
    "login",
    "logout",
    "adduser",
    "owner",
    "token",
];

fn has_known_write_option(argv: &[String]) -> bool {
    let stripped = strip_safe_command_wrappers(argv);
    let Some(name) = stripped.first().map(String::as_str) else {
        return false;
    };
    match name {
        "sed" => stripped.iter().any(|word| is_sed_in_place_option(word)),
        "find" => stripped.iter().any(|word| is_find_write_option(word)),
        "tree" => tree_argv_has_output_option(&stripped),
        "git" => stripped
            .iter()
            .any(|word| has_dangerous_git_global_option_word(word)),
        _ => false,
    }
}

fn has_state_changing_intent(argv: &[String]) -> bool {
    if has_known_write_option(argv) {
        return true;
    }
    let stripped = strip_safe_command_wrappers(argv);
    let Some(name) = stripped.first().map(String::as_str) else {
        return false;
    };
    let rest: Vec<&str> = stripped[1..].iter().map(String::as_str).collect();
    match name {
        "git" => git_state_changing(&rest),
        "npm" | "pnpm" | "yarn" | "bun" => {
            let Some(subcommand) = rest.iter().find(|word| !word.starts_with('-')) else {
                return false;
            };
            PUBLISH_STATE_CHANGING_SUBCOMMANDS.contains(subcommand)
        }
        "cargo" => {
            let Some(subcommand) = rest.iter().find(|word| !word.starts_with('-')) else {
                return false;
            };
            matches!(
                *subcommand,
                "publish" | "yank" | "login" | "logout" | "owner"
            )
        }
        _ => false,
    }
}

fn git_state_changing(args: &[&str]) -> bool {
    let Some(subcommand) = args.iter().find(|word| !word.starts_with('-')) else {
        return false;
    };
    if GIT_STATE_CHANGING_SUBCOMMANDS.contains(subcommand) {
        return true;
    }
    let tail: Vec<&str> = args.to_vec();
    match *subcommand {
        "reset" => tail.contains(&"--hard"),
        "reflog" => tail.iter().any(|word| matches!(*word, "expire" | "delete")),
        "stash" => tail
            .iter()
            .any(|word| matches!(*word, "drop" | "clear" | "pop")),
        "tag" => tail.iter().any(|word| {
            *word == "-d" || *word == "--delete" || *word == "-f" || *word == "--force"
        }),
        "branch" => tail
            .iter()
            .any(|word| matches!(*word, "-d" | "-D" | "--delete" | "-m" | "-M" | "--move")),
        "remote" => tail.iter().any(|word| {
            matches!(
                *word,
                "add"
                    | "remove"
                    | "rm"
                    | "set-url"
                    | "rename"
                    | "prune"
                    | "set-branches"
                    | "set-head"
            )
        }),
        "worktree" => tail.iter().any(|word| {
            matches!(
                *word,
                "add" | "remove" | "move" | "prune" | "lock" | "unlock"
            )
        }),
        _ => false,
    }
}

/// 只读命令集合：供 UI 或审计在需要时枚举。
pub fn read_only_command_names() -> BTreeSet<&'static str> {
    let mut names: BTreeSet<&'static str> = BTreeSet::new();
    names.extend(READONLY_ALLOW_ANY_ARGS.iter().copied());
    names.extend(READONLY_COMMAND_ONLY.iter().copied());
    names.extend(READONLY_POLICY_COMMANDS.iter().copied());
    for policy in GIT_POLICIES {
        if let Some(name) = policy.prefix.last() {
            names.insert(name);
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::{classify, executable_name, read_only_command_names, split_argv, CommandClass};

    fn class_of(command: &str) -> CommandClass {
        classify(command)
    }

    #[test]
    fn allows_build_test_and_inspection_commands() {
        for command in [
            "npm test",
            "cargo build --release",
            "git status",
            "python -m pytest",
            "ls -la",
            "rg TODO src",
        ] {
            assert_eq!(class_of(command).denial(), None, "应当允许：{command}");
        }
    }

    #[test]
    fn classifies_provably_read_only_commands() {
        for command in [
            "git status",
            "git status --short",
            "git log --oneline -8",
            "git diff --stat",
            "git show HEAD",
            "git branch --list",
            "git ls-files -s",
            "git rev-parse --show-toplevel",
            "git remote -v",
            "ls -la",
            "cat README.md",
            "head -n 20 README.md",
            "wc -l src/index.ts",
            "grep -rn TODO src",
            "rg --json pattern",
            "find . -name '*.ts' -maxdepth 3",
            "tree -L 2",
            "which npm",
            "whoami",
            "pwd",
            "node --version",
        ] {
            assert_eq!(
                class_of(command),
                CommandClass::ReadOnly,
                "应当判为只读：{command}"
            );
        }
    }

    #[test]
    fn write_options_are_not_read_only() {
        for command in [
            "find . -delete",
            "find . -exec echo {} +",
            "find . -fprint out.txt",
            "tree -o out.txt",
            "tree --output=out.txt",
        ] {
            assert!(!class_of(command).is_read_only(), "不应判为只读：{command}");
        }
    }

    #[test]
    fn write_options_require_confirmation() {
        for command in [
            "find . -delete",
            "find . -exec echo {} +",
            "tree -o out.txt",
        ] {
            assert_eq!(
                class_of(command),
                CommandClass::StateChanging,
                "写入动作需要确认：{command}"
            );
        }
    }

    #[test]
    fn rejects_executables_outside_the_allowlist() {
        for command in [
            "curl https://example.com",
            "powershell Get-Process",
            "bash script.sh",
            "tccutil reset",
        ] {
            assert_eq!(
                class_of(command).denial(),
                Some("terminal-command-not-allowed"),
                "应当拒绝：{command}"
            );
        }
    }

    #[test]
    fn destructive_patterns_are_denied_even_under_an_allowed_executable() {
        for command in [
            "git status && rm -rf /",
            "npm run build | sh",
            "echo hi; format C:",
            "git push --force",
        ] {
            assert_eq!(
                class_of(command).denial(),
                Some("terminal-command-denied"),
                "应当硬拒绝：{command}"
            );
        }
    }

    #[test]
    fn command_chaining_and_redirection_are_denied() {
        for command in [
            "npm test && npm run build",
            "cat a > b.txt",
            "ls $(whoami)",
            "echo `id`",
            "npm test | head",
            "cat < secret.txt",
        ] {
            assert_eq!(
                class_of(command).denial(),
                Some("terminal-command-chaining-denied"),
                "应当拒绝拼接：{command}"
            );
        }
    }

    #[test]
    fn split_argv_respects_quotes_and_rejects_unterminated() {
        assert_eq!(
            split_argv("npm test \"a b\" c"),
            Some(vec![
                "npm".to_owned(),
                "test".to_owned(),
                "a b".to_owned(),
                "c".to_owned()
            ])
        );
        assert_eq!(split_argv("git commit -m \"unterminated"), None);
        assert_eq!(split_argv("   "), None);
    }

    #[test]
    fn paths_and_quotes_cannot_walk_around_the_allowlist() {
        assert_eq!(
            executable_name(&split_argv("C:\\Windows\\System32\\format").expect("argv")),
            None
        );
        assert_eq!(
            executable_name(&split_argv("/bin/rm -rf /").expect("argv")),
            None
        );
        assert_eq!(
            executable_name(&split_argv("\"npm\" test").expect("argv")),
            Some("npm".to_owned())
        );
        assert_eq!(
            class_of("/usr/bin/npm test").denial(),
            Some("terminal-command-not-allowed")
        );
        assert_eq!(
            class_of("/bin/rm -rf /").denial(),
            Some("terminal-command-denied")
        );
    }

    #[test]
    fn state_changing_but_legitimate_commands_still_need_confirmation() {
        assert!(!class_of("npm test").requires_confirmation());
        assert!(class_of("git push origin main").requires_confirmation());
        assert!(class_of("npm publish").requires_confirmation());
        assert!(class_of("cargo publish").requires_confirmation());
        assert!(class_of("git reset --hard HEAD~1").requires_confirmation());
        assert!(class_of("git clean -fd").requires_confirmation());
        assert_eq!(
            class_of("git push --force").denial(),
            Some("terminal-command-denied")
        );
    }

    #[test]
    fn subcommand_matching_is_token_aware_not_substring() {
        // 移植前的子串匹配会把 `npm run clean` 误判成 `git clean`。
        assert!(!class_of("npm run clean").requires_confirmation());
        // `npm run <script>` 跑的是本地脚本，不等于发布本身。
        assert!(!class_of("npm run publish").requires_confirmation());
        // 真正的发布子命令仍然需要确认。
        assert!(class_of("npm publish").requires_confirmation());
        assert!(class_of("yarn publish").requires_confirmation());
        assert!(class_of("pnpm publish --access public").requires_confirmation());
    }

    #[test]
    fn dangerous_git_global_options_are_not_read_only() {
        for command in [
            "git -c core.pager=cat status",
            "git --git-dir=/tmp/other status",
            "git --work-tree=/tmp status",
        ] {
            assert!(
                !class_of(command).is_read_only(),
                "危险 git 全局选项不应判为只读：{command}"
            );
        }
    }

    #[test]
    fn git_list_like_commands_need_explicit_list_flag() {
        // 没有 `--list` / `-l` 的 `git branch <name>` 会创建分支。
        assert!(!class_of("git branch new-feature").is_read_only());
        assert!(class_of("git branch --list").is_read_only());
        // `git tag v1.0.0` 会打标签。
        assert!(!class_of("git tag v1.0.0").is_read_only());
        assert!(class_of("git tag -l").is_read_only());
    }

    #[test]
    fn unknown_flags_fall_back_to_not_read_only() {
        assert!(!class_of("git status --totally-unknown").is_read_only());
        assert!(!class_of("grep --totally-unknown x").is_read_only());
        // 未知标志仍然允许执行，只是不再享受「只读免确认」。
        assert_eq!(class_of("grep --totally-unknown x"), CommandClass::Routine);
    }

    #[test]
    fn exposes_read_only_command_names() {
        let names = read_only_command_names();
        assert!(names.contains("ls"));
        assert!(names.contains("status"));
        assert!(names.contains("pwd"));
    }
}
