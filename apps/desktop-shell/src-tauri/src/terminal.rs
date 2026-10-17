use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{sleep, Duration},
};

use process_supervisor::command_policy::{classify, executable_name, split_argv};

use crate::WorkspaceDirectoryState;

type SharedChild = Arc<Mutex<Child>>;
/// 正在运行的子进程。只有真正 spawn 成功后才会出现在这里。
type RunMap = Arc<Mutex<HashMap<String, SharedChild>>>;
/// 已发出过完成事件的 run_id：保证一个 run 恰好一个 done 事件。
type FinishedSet = Arc<Mutex<HashSet<String>>>;

/// 终端运行状态。
///
/// SEC-005：启动要「先原子预留 ID，再 spawn，再放进运行表」，三步不原子时
/// 两个并发请求可能用同一个 ID 各起一个进程。取消与自然退出共用一个
/// 「完成集合」去重，保证完成事件只发布一次。
pub struct TerminalRunState {
    runs: RunMap,
    reserved: FinishedSet,
    finished: FinishedSet,
}

impl TerminalRunState {
    pub fn new() -> Self {
        Self {
            runs: Arc::new(Mutex::new(HashMap::new())),
            reserved: Arc::new(Mutex::new(HashSet::new())),
            finished: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

/// 把预留的 run_id **原子地**转为"运行中"。
///
/// ## 为什么必须在一个临界区里做完
///
/// 准入检查在**同一个临界区**内同时看 `runs` 与 `reserved`，这是 SEC-005 的原子预留。
/// 但"预留 → 登记"的**交接**曾经分成两步：先 `reserved.remove()`，再 `runs.insert()`。
/// 两步之间那个 id 在两张表里都不存在，并发请求于是看到"既未预留、也未运行"，
/// 放行第二个进程 —— 原子准入在交接处被抵消，闭环没合上。
///
/// 加锁顺序与准入检查一致（先 `runs` 后 `reserved`），避免两条路径互相死锁。
///
/// 返回是否登记成功。预留不在（例如已被取消路径释放）时**不登记**：那种情况下
/// 这个进程已经不该被接管，调用方应据此失败并让 `kill_on_drop` 收尾。
///
/// 对 `V` 泛型化是为了可测：真进程类型在单测里造不出来，而这条判定的原子性
/// 恰恰是本项缺陷的核心，必须有牙齿。
async fn promote_reserved_to_running<V>(
    runs: &Mutex<HashMap<String, V>>,
    reserved: &Mutex<HashSet<String>>,
    run_id: &str,
    value: V,
) -> bool {
    let mut runs = runs.lock().await;
    let mut reserved = reserved.lock().await;
    if !reserved.remove(run_id) {
        return false;
    }
    runs.insert(run_id.to_string(), value);
    true
}

impl Default for TerminalRunState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTerminalCommandRequest {
    pub run_id: String,
    pub command: String,
    pub confirm_dangerous: bool,
    /// 可选：显式指定工作目录。SEC-011：缺省时落到用户选中的工作区根，
    /// 让「在终端里跑构建」默认发生在用户正在看的项目里。
    pub working_directory: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTerminalCommandRequest {
    pub run_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResponse {
    pub run_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    run_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDoneEvent {
    run_id: String,
    exit_code: Option<i32>,
    cancelled: bool,
    error: Option<String>,
}

pub(crate) fn valid_run_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

/// 在 PATH 里解析白名单可执行文件的真实位置。
///
/// SEC-001：命令不再经过 `cmd /C` / `sh -lc`，必须自己找到可执行文件。
/// Windows 上 npm/pnpm/npx/yarn 是 `.cmd` 垫片，CreateProcess 找不到它们，
/// 所以这里把 `.exe` 与 `.cmd`/`.bat` 都搜出来；`.cmd`/`.bat` 由 Rust 标准库
/// 按 BatBadBut 修复后的方式经 cmd.exe 逐参数转义执行，参数不再整串进 shell。
pub(crate) fn resolve_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    std::env::split_paths(&path).find_map(|directory| {
        candidates.iter().find_map(|extension| {
            let candidate = if extension.is_empty() {
                directory.join(name)
            } else {
                directory.join(format!("{name}.{extension}"))
            };
            let is_file = std::fs::metadata(&candidate)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);
            is_file.then_some(candidate)
        })
    })
}

/// argv 化执行：可执行文件 + 逐个参数，没有任何 shell 插值。
fn command_for(resolved: &PathBuf, argv: &[String]) -> Command {
    let mut process = Command::new(resolved);
    process.args(&argv[1..]);
    process
}

/// 计算子进程的工作目录：显式指定则必须落在选中工作区内，否则默认工作区根。
fn working_directory(
    workspace: &State<'_, WorkspaceDirectoryState>,
    requested: Option<&str>,
) -> Result<Option<PathBuf>, &'static str> {
    let root = workspace
        .0
        .lock()
        .map_err(|_| "workspace-root-unavailable")?
        .clone();
    let Some(root) = root else {
        // 未选工作区：没有可锚定的目录，保持与旧版一致（继承应用目录）。
        return Ok(None);
    };
    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            let candidate = std::path::PathBuf::from(value)
                .canonicalize()
                .map_err(|_| "terminal-workdir-invalid")?;
            if !candidate.starts_with(&root) {
                return Err("terminal-workdir-escapes-workspace");
            }
            Ok(Some(candidate))
        }
        None => Ok(Some(root)),
    }
}

async fn relay_lines<R>(app: AppHandle, run_id: String, stream: &'static str, reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => return,
            Ok(_) => {
                let _ = app.emit(
                    "terminal-command-output",
                    TerminalOutputEvent {
                        run_id: run_id.clone(),
                        stream,
                        text: line.clone(),
                    },
                );
            }
            Err(_) => return,
        }
    }
}

