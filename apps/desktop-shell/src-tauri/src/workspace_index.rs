//! 工作区文件索引：把“项目里有什么”变成模型可以检索的**路径引用**。
//!
//! 这是整套 Agent 能力的上下文地基。它刻意只存路径与元信息，**不存任何文件内容**——
//! 模型拿到路径清单后，需要某份内容时再按需 `workspace_read_file`。
//! 反过来（把文件内容整份塞进上下文再截断）会同时犯两个错：
//! 预算被少数几个文件吃满，而且被截断的部分模型并不知道丢了什么。
//!
//! 三条从 ZCode 学到的经验（对照 zai-org/ZCode v3.15.1 packages/services/src/file/）：
//!
//!   1. **排除规则的单一真相源是用户的规则文件，不是内置黑名单。**
//!      `.novaignore`（没有则退到 `.gitignore`）一旦加载成功，内置目录黑名单就退役。
//!      用户把 `node_modules/` 从规则文件里删掉，它就该重新被搜到——
//!      内置列表强行求并集会让人改了配置却看不到效果。
//!      规则文件完全不可用（不存在 / 读不了 / 一条有效规则都没有）才 fail-open 回退黑名单。
//!
//!   2. **隐藏目录不能整棵剪枝。**
//!      `.github/workflows/ci.yml`、`.config/x.toml` 都是项目里的有效文件。
//!      整棵剪掉会让名称搜索漏掉它们。做法是：隐藏目录自身不进候选列表，但**保留遍历**，
//!      让它下面的普通文件照常进索引。
//!
//!   3. **搜索在原生侧打分，不把整份索引搬到前端。**
//!      ZCode 把 packed 索引搬到 Host 再分批解码，是因为它的索引要跨进程共享；
//!      这里索引本来就活在原生内存里，直接在这儿排 top-K，IPC 只回几十条命中。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::WorkspaceDirectoryState;

/// 索引最多收录多少条目。超过就停止遍历并置 `truncated`——
/// 宁可让模型知道“索引不全”，也不要在内存里堆几十万条路径。
pub const MAX_INDEX_ENTRIES: usize = 20_000;
/// 遍历深度上限，挡住符号链接环与病态深层目录。
pub const MAX_SCAN_DEPTH: usize = 24;
/// 一次搜索默认/最多返回多少条命中。
pub const DEFAULT_SEARCH_LIMIT: usize = 20;
pub const MAX_SEARCH_LIMIT: usize = 100;

/// 项目地图的默认预算：注入上下文的只是路径骨架，必须小到不挤占对话本身。
pub const DEFAULT_MAP_LINES: usize = 220;
pub const MAX_MAP_LINES: usize = 400;
pub const DEFAULT_MAP_CHARS: usize = 8_000;
pub const MAX_MAP_CHARS: usize = 16_000;
/// 每个目录在地图里最多列出几个文件；超出的只报数量。
const MAP_FILES_PER_DIRECTORY: usize = 6;

const NOVAIGNORE_FILE: &str = ".novaignore";
const GITIGNORE_FILE: &str = ".gitignore";

/// 版本控制元数据目录：无论规则文件怎么写都排除。
///
/// 它们不是项目内容，而且 `.git/objects` 动辄几万个无后缀文件，进索引只会挤掉真正的源码。
/// 这是内置黑名单里唯一不与“规则文件是真相源”冲突的一类——
/// 排除的是**仓库元数据**，不是用户对“哪些源码算数”的判断。
const VCS_DIRECTORIES: &[&str] = &[".git", ".svn", ".hg"];

/// 内置目录黑名单：只在规则文件不可用（fail-open）时兜底。
const BUILTIN_SKIPPED_DIRECTORIES: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "bower_components",
    "jspm_packages",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".output",
    ".turbo",
    ".cache",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".gradle",
    ".idea",
    ".vscode",
    ".venv",
    "venv",
    "__pycache__",
    "site-packages",
    "coverage",
    "htmlcov",
    "playwright-report",
    "test-results",
    "cdk.out",
];

/// 索引里不收录的二进制/产物后缀：它们的路径对读代码没有价值，列出来只会挤占预算。
/// 注意这只影响**索引**，`workspace_list_files` 仍然如实列出目录内容。
const INDEX_SKIPPED_EXTENSIONS: &[&str] = &[
    "a", "aar", "beam", "bin", "bmp", "class", "dll", "dylib", "ear", "exe", "gem", "gif", "gz",
    "ico", "iso", "jar", "jpeg", "jpg", "lib", "mp3", "mp4", "node", "nupkg", "o", "obj", "pdb",
    "pdf", "png", "pyc", "pyo", "rlib", "so", "svg", "tar", "tiff", "ttf", "wasm", "war", "webm",
    "webp", "woff", "woff2", "zip",
];

