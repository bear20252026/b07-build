//! 跨语言一致性：Rust 侧的 13 个浏览器工具名必须与 TypeScript 侧的
//! `BROWSER_TOOL_NAMES` 完全一致。
//!
//! ## 为什么这是一个集成测试而不是单元测试
//!
//! `tool_map.rs` 里的 `TOOL_SUFFIXES` 与 `browser-tool-surface.ts` 里的
//! `BROWSER_TOOL_NAMES` 是**同一份工具清单的两份表达**——Rust 不能 import
//! TypeScript，所以只能各写一份。这类"两份表达"的东西最常见的退化方式是：
//! 有人在 TS 侧加了第 14 个工具，Rust 侧没跟，于是那个工具在真实后端下永远
//! 返回 `UnknownTool`——**一个只在新工具被调用时才出现的静默失败**。
//!
//! 因此本测试**真的去读那个 TS 文件**并逐名比对，而不是在 Rust 里再抄一份
//! 字面量然后自比（那样抄错也会一起错，守卫等于没有）。
//!
//! 读文件路径用 `CARGO_MANIFEST_DIR` 上溯两级到仓库根，避免依赖运行时的
//! 工作目录——`cargo test` 的工作目录是 crate 根，但别的调用方式未必。

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

/// 仓库根：`<root>/crates/cdp-client` 上溯两级。
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|path| path.parent())
        .expect("crates/cdp-client 应当位于仓库根的 crates/ 下")
        .to_path_buf()
}

/// 从 TS 工具面源码里抽出全部 `mcpToolName(BROWSER_TOOL_SERVER_ID, '<suffix>')`。
///
/// 用字符串扫描而不是引入正则依赖：本 crate 刻意只依赖 serde，多一个依赖就多一份
/// 供应链面。而这里需要的模式是固定的字面前缀 + 引号包围的标识符，字符串切分足够，
/// 且切不出来时**显式失败**而不是静默返回空集（返回空集会与"两边都为空"混淆）。
fn extract_ts_tool_suffixes(source: &str) -> Vec<String> {
    const NEEDLE: &str = "mcpToolName(BROWSER_TOOL_SERVER_ID, '";
    let mut found = Vec::new();
    let mut cursor = 0usize;
    while let Some(offset) = source[cursor..].find(NEEDLE) {
        let start = cursor + offset + NEEDLE.len();
        let Some(end_offset) = source[start..].find('\'') else {
            break;
        };
        found.push(source[start..start + end_offset].to_string());
        cursor = start + end_offset;
    }
    found
}

#[test]
fn rust侧工具名与typescript侧工具面完全一致() {
    let surface_path = repo_root()
        .join("packages")
        .join("capability-placeholder")
        .join("src")
        .join("browser-tool-surface.ts");
    let source = fs::read_to_string(&surface_path).unwrap_or_else(|error| {
        panic!(
            "无法读取工具面契约 {}：{error}。若该文件已移动，本测试必须同步更新——\
             否则一致性守卫会变成永真测试",
            surface_path.display()
        )
    });

    let ts_suffixes = extract_ts_tool_suffixes(&source);
    assert!(
        !ts_suffixes.is_empty(),
        "从 {surface_path:?} 里没抽到任何工具名——\
         说明 extraction 的锚点已与源码格式脱节，必须在视为通过之前修好",
    );

    let ts_set: BTreeSet<&String> = ts_suffixes.iter().collect();
    let rust_set: BTreeSet<&str> = cdp_client::tool_map::TOOL_SUFFIXES
        .iter()
        .copied()
        .collect();

    let only_in_ts: Vec<_> = ts_set
        .iter()
        .filter(|suffix| !rust_set.contains(suffix.as_str()))
        .collect();
    let only_in_rust: Vec<_> = rust_set
        .iter()
        .filter(|suffix| !ts_set.contains(&suffix.to_string()))
        .collect();

    assert!(
        only_in_ts.is_empty(),
        "TypeScript 工具面有而 Rust 侧缺失的工具（这些工具在真实后端下会返回 UnknownTool）：{only_in_ts:?}",
    );
    assert!(
        only_in_rust.is_empty(),
        "Rust 侧有而 TypeScript 工具面没有的工具（这些映射永远不会被调用）：{only_in_rust:?}",
    );
    assert_eq!(
        ts_set.len(),
        13,
        "工具面数量已变化（现为 {}）：新增或删除工具时必须同时改 Rust 侧映射与 THIRD-PARTY-NOTICES 的工具面描述",
        ts_set.len()
    );
}

#[test]
fn 每个typescript侧工具名都能在rust侧映射() {
    let surface_path = repo_root()
        .join("packages")
        .join("capability-placeholder")
        .join("src")
        .join("browser-tool-surface.ts");
    let source = fs::read_to_string(&surface_path).expect("工具面契约应当可读");

    for suffix in extract_ts_tool_suffixes(&source) {
        let canonical = format!("mcp__browser__{suffix}");
        assert!(
            cdp_client::tool_map::is_browser_tool(&canonical),
            "{canonical} 在 TS 工具面里已登记，但 Rust 侧不认它——\
             真实后端会把一个合法工具判为未登记",
        );
    }
}