/// 发布完成事件；同一 run_id 只会发布一次。取消路径与自然退出路径都走这里，
/// SEC-005 的「完成事件一致性」由这个集合保证，而不是靠各方自觉。
async fn publish_done(
    finished: &FinishedSet,
    app: &AppHandle,
    run_id: &str,
    event: TerminalDoneEvent,
) -> bool {
    let mut finished = finished.lock().await;
    if !finished.insert(run_id.to_owned()) {
        return false;
    }
    drop(finished);
    let _ = app.emit("terminal-command-done", event);
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandAssessment {
    /// `read-only` / `routine` / `state-changing` / `denied`。
    pub class: &'static str,
    /// 是否可证明只读。
    pub read_only: bool,
    /// 是否需要调用方勾选「最后确认」。
    pub requires_confirmation: bool,
    /// 拒绝原因（错误码）；未被拒绝时为 None。
    pub denial: Option<&'static str>,
}

/// 只做判定、不执行：让界面在用户点「运行」之前就能拿到权威结论，
/// 而不是各自维护一份正则去猜哪条命令危险。
#[tauri::command]
pub fn classify_terminal_command(
    request: ClassifyTerminalCommandRequest,
) -> TerminalCommandAssessment {
    let command = request.command.trim();
    if command.is_empty() || command.len() > 16_000 {
        return TerminalCommandAssessment {
            class: "denied",
            read_only: false,
            requires_confirmation: false,
            denial: Some("terminal-command-invalid"),
        };
    }
    let class = classify(command);
    TerminalCommandAssessment {
        class: class.as_str(),
        read_only: class.is_read_only(),
        requires_confirmation: class.requires_confirmation(),
        denial: class.denial(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyTerminalCommandRequest {
    pub command: String,
}

#[tauri::command]
pub async fn start_terminal_command(
    app: AppHandle,
    state: State<'_, TerminalRunState>,
    workspace: State<'_, WorkspaceDirectoryState>,
    request: StartTerminalCommandRequest,
) -> Result<TerminalStartResponse, &'static str> {
    if !valid_run_id(&request.run_id) {
        return Err("terminal-run-id-invalid");
    }
    let command = request.command.trim();
    if command.is_empty() || command.len() > 16_000 {
        return Err("terminal-command-invalid");
    }
    // 白名单准入与只读判定：不在名单上的命令根本不启动进程，
    // 会改状态的命令必须由调用方显式确认。
    let class = classify(command);
    if let Some(denial) = class.denial() {
        return Err(denial);
    }
    if class.requires_confirmation() && !request.confirm_dangerous {
        return Err("terminal-command-confirmation-required");
    }
    let directory = working_directory(&workspace, request.working_directory.as_deref())?;
    // SEC-005：先原子预留 run_id，spawn 失败时释放；并发请求在这里就撞墙。
    {
        let (runs, reserved) = (&state.runs, &state.reserved);
        let runs = runs.lock().await;
        let mut reserved = reserved.lock().await;
        if runs.contains_key(&request.run_id) || reserved.contains(&request.run_id) {
            return Err("terminal-run-already-active");
        }
        reserved.insert(request.run_id.clone());
    }
    let Some(argv) = split_argv(command) else {
        state.reserved.lock().await.remove(&request.run_id);
        return Err("terminal-command-invalid");
    };
    let Some(resolved) = resolve_executable(executable_name(&argv).unwrap_or_default().as_str())
    else {
        state.reserved.lock().await.remove(&request.run_id);
        return Err("terminal-command-not-found");
    };
    let mut process = command_for(&resolved, &argv);
    process
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = directory {
        process.current_dir(directory);
    }
    let spawn_result = process.spawn();
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(_) => {
            state.reserved.lock().await.remove(&request.run_id);
            return Err("terminal-command-spawn-failed");
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or("terminal-command-output-unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("terminal-command-output-unavailable")?;
    let run_id = request.run_id.clone();
    let child = Arc::new(Mutex::new(child));
    // SEC-005 的闭环：预留 → 运行必须在同一个临界区里交接（见 `promote_reserved_to_running`）。
    if !promote_reserved_to_running(&state.runs, &state.reserved, &run_id, child.clone()).await {
        // 预留已被释放（例如取消路径抢先处理）：不接管这个进程。
        // `child` 在此被丢弃，`kill_on_drop(true)` 会把它收掉。
        return Err("terminal-run-reservation-lost");
    }
    tauri::async_runtime::spawn(relay_lines(app.clone(), run_id.clone(), "stdout", stdout));
    tauri::async_runtime::spawn(relay_lines(app.clone(), run_id.clone(), "stderr", stderr));
    let runs = state.runs.clone();
    let finished = state.finished.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let status = {
                let mut process = child.lock().await;
                process.try_wait()
            };
            match status {
                Ok(Some(status)) => {
                    runs.lock().await.remove(&run_id);
                    publish_done(
                        &finished,
                        &app,
                        &run_id,
                        TerminalDoneEvent {
                            run_id: run_id.clone(),
                            exit_code: status.code(),
                            cancelled: false,
                            error: None,
                        },
                    )
                    .await;
                    return;
                }
                Ok(None) => sleep(Duration::from_millis(120)).await,
                Err(_) => {
                    runs.lock().await.remove(&run_id);
                    publish_done(
                        &finished,
                        &app,
                        &run_id,
                        TerminalDoneEvent {
                            run_id: run_id.clone(),
                            exit_code: None,
                            cancelled: false,
                            error: Some("terminal-command-status-failed".to_owned()),
                        },
                    )
                    .await;
                    return;
                }
            }
        }
    });
    Ok(TerminalStartResponse {
        run_id: request.run_id,
    })
}

#[tauri::command]
pub async fn cancel_terminal_command(
    app: AppHandle,
    state: State<'_, TerminalRunState>,
    request: CancelTerminalCommandRequest,
) -> Result<(), &'static str> {
    if !valid_run_id(&request.run_id) {
        return Err("terminal-run-id-invalid");
    }
    let child = state
        .runs
        .lock()
        .await
        .get(&request.run_id)
        .cloned()
        .ok_or("terminal-run-not-found")?;
    child
        .lock()
        .await
        .start_kill()
        .map_err(|_| "terminal-command-cancel-failed")?;
    // 完成事件只发一次：这里的 cancelled done 先占住「完成集合」，
    // 监视循环随后看到的真实退出码会被去重掉。
    publish_done(
        &state.finished,
        &app,
        &request.run_id,
        TerminalDoneEvent {
            run_id: request.run_id.clone(),
            exit_code: None,
            cancelled: true,
            error: None,
        },
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{classify_terminal_command, promote_reserved_to_running, valid_run_id, ClassifyTerminalCommandRequest};
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::sync::Mutex;

    /// 极简 block_on：本 crate 的 tokio 未开 `rt` feature，用不了 `#[tokio::test]`。
    /// 这里的 future 只涉及 `tokio::sync::Mutex`（不需要 reactor），忙轮询足够。
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, Waker};
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut pinned = std::pin::pin!(future);
        loop {
            match pinned.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::hint::spin_loop(),
            }
        }
    }

    #[test]
    fn validates_run_identifiers() {
        assert!(valid_run_id("run-123"));
        assert!(!valid_run_id("bad id"));
    }

    /// 模拟 `start_terminal_command` 里的准入检查：**同时看两张表**，都不含则抢占。
    ///
    /// 加锁顺序与生产代码一致（先 `runs` 后 `reserved`）。
    async fn try_admit(
        runs: &Mutex<HashMap<String, u32>>,
        reserved: &Mutex<HashSet<String>>,
        run_id: &str,
    ) -> bool {
        let runs = runs.lock().await;
        let mut reserved = reserved.lock().await;
        if runs.contains_key(run_id) || reserved.contains(run_id) {
            return false;
        }
        reserved.insert(run_id.to_string());
        true
    }

    #[test]
    fn 交接期间并发准入不得看到空窗() {
        // 本项缺陷的并发复现，**必须让"准入"与"交接"同时发生**。
        //
        // 只让多个线程都做交接是抓不到的：它们都在第一步就 `remove` 失败而返回，
        // 根本不会去看 `runs` —— 窗口确实存在，但没人从那里经过。
        // 缺陷真正的表现形式是**准入方**看到"既未预留、也未运行"于是放行第二个进程。
        //
        // 用栅栏把两条路径凑到同一时刻，并跑多轮，让"偶然没撞上"的概率可忽略。
        const ROUNDS: usize = 300;
        let mut both_admitted = 0;
        for round in 0..ROUNDS {
            let runs = Arc::new(Mutex::new(HashMap::<String, u32>::new()));
            let reserved = Arc::new(Mutex::new(HashSet::<String>::new()));
            block_on(reserved.lock()).insert("run-1".to_string());
            let barrier = Arc::new(std::sync::Barrier::new(2));

            let promoter = {
                let (runs, reserved, barrier) = (Arc::clone(&runs), Arc::clone(&reserved), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    barrier.wait();
                    block_on(promote_reserved_to_running(&runs, &reserved, "run-1", 1))
                })
            };
            let admitter = {
                let (runs, reserved, barrier) = (Arc::clone(&runs), Arc::clone(&reserved), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    barrier.wait();
                    block_on(try_admit(&runs, &reserved, "run-1"))
                })
            };

            let promoted = promoter.join().unwrap();
            let admitted = admitter.join().unwrap();
            if promoted && admitted {
                both_admitted += 1;
                assert!(false, "第 {round} 轮：交接与准入同时成功 = 同一 run_id 起了两个进程");
            }
        }
        assert_eq!(both_admitted, 0);
    }


    #[test]
    fn 预留到运行的交接是原子的() {
        // 本项缺陷的并发复现：交接分两步时，两步之间 id 在两张表里都不存在，
        // 并发请求看到"既未预留、也未运行"，于是各起一个进程。
        //
        // **必须用栅栏把线程凑到同一时刻**：没有栅栏时每个线程往往一口气跑完整个
        // 交接，窗口根本没人经过 —— 那样这条测试对"分两步"的实现也会全绿，
        // 变成一条没有牙齿的测试（注入验证时确实如此，故补上栅栏）。
        const THREADS: usize = 8;
        // 同一轮内只允许一次成功；跑多轮是为了让"偶然没撞上"的概率降到可忽略。
        for round in 0..200 {
            let runs = Arc::new(Mutex::new(HashMap::<String, u32>::new()));
            let reserved = Arc::new(Mutex::new(HashSet::<String>::new()));
            block_on(reserved.lock()).insert("run-1".to_string());
            let barrier = Arc::new(std::sync::Barrier::new(THREADS));

            let mut handles = Vec::new();
            for index in 0..THREADS as u32 {
                let (runs, reserved, barrier) = (Arc::clone(&runs), Arc::clone(&reserved), Arc::clone(&barrier));
                handles.push(std::thread::spawn(move || {
                    barrier.wait();
                    block_on(promote_reserved_to_running(&runs, &reserved, "run-1", index))
                }));
            }
            // join 消耗 handle，故用显式循环而不是 filter（filter 给的是 &handle）。
            let mut succeeded = 0;
            for handle in handles {
                if handle.join().unwrap() {
                    succeeded += 1;
                }
            }

            assert_eq!(succeeded, 1, "第 {round} 轮：同一 run_id 只应成功启动一次");
            assert_eq!(block_on(runs.lock()).len(), 1, "第 {round} 轮：运行表只应有一条");
            assert!(
                !block_on(reserved.lock()).contains("run-1"),
                "第 {round} 轮：交接后不应仍处于预留态"
            );
        }
    }

    #[test]
    fn 交接后id同时只存在于运行表() {
        // 闭环的可观察形态：交接完成后 id 在运行表、不在预留表。
        let runs = Mutex::new(HashMap::<String, u32>::new());
        let reserved = Mutex::new(HashSet::<String>::new());
        block_on(reserved.lock()).insert("run-2".to_string());
        assert!(block_on(promote_reserved_to_running(&runs, &reserved, "run-2", 7)));
        assert!(block_on(runs.lock()).contains_key("run-2"));
        assert!(!block_on(reserved.lock()).contains("run-2"));
    }

    #[test]
    fn 预留不在时不接管进程() {
        // 取消路径可能抢先释放预留。这时不该把进程登记进去，
        // 而应让调用方失败、由 kill_on_drop 收尾。
        let runs = Mutex::new(HashMap::<String, u32>::new());
        let reserved = Mutex::new(HashSet::<String>::new());
        assert!(!block_on(promote_reserved_to_running(&runs, &reserved, "run-3", 1)));
        assert!(block_on(runs.lock()).is_empty(), "未预留的 id 不得进入运行表");
    }

    #[test]
    fn 不同id各自独立交接() {
        let runs = Mutex::new(HashMap::<String, u32>::new());
        let reserved = Mutex::new(HashSet::<String>::new());
        for id in ["a", "b"] {
            block_on(reserved.lock()).insert(id.to_string());
        }
        assert!(block_on(promote_reserved_to_running(&runs, &reserved, "a", 1)));
        assert!(block_on(promote_reserved_to_running(&runs, &reserved, "b", 2)));
        assert_eq!(block_on(runs.lock()).len(), 2);
    }

    #[test]
    fn assessment_surfaces_read_only_and_confirmation_flags() {
        let read_only = classify_terminal_command(ClassifyTerminalCommandRequest {
            command: "git status".to_owned(),
        });
        assert_eq!(read_only.class, "read-only");
        assert!(read_only.read_only);
        assert!(!read_only.requires_confirmation);
        assert_eq!(read_only.denial, None);

        let confirming = classify_terminal_command(ClassifyTerminalCommandRequest {
            command: "git push origin main".to_owned(),
        });
        assert_eq!(confirming.class, "state-changing");
        assert!(!confirming.read_only);
        assert!(confirming.requires_confirmation);

        let denied = classify_terminal_command(ClassifyTerminalCommandRequest {
            command: "curl https://example.com".to_owned(),
        });
        assert_eq!(denied.denial, Some("terminal-command-not-allowed"));
        assert_eq!(denied.class, "denied");
    }

    #[test]
    fn assessment_rejects_empty_and_oversized_commands() {
        for command in ["   ", &"a".repeat(16_001)] {
            let assessment = classify_terminal_command(ClassifyTerminalCommandRequest {
                command: command.to_owned(),
            });
            assert_eq!(assessment.denial, Some("terminal-command-invalid"));
        }
    }
}