// ---------------------------------------------------------------------------
// 忽略规则：gitignore 语法的一个最小子集
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum IgnoreRuleKind {
    Exclude,
    /// `!` 取反：重新纳入。gitignore 语义里后面的规则覆盖前面的。
    Include,
}

#[derive(Debug)]
struct IgnoreRule {
    kind: IgnoreRuleKind,
    /// `dir/` 形式只作用于目录。
    directory_only: bool,
    /// 含内部 `/` 或以 `/` 开头的模式锚定到工作区根；否则匹配任意层级。
    anchored: bool,
    segments: Vec<String>,
}

/// 一段路径分量的通配匹配：只支持 `*` 与 `?`，都不跨越 `/`（分量本来就不含 `/）。
fn segment_matches(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    let mut row: Vec<bool> = vec![false; value.len() + 1];
    row[0] = true;
    for index in 0..pattern.len() {
        let mut next = vec![false; value.len() + 1];
        match pattern[index] {
            '*' => {
                let mut matched = false;
                for column in 0..=value.len() {
                    matched = matched || row[column];
                    next[column] = matched;
                }
            }
            character => {
                for column in 1..=value.len() {
                    let hit = character == '?' || character == value[column - 1];
                    next[column] = row[column - 1] && hit;
                }
            }
        }
        row = next;
    }
    row[value.len()]
}

/// 规则分量与路径分量的匹配；`**` 吃掉 0 个或多个分量。
/// 规则被吃完即视为命中：这样 `docs/` 会连整棵子树一起排除，符合 gitignore 语义。
fn match_segments(rule: &[String], path: &[String], rule_index: usize, path_index: usize) -> bool {
    if rule_index >= rule.len() {
        return true;
    }
    if rule[rule_index] == "**" {
        if match_segments(rule, path, rule_index + 1, path_index) {
            return true;
        }
        return path_index < path.len() && match_segments(rule, path, rule_index, path_index + 1);
    }
    if path_index >= path.len() {
        return false;
    }
    if !segment_matches(&rule[rule_index], &path[path_index]) {
        return false;
    }
    match_segments(rule, path, rule_index + 1, path_index + 1)
}

/// 把一行规则文本编译成规则；空行、注释与无法解析的行返回 None（不静默当作通配符）。
fn compile_rule(line: &str) -> Option<IgnoreRule> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (body, kind) = match trimmed.strip_prefix('!') {
        Some(rest) if !rest.trim().is_empty() => (rest.trim(), IgnoreRuleKind::Include),
        Some(_) => return None,
        None => (trimmed, IgnoreRuleKind::Exclude),
    };
    let body = body.trim_end();
    let directory_only = body.ends_with('/');
    let body = body.trim_end_matches('/');
    if body.is_empty() {
        return None;
    }
    let anchored = body.starts_with('/') || body.contains('/');
    let segments = body
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return None;
    }
    Some(IgnoreRule { kind, directory_only, anchored, segments })
}

#[derive(Debug, Default)]
pub struct IgnoreRules {
    rules: Vec<IgnoreRule>,
}

impl IgnoreRules {
    /// 读不到任何规则文件、或文件里没有一条有效规则时返回 None，由调用方 fail-open 到内置黑名单。
    pub fn load(root: &Path) -> Option<IgnoreRules> {
        // 优先级：.novaignore > .gitignore。用户的显式意图永远压过版本控制约定。
        for name in [NOVAIGNORE_FILE, GITIGNORE_FILE] {
            let Ok(text) = fs::read_to_string(root.join(name)) else {
                continue;
            };
            let rules: Vec<IgnoreRule> = text.lines().filter_map(compile_rule).collect();
            if !rules.is_empty() {
                return Some(IgnoreRules { rules });
            }
        }
        None
    }

