use std::{env, process::Command};

fn source_revision() -> String {
    env::var("AI_WORK_OS_SOURCE_REVISION")
        .ok()
        .filter(|value| value.len() <= 80 && value.chars().all(|character| character.is_ascii_hexdigit()))
        .or_else(|| Command::new("git").args(["rev-parse", "HEAD"]).output().ok().and_then(|output| output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())).filter(|value| value.len() == 40 && value.chars().all(|character| character.is_ascii_hexdigit())))
        .unwrap_or_else(|| "unavailable".to_owned())
}

fn main() {
    println!("cargo:rerun-if-env-changed=AI_WORK_OS_SOURCE_REVISION");
    println!("cargo:rustc-env=AI_WORK_OS_SOURCE_REVISION={}", source_revision());
    tauri_build::build()
}