    /// 返回 true 表示“应当被排除”。后面的规则覆盖前面的，所以倒着找第一条命中的。
    pub fn excludes(&self, segments: &[String], is_directory: bool) -> bool {
        for rule in self.rules.iter().rev() {
            if rule.directory_only && !is_directory {
                continue;
            }
            let hit = if rule.anchored {
                match_segments(&rule.segments, segments, 0, 0)
            } else {
                (0..segments.len()).any(|start| match_segments(&rule.segments, segments, 0, start))
            };
            if hit {
                return rule.kind == IgnoreRuleKind::Exclude;
            }
        }
        false
    }
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct IndexEntry {
    /// 相对工作区根、`/` 分隔的路径。模型侧的引用形态，与平台无关。
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub byte_size: u64,
    pub depth: usize,
}

#[derive(Clone, Debug)]
pub struct WorkspaceIndex {
    pub root: PathBuf,
    pub entries: Vec<IndexEntry>,
    /// 条目达到 MAX_INDEX_ENTRIES 而停止遍历。
    pub truncated: bool,
    /// 排除规则来自用户的规则文件（true）还是内置黑名单（false）。
    pub ignore_rules_active: bool,
    pub built_at_ms: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn extension_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

fn builtin_skips_directory(name: &str) -> bool {
    BUILTIN_SKIPPED_DIRECTORIES
        .iter()
        .any(|skipped| skipped.eq_ignore_ascii_case(name))
}

fn is_vcs_directory(name: &str) -> bool {
    VCS_DIRECTORIES
        .iter()
        .any(|skipped| skipped.eq_ignore_ascii_case(name))
}

/// 祖先目录里有隐藏目录吗？只看除最后一段之外的部分。
fn inside_hidden_directory(display_path: &str) -> bool {
    display_path
        .rsplit_once('/')
        .map(|(ancestors, _)| ancestors)
        .unwrap_or("")
        .split('/')
        .any(|segment| segment.starts_with('.'))
}

/// 秘密文件一律不进索引：它们既不该被读进上下文，也不该在搜索结果里出现。
fn is_secret_file(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    lowered == ".env" || lowered.starts_with(".env.") || lowered == ".ds_store"
}

/// 遍历工作区生成索引。`ignore_rules` 为 None 时走内置黑名单（fail-open）。
///
/// 栈里同时带两份路径：真实大小写的 `display`（模型拿去读取用）与全小写的
/// `matcher`（只用于忽略规则匹配）。规则匹配必须大小写不敏感，但模型拿到的
/// 路径必须保留真实大小写，否则在大小写敏感的文件系统上会打不开文件。
pub fn build_index(root: &Path, ignore_rules: Option<&IgnoreRules>) -> WorkspaceIndex {
    let mut entries: Vec<IndexEntry> = Vec::new();
    let mut truncated = false;
    // 用显式栈而不是递归：深度上限是 MAX_SCAN_DEPTH，递归有栈溢出与符号链接环的风险。
    let mut stack: Vec<(PathBuf, String, Vec<String>, usize)> = Vec::new();
    stack.push((root.to_path_buf(), String::new(), Vec::new(), 0));
    while let Some((directory, parent_display, parent_matcher, depth)) = stack.pop() {
        if depth > MAX_SCAN_DEPTH {
            continue;
        }
        let Ok(read) = fs::read_dir(&directory) else {
            continue;
        };
        let mut children: Vec<_> = read
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                // DirEntry::file_type() 不穿透符号链接（SEC-002）：目录符号链接
                // 在这里现出原形并直接丢弃，跟随它就可能索引到工作区之外。
                let file_type = entry.file_type().ok()?;
                if file_type.is_symlink() {
                    return None;
                }
                // DirEntry::metadata() 等价于 symlink_metadata，不跟随链接。
                let metadata = entry.metadata().ok()?;
                Some((entry.path(), name, file_type.is_dir(), metadata.len()))
            })
            .collect();
        // 同名排序，保证索引与地图输出稳定可复现。
        children.sort_by(|left, right| left.1.cmp(&right.1));
        for (path, name, is_directory, byte_size) in children {
            let mut matcher = parent_matcher.clone();
            matcher.push(name.to_ascii_lowercase());
            let excluded = match ignore_rules {
                Some(rules) => rules.excludes(&matcher, is_directory),
                None => is_directory && builtin_skips_directory(&name),
            };
            if excluded {
                continue;
            }
            if entries.len() >= MAX_INDEX_ENTRIES {
                truncated = true;
                break;
            }
            let display = if parent_display.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", parent_display, &name)
            };
            if is_directory {
                if is_vcs_directory(&name) {
                    continue;
                }
                // 隐藏目录（以及隐藏目录下的目录）自身不进索引，但**照样入栈遍历**——
                // 否则 `.github/workflows/ci.yml` 这种项目里的有效文件就永远搜不到。
                if !name.starts_with('.') && !inside_hidden_directory(&display) {
                    entries.push(IndexEntry {
                        path: display.clone(),
                        name: name.clone(),
                        kind: "directory",
                        byte_size,
                        depth,
                    });
                }
                stack.push((path, display, matcher, depth + 1));
                continue;
            }
            // 文件级排除只有三类：秘密文件、二进制/产物后缀、以及 VCS 元数据里的文件。
            // 点文件本身（.eslintrc、.editorconfig）是项目配置，必须留在索引里。
            let binary = INDEX_SKIPPED_EXTENSIONS
                .iter()
                .any(|extension| *extension == extension_of(&name).as_str());
            if !binary && !is_secret_file(&name) {
                entries.push(IndexEntry {
                    path: display,
                    name,
                    kind: "file",
                    byte_size,
                    depth,
                });
            }
        }
        if truncated {
            break;
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    WorkspaceIndex {
        root: root.to_path_buf(),
        entries,
        truncated,
        ignore_rules_active: ignore_rules.is_some(),
        built_at_ms: now_ms(),
    }
}

// ---------------------------------------------------------------------------
// 搜索：在原生侧打分取 top-K
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchHit {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub byte_size: u64,
    pub score: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub query: String,
    pub hits: Vec<WorkspaceSearchHit>,
    /// 参与打分的条目总数，便于前端如实说明“搜了多少、命中多少”。
    pub scanned: usize,
    pub truncated_index: bool,
}

/// 打分：文件名命中远比路径命中重要；完全相等 > 前缀 > 包含 > 顺序子序列。
fn score_entry(entry: &IndexEntry, query: &str) -> u32 {
    let name = entry.name.to_ascii_lowercase();
    let path = entry.path.to_ascii_lowercase();
    if name == query {
        return 1_000;
    }
    if name.starts_with(query) {
        return 800;
    }
    if name.contains(query) {
        return 600;
    }
    if path.ends_with(query) {
        return 500;
    }
    if path.contains(query) {
        return 300;
    }
    // 顺序子序列兜底：让 `atoolloop` 也能找到 agent-tool-loop.ts。
    let mut index = 0usize;
    let mut matched = 0usize;
    for character in query.chars() {
        match name[index..].find(character) {
            Some(offset) => {
                index += offset + 1;
                matched += 1;
            }
            None => return 0,
        }
    }
    if matched == query.len() {
        100
    } else {
        0
    }
}

pub fn search_index(index: &WorkspaceIndex, query: &str, limit: usize) -> WorkspaceSearchResult {
    let normalized = query.trim().to_ascii_lowercase();
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    if normalized.is_empty() {
        return WorkspaceSearchResult {
            query: query.to_string(),
            hits: Vec::new(),
            scanned: 0,
            truncated_index: index.truncated,
        };
    }
    let mut scored: Vec<(u32, &IndexEntry)> = index
        .entries
        .iter()
        .filter_map(|entry| {
            let score = score_entry(entry, &normalized);
            (score > 0).then_some((score, entry))
        })
        .collect();
    // 同分时依次按：路径深度（浅层更像入口）→ 文件名长度（越短说明查询覆盖得越完整）
    // → 字典序（保证结果稳定可复现）。
    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then(left.1.depth.cmp(&right.1.depth))
            .then(left.1.name.len().cmp(&right.1.name.len()))
            .then(left.1.path.cmp(&right.1.path))
    });
    let hits = scored
        .into_iter()
        .take(limit)
        .map(|(score, entry)| WorkspaceSearchHit {
            path: entry.path.clone(),
            name: entry.name.clone(),
            kind: entry.kind,
            byte_size: entry.byte_size,
            score,
        })
        .collect();
    WorkspaceSearchResult {
        query: query.to_string(),
        hits,
        scanned: index.entries.len(),
        truncated_index: index.truncated,
    }
}

// ---------------------------------------------------------------------------
// 项目地图：注入上下文的紧凑路径骨架
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectMap {
    pub text: String,
    pub file_count: usize,
    pub directory_count: usize,
    /// 地图本身被预算截断（还有目录没走到）。
    pub truncated: bool,
    /// 底层索引被 MAX_INDEX_ENTRIES 截断。
    pub truncated_index: bool,
    pub ignore_rules_active: bool,
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{} B", bytes);
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

/// 行/字符双预算。写不下就如实置 truncated，绝不静默丢内容。
struct MapBudget {
    lines: Vec<String>,
    used: usize,
    max_lines: usize,
    max_chars: usize,
    truncated: bool,
}

impl MapBudget {
    fn push(&mut self, line: String) -> bool {
        if self.lines.len() >= self.max_lines || self.used + line.len() + 1 > self.max_chars {
            self.truncated = true;
            return false;
        }
        self.used += line.len() + 1;
        self.lines.push(line);
        true
    }
}

/// 广度优先铺开目录，每个目录最多带 MAP_FILES_PER_DIRECTORY 个文件。
///
/// 纯深度优先会在 `apps/` 里就把预算花光，`packages/` 一行都出不来；
/// 广度优先保证每个顶层分支都能露脸，这才是“地图”。
pub fn project_map(index: &WorkspaceIndex, max_lines: usize, max_chars: usize) -> WorkspaceProjectMap {
    let file_count = index.entries.iter().filter(|entry| entry.kind == "file").count();
    let directory_count = index
        .entries
        .iter()
        .filter(|entry| entry.kind == "directory")
        .count();
    let max_lines = max_lines.clamp(1, MAX_MAP_LINES);
    let max_chars = max_chars.clamp(200, MAX_MAP_CHARS);

    let mut files_by_parent: BTreeMap<&str, Vec<&IndexEntry>> = BTreeMap::new();
    let mut root_files: Vec<&IndexEntry> = Vec::new();
    for entry in &index.entries {
        if entry.kind != "file" {
            continue;
        }
        match entry.path.rsplit_once('/') {
            Some((parent, _)) => files_by_parent.entry(parent).or_default().push(entry),
            None => root_files.push(entry),
        }
    }
    let mut directories: Vec<&IndexEntry> = index
        .entries
        .iter()
        .filter(|entry| entry.kind == "directory")
        .collect();
    // 先按深度再按路径＝广度优先展开顺序。
    directories.sort_by(|left, right| left.depth.cmp(&right.depth).then(left.path.cmp(&right.path)));

    let mut budget = MapBudget { lines: Vec::new(), used: 0, max_lines, max_chars, truncated: false };
    for entry in root_files.iter().take(MAP_FILES_PER_DIRECTORY) {
        let line = format!("file {} ({})", entry.path, format_bytes(entry.byte_size));
        if !budget.push(line) {
            break;
        }
    }
    if root_files.len() > MAP_FILES_PER_DIRECTORY {
        budget.push(format!("… 根目录还有 {} 个文件", root_files.len() - MAP_FILES_PER_DIRECTORY));
    }
    for directory in directories {
        if !budget.push(format!("dir  {}/", directory.path)) {
            break;
        }
        let files = files_by_parent
            .get(directory.path.as_str())
            .map(|entries| entries.as_slice())
            .unwrap_or(&[]);
        for entry in files.iter().take(MAP_FILES_PER_DIRECTORY) {
            let line = format!("file {} ({})", entry.path, format_bytes(entry.byte_size));
            if !budget.push(line) {
                break;
            }
        }
        if files.len() > MAP_FILES_PER_DIRECTORY {
            let rest = files.len() - MAP_FILES_PER_DIRECTORY;
            if !budget.push(format!("… {} 下还有 {} 个文件", directory.path, rest)) {
                break;
            }
        }
    }
    let lines = budget.lines;
    let truncated = budget.truncated;

    let source = if index.ignore_rules_active {
        "排除规则来自工作区的 .novaignore / .gitignore"
    } else {
        "未找到可用的 .novaignore / .gitignore，已回退到内置目录黑名单"
    };
    let header = format!(
        "以下是当前工作区的**项目地图**。它只列出路径与体积，不含任何文件内容——\
需要读某个文件时调用 workspace_read_file，需要按名字找文件时调用 workspace_search_files。\n\
索引：{} 个文件 / {} 个目录。{}\n\
注意：`.git/` 等仓库元数据、`.env` 等秘密文件、二进制文件不进索引；\
隐藏目录自身不列出但其下的普通文件在索引里。地图还有预算上限，\
没有被列出的文件不代表不存在。",
        file_count, directory_count, source
    );
    let mut text = format!("{}\n{}", header, lines.join("\n"));
    if index.truncated {
        text.push_str(&format!(
            "\n（索引已达 {} 条上限，以上只是部分项目；请用 workspace_search_files 定位具体文件。）",
            MAX_INDEX_ENTRIES
        ));
    }
    WorkspaceProjectMap {
        text,
        file_count,
        directory_count,
        truncated,
        truncated_index: index.truncated,
        ignore_rules_active: index.ignore_rules_active,
    }
}

// ---------------------------------------------------------------------------
// 原生状态与命令
// ---------------------------------------------------------------------------

/// 索引缓存。工作区被换掉、或调用方显式 force 时重建。
pub struct WorkspaceIndexState(Mutex<Option<WorkspaceIndex>>);

impl WorkspaceIndexState {
    pub fn new() -> Self {
        WorkspaceIndexState(Mutex::new(None))
    }
}

impl Default for WorkspaceIndexState {
    fn default() -> Self {
        Self::new()
    }
}

/// 取当前工作区的索引；`force` 为 true 时无条件重建。
fn cached_index(
    state: &State<'_, WorkspaceIndexState>,
    root: &Path,
    force: bool,
) -> Result<WorkspaceIndex, &'static str> {
    let mut guard = state.0.lock().map_err(|_| "workspace-index-unavailable")?;
    if !force {
        if let Some(existing) = guard.as_ref() {
            if existing.root == root {
                return Ok(existing.clone());
            }
        }
    }
    let ignore_rules = IgnoreRules::load(root);
    let index = build_index(root, ignore_rules.as_ref());
    *guard = Some(index.clone());
    Ok(index)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexSnapshot {
    pub root_label: String,
    pub file_count: usize,
    pub directory_count: usize,
    pub entry_count: usize,
    pub truncated: bool,
    pub ignore_rules_active: bool,
    pub built_at_ms: i64,
    /// true 表示直接命中缓存，没有重新扫描磁盘。
    pub reused_cache: bool,
    pub duration_ms: u64,
}

/// 建立（或复用）工作区索引。返回的是概览，不是条目本身——
/// 条目留在原生内存里，前端按需搜索，避免为了看一眼就把几万条路径搬到 WebView。
#[tauri::command]
pub fn workspace_build_index(
    directory: State<'_, WorkspaceDirectoryState>,
    state: State<'_, WorkspaceIndexState>,
    force: Option<bool>,
) -> Result<WorkspaceIndexSnapshot, &'static str> {
    let root = directory
        .0
        .lock()
        .map_err(|_| "workspace-root-unavailable")?
        .clone()
        .ok_or("workspace-root-not-selected")?;
    let force = force.unwrap_or(false);
    let reused_cache = !force
        && state
            .0
            .lock()
            .map(|guard| guard.as_ref().map(|index| index.root == root).unwrap_or(false))
            .unwrap_or(false);
    let started = std::time::Instant::now();
    let index = cached_index(&state, &root, force)?;
    Ok(WorkspaceIndexSnapshot {
        root_label: root.to_string_lossy().to_string(),
        file_count: index.entries.iter().filter(|entry| entry.kind == "file").count(),
        directory_count: index.entries.iter().filter(|entry| entry.kind == "directory").count(),
        entry_count: index.entries.len(),
        truncated: index.truncated,
        ignore_rules_active: index.ignore_rules_active,
        built_at_ms: index.built_at_ms,
        reused_cache,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 按名称或路径片段搜索工作区文件，返回打分后的 top-K。
#[tauri::command]
pub fn workspace_search_files(
    directory: State<'_, WorkspaceDirectoryState>,
    state: State<'_, WorkspaceIndexState>,
    query: String,
    limit: Option<usize>,
) -> Result<WorkspaceSearchResult, &'static str> {
    let root = directory
        .0
        .lock()
        .map_err(|_| "workspace-root-unavailable")?
        .clone()
        .ok_or("workspace-root-not-selected")?;
    let index = cached_index(&state, &root, false)?;
    Ok(search_index(&index, &query, limit.unwrap_or(DEFAULT_SEARCH_LIMIT)))
}

/// 生成注入上下文用的紧凑项目地图。
#[tauri::command]
pub fn workspace_project_map(
    directory: State<'_, WorkspaceDirectoryState>,
    state: State<'_, WorkspaceIndexState>,
    max_lines: Option<usize>,
    max_chars: Option<usize>,
) -> Result<WorkspaceProjectMap, &'static str> {
    let root = directory
        .0
        .lock()
        .map_err(|_| "workspace-root-unavailable")?
        .clone()
        .ok_or("workspace-root-not-selected")?;
    let index = cached_index(&state, &root, false)?;
    Ok(project_map(
        &index,
        max_lines.unwrap_or(DEFAULT_MAP_LINES),
        max_chars.unwrap_or(DEFAULT_MAP_CHARS),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("awo-index-{}-{}-{}", tag, std::process::id(), now_ms()));
        let _ = fs::create_dir_all(&root);
        root
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let target = root.join(relative);
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(target, content);
    }

    #[test]
    fn segment_glob_matches_literals_wildcards_and_questions() {
        assert!(segment_matches("*.rs", "lib.rs"));
        assert!(segment_matches("lib.?s", "lib.rs"));
        assert!(!segment_matches("*.ts", "lib.rs"));
        assert!(segment_matches("*", "anything"));
    }

    #[test]
    fn compiles_gitignore_subset() {
        let rule = compile_rule("dist/").expect("rule");
        assert!(rule.directory_only);
        assert!(!rule.anchored);
        let anchored = compile_rule("/build").expect("rule");
        assert!(anchored.anchored);
        let negated = compile_rule("!keep.rs").expect("rule");
        assert_eq!(negated.kind, IgnoreRuleKind::Include);
        assert!(compile_rule("").is_none());
        assert!(compile_rule("# comment").is_none());
        // 单独的 "!" 不是规则，不能退化成“排除一切”。
        assert!(compile_rule("!").is_none());
    }

    #[test]
    fn rule_matches_any_level_and_anchored_forms() {
        let rules = IgnoreRules { rules: vec![compile_rule("node_modules").expect("rule")] };
        assert!(rules.excludes(&["node_modules".to_string()], true));
        assert!(rules.excludes(&["apps".to_string(), "node_modules".to_string()], true));
        assert!(!rules.excludes(&["src".to_string()], true));

        let anchored = IgnoreRules { rules: vec![compile_rule("/dist").expect("rule")] };
        assert!(anchored.excludes(&["dist".to_string()], true));
        assert!(!anchored.excludes(&["apps".to_string(), "dist".to_string()], true));

        let glob = IgnoreRules { rules: vec![compile_rule("*.log").expect("rule")] };
        assert!(glob.excludes(&["run".to_string(), "debug.log".to_string()], false));
        assert!(!glob.excludes(&["debug.logx".to_string()], false));

        let deep = IgnoreRules { rules: vec![compile_rule("docs/**").expect("rule")] };
        let segments: Vec<String> = ["docs", "a", "b.md"].iter().map(|value| value.to_string()).collect();
        assert!(deep.excludes(&segments, false));
    }

    #[test]
    fn later_rule_overrides_earlier_one() {
        let rules = IgnoreRules {
            rules: vec![
                compile_rule("*.log").expect("rule"),
                compile_rule("!keep.log").expect("rule"),
            ],
        };
        assert!(rules.excludes(&["debug.log".to_string()], false));
        assert!(!rules.excludes(&["keep.log".to_string()], false));
    }

    #[test]
    fn ignore_file_becomes_the_single_source_of_truth() {
        let root = temp_root("rules");
        write(&root, ".novaignore", "node_modules\n# comment\n");
        write(&root, "src/main.rs", "fn main() {}");
        write(&root, "node_modules/dep/index.js", "module.exports = 1;");
        let rules = IgnoreRules::load(&root).expect("rules should load");
        let index = build_index(&root, Some(&rules));
        assert!(index.ignore_rules_active);
        let paths: Vec<&str> = index.entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(paths.contains(&"src/main.rs"));
        // 内置黑名单退役了，但 .novaignore 自己把 node_modules 排除了——来源变成用户。
        assert!(!paths.iter().any(|path| path.starts_with("node_modules")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn user_can_re_include_a_builtin_directory_by_editing_rules() {
        let root = temp_root("reinclude");
        // 用户显式否定内置黑名单里也有的 dist：规则文件是真相源，dist 应当重新出现。
        write(&root, ".novaignore", "*.tmp\n");
        write(&root, "dist/bundle.js", "console.log(1);");
        write(&root, "src/app.js", "console.log(2);");
        let rules = IgnoreRules::load(&root).expect("rules should load");
        let index = build_index(&root, Some(&rules));
        let paths: Vec<&str> = index.entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(paths.contains(&"dist/bundle.js"), "rules file wins over the builtin list");
        assert!(paths.contains(&"src/app.js"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn falls_back_to_builtin_list_when_no_rules_file() {
        let root = temp_root("fallback");
        write(&root, "src/main.rs", "fn main() {}");
        write(&root, "node_modules/dep/index.js", "x");
        assert!(IgnoreRules::load(&root).is_none());
        let index = build_index(&root, None);
        assert!(!index.ignore_rules_active);
        let paths: Vec<&str> = index.entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(paths.contains(&"src/main.rs"));
        assert!(!paths.iter().any(|path| path.starts_with("node_modules")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_directory_is_traversed_but_not_listed() {
        let root = temp_root("hidden");
        write(&root, ".github/workflows/ci.yml", "name: ci");
        write(&root, ".eslintrc", "{}");
        write(&root, ".env.local", "SECRET=1");
        write(&root, "src/lib.rs", "pub fn a() {}");
        let index = build_index(&root, None);
        let paths: Vec<&str> = index.entries.iter().map(|entry| entry.path.as_str()).collect();
        // 隐藏目录自身不进索引，但它下面的普通文件必须通过遍历被收进来——
        // 整棵剪掉会让 `.github/workflows/ci.yml` 这类有效文件永远搜不到。
        assert!(!paths.contains(&".github"));
        assert!(!paths.contains(&".github/workflows"));
        assert!(paths.contains(&".github/workflows/ci.yml"), "files under hidden dirs must stay searchable");
        // 点文件本身是项目配置，要留在索引里；秘密文件一律不行。
        assert!(paths.contains(&".eslintrc"));
        assert!(!paths.iter().any(|path| path.starts_with(".env")));
        assert!(paths.contains(&"src/lib.rs"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn vcs_metadata_never_enters_the_index_even_when_rules_are_active() {
        let root = temp_root("vcs");
        // .gitignore 通常不会排除 .git 自己，所以这条必须硬编码，不能指望规则文件。
        write(&root, ".git/HEAD", "ref: refs/heads/main");
        write(&root, ".git/objects/ab/cdef", "zlib blob");
        write(&root, ".novaignore", "*.tmp\n");
        write(&root, "src/lib.rs", "pub fn a() {}");
        let rules = IgnoreRules::load(&root).expect("rules should load");
        let index = build_index(&root, Some(&rules));
        let paths: Vec<&str> = index.entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(!paths.iter().any(|path| path.starts_with(".git/")));
        assert!(paths.contains(&"src/lib.rs"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn binary_extensions_stay_out_of_the_index() {
        let root = temp_root("binary");
        write(&root, "assets/logo.png", "not really png");
        write(&root, "src/main.rs", "fn main() {}");
        let index = build_index(&root, None);
        let paths: Vec<&str> = index.entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(!paths.iter().any(|path| path.ends_with(".png")));
        assert!(paths.contains(&"src/main.rs"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn search_ranks_name_matches_above_path_matches() {
        let index = WorkspaceIndex {
            root: PathBuf::from("/tmp/project"),
            entries: vec![
                IndexEntry { path: "src/deep/agent-tool-loop.ts".into(), name: "agent-tool-loop.ts".into(), kind: "file", byte_size: 100, depth: 3 },
                IndexEntry { path: "src/agent.ts".into(), name: "agent.ts".into(), kind: "file", byte_size: 50, depth: 1 },
                IndexEntry { path: "docs/agent-guide.md".into(), name: "agent-guide.md".into(), kind: "file", byte_size: 20, depth: 1 },
            ],
            truncated: false,
            ignore_rules_active: false,
            built_at_ms: 0,
        };
        let result = search_index(&index, "agent", 10);
        // agent.ts 是前缀命中（800），排在最前；agent.ts 与 agent-guide.md 都优于深层子序列命中。
        assert_eq!(result.hits.first().map(|hit| hit.path.as_str()), Some("src/agent.ts"));
        assert_eq!(result.scanned, 3);
        let exact = search_index(&index, "agent.ts", 10);
        assert_eq!(exact.hits.first().map(|hit| hit.score), Some(1_000));
        // 子序列兜底：atoolloop 也要能找到 agent-tool-loop.ts。
        let fuzzy = search_index(&index, "atoolloop", 10);
        assert_eq!(fuzzy.hits.first().map(|hit| hit.path.as_str()), Some("src/deep/agent-tool-loop.ts"));
    }

    #[test]
    fn search_respects_limit_and_empty_query() {
        let entries: Vec<IndexEntry> = (0..50)
            .map(|index| IndexEntry {
                path: format!("src/file{}.ts", index),
                name: format!("file{}.ts", index),
                kind: "file",
                byte_size: 1,
                depth: 1,
            })
            .collect();
        let index = WorkspaceIndex { root: PathBuf::from("/tmp"), entries, truncated: false, ignore_rules_active: false, built_at_ms: 0 };
        assert_eq!(search_index(&index, "file", 7).hits.len(), 7);
        assert!(search_index(&index, "   ", 7).hits.is_empty());
        // 上限被夹住，不能因为参数异常就返回整份索引。
        assert!(search_index(&index, "file", 10_000).hits.len() <= MAX_SEARCH_LIMIT);
    }

    #[test]
    fn project_map_stays_within_budget_and_mentions_omissions() {
        let mut entries: Vec<IndexEntry> = vec![IndexEntry { path: "apps".into(), name: "apps".into(), kind: "directory", byte_size: 0, depth: 0 }];
        entries.push(IndexEntry { path: "packages".into(), name: "packages".into(), kind: "directory", byte_size: 0, depth: 0 });
        for branch in ["apps", "packages"] {
            for index in 0..20 {
                entries.push(IndexEntry {
                    path: format!("{}/file{}.ts", branch, index),
                    name: format!("file{}.ts", index),
                    kind: "file",
                    byte_size: 1_024,
                    depth: 1,
                });
            }
        }
        let index = WorkspaceIndex { root: PathBuf::from("/tmp"), entries, truncated: false, ignore_rules_active: true, built_at_ms: 0 };
        let map = project_map(&index, DEFAULT_MAP_LINES, DEFAULT_MAP_CHARS);
        assert!(map.text.len() <= DEFAULT_MAP_CHARS + 400);
        assert!(map.text.contains("workspace_read_file"));
        // 广度优先：两个顶层分支都要露脸，不能让 apps 吃光预算。
        assert!(map.text.contains("apps/"));
        assert!(map.text.contains("packages/"));
        assert!(map.text.contains("还有"), "被省略的部分必须如实说明");
        assert_eq!(map.file_count, 40);
        assert_eq!(map.directory_count, 2);
    }

    #[test]
    fn project_map_honours_line_budget() {
        let mut entries = vec![IndexEntry { path: "src".into(), name: "src".into(), kind: "directory", byte_size: 0, depth: 0 }];
        for index in 0..100 {
            entries.push(IndexEntry { path: format!("src/f{}.ts", index), name: format!("f{}.ts", index), kind: "file", byte_size: 10, depth: 1 });
        }
        let index = WorkspaceIndex { root: PathBuf::from("/tmp"), entries, truncated: false, ignore_rules_active: false, built_at_ms: 0 };
        let map = project_map(&index, 5, DEFAULT_MAP_CHARS);
        assert!(map.truncated);
        assert!(map.text.lines().count() <= 8);
    }
}
