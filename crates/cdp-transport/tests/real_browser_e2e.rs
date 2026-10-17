//! 真实浏览器端到端验证：用**本机的 Chrome/Edge** 驱动完整协议路径。
//!
//! ## 为什么必须有这一层
//!
//! 上一批修了两个协议层缺陷（`sessionId` 位置、动作语义），但当时只有单元测试与
//! 手写假端点覆盖。假端点的问题在于：**它按我们的理解回话**。如果我们的理解错了
//! （把 `sessionId` 放进 `params` 就是这种错），假端点会照样"配合"，测试全绿，
//! 真实浏览器却收不到路由信息。审计正是这么说的：需要"真实协议验证"。
//!
//! 本文件因此连**真的**浏览器：启动 → 读 DevToolsActivePort → 连浏览器级 WebSocket
//! → `Target.getTargets` → `Target.attachToTarget(flatten)` → 用拿到的 sessionId
//! 在**页面**上下文里求值。
//!
//! 最关键的断言是 `真实浏览器上顶层sessionId能路由到已attach的页面`：
//! 若 `sessionId` 被放进 `params`（旧实现），命令会落在浏览器级会话上，
//! `Runtime.evaluate` 会以"方法不存在"失败 —— 而假端点永远抓不到这一点。
//!
//! ## 没有浏览器时怎么办
//!
//! 跳过（并打印醒目提示），因为 CI 未必装了浏览器。但跳过不能是静默的：
//! 设 `B07_E2E_REQUIRE_BROWSER=1` 可要求**必须**找到浏览器，否则测试失败 ——
//! 想让 CI 真正跑这一层时用它。
//!
//! ## 运行建议
//!
//! 每个用例各拉起一个浏览器，并行跑会压满机器（截图在 6 个并行 headless 下会超过 30s）。
//! 机器较忙时用 `cargo test --test real_browser_e2e -- --test-threads=1`。
//!
//! 测试名用中文描述行为（仓库既有风格），故关闭该 lint。
#![allow(non_snake_case)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use cdp_client::frame::CommandOutcome;
use cdp_transport::{CdpConnection, ConnectOptions};
use serde_json::Value;

/// 让本文件的用例**串行**执行。
///
/// 每个用例各拉起一个浏览器，并行跑会压满机器：实测在 6 个并行 headless 下，
/// 截图会超过 30s 超时、导航会出现冷启动 abort。这些都不是协议问题，是环境负载。
///
/// 与其要求调用方记得加 `--test-threads=1`（默认行为就应该是稳的），
/// 不如在文件内保证：所有用例先抢这把锁，拿到才启动浏览器。
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 抢串行锁。被毒化也继续 —— 一个用例 panic 不该让其余用例全挂。
fn serialize() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 找不到浏览器时的统一处理：默认跳过，被要求时必须失败。
fn skip_or_fail(reason: &str) {
    if std::env::var("B07_E2E_REQUIRE_BROWSER").is_ok() {
        panic!("B07_E2E_REQUIRE_BROWSER 已设置，但{reason}");
    }
    eprintln!("⚠️  跳过真实浏览器端到端测试：{reason}");
    eprintln!("   （本机未安装 Chrome/Edge，或用 B07_E2E_BROWSER 指定可执行文件路径）");
}

/// 候选浏览器可执行文件：先看环境变量，再看各平台的常见安装位置。
fn browser_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(explicit) = std::env::var("B07_E2E_BROWSER") {
        candidates.push(PathBuf::from(explicit));
    }
    #[cfg(target_os = "windows")]
    {
        let roots = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ];
        candidates.extend(roots.iter().map(PathBuf::from));
    }
    #[cfg(target_os = "macos")]
    {
        let roots = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
        candidates.extend(roots.iter().map(PathBuf::from));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for name in ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"] {
            if let Ok(path) = which(name) {
                candidates.push(path);
            }
        }
    }
    candidates
}

#[cfg(all(unix, not(target_os = "macos")))]
fn which(name: &str) -> Result<PathBuf, ()> {
    let path = std::env::var("PATH").map_err(|_| ())?;
    for directory in path.split(':') {
        let candidate = Path::new(directory).join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

fn find_browser() -> Option<PathBuf> {
    browser_candidates().into_iter().find(|path| path.is_file())
}

/// 一个被拉起的浏览器进程；Drop 时杀掉并清理 profile 目录。
struct BrowserGuard {
    child: Child,
    profile: PathBuf,
}

impl Drop for BrowserGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // 浏览器可能还握着文件句柄；删不掉就算了，不能因为清理失败让测试失败。
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

/// 拉起一个 headless 浏览器，返回守卫与浏览器级 WebSocket 地址。
///
/// 用 `--remote-debugging-port=0` 让浏览器自己挑一个空闲端口，再从
/// `<profile>/DevToolsActivePort` 读回实际端口与 WS 路径。
/// 自己挑端口会有"挑完到启动之间被占用"的竞态，交给浏览器最稳。
fn launch_browser(executable: &Path) -> Result<(BrowserGuard, String), String> {
    let profile = std::env::temp_dir().join(format!(
        "b07-cdp-e2e-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    std::fs::create_dir_all(&profile).map_err(|error| format!("建 profile 目录失败：{error}"))?;

    let child = Command::new(executable)
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-extensions")
        .arg("--disable-background-networking")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动浏览器失败：{error}"))?;
    let guard = BrowserGuard { child, profile: profile.clone() };

    // DevToolsActivePort 两行：端口 + 浏览器级 WS 路径。
    let port_file = profile.join("DevToolsActivePort");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            let mut lines = content.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                if let Ok(port) = port.trim().parse::<u16>() {
                    return Ok((guard, format!("ws://127.0.0.1:{port}{}", path.trim())));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err("等待 DevToolsActivePort 超时（浏览器可能启动失败）".to_string());
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

/// 端到端命令的超时（毫秒）。
///
/// 比默认的 30s 宽得多，因为本套件**每个用例各拉起一个浏览器**，并行跑时机器会被
/// 压满：实测截图在 6 个并行 headless 浏览器下会超过 30s 而被判超时（`overdue_ms` 8）。
/// 那不是协议问题，是环境负载 —— 用一个贴合真实负载的超时，而不是把超时调紧。
const E2E_COMMAND_TIMEOUT_MS: u64 = 60_000;

/// 发一条命令并等它的响应；失败时把原因渲染成字符串。
async fn call(
    connection: &mut CdpConnection,
    method: &str,
    params: Option<Value>,
) -> Result<Value, String> {
    let registered = connection
        .send(method, params, Some(E2E_COMMAND_TIMEOUT_MS))
        .await
        .map_err(|error| format!("发送 {method} 失败：{}", error.detail()))?;
    match connection.await_response(registered.id).await {
        Ok(CommandOutcome::Ok(value)) => Ok(value),
        Ok(CommandOutcome::Err { code, message }) => Err(format!("{method} 返回错误 {code}：{message}")),
        Err(error) => Err(format!("等待 {method} 响应失败：{}", error.detail())),
    }
}

/// 连上浏览器、attach 到一个页面目标，返回连接与页面 sessionId。
async fn attach_to_page(websocket_url: &str) -> Result<(CdpConnection, String), String> {
    let mut connection = CdpConnection::connect(ConnectOptions {
        websocket_url: websocket_url.to_string(),
        ..ConnectOptions::default()
    })
    .await
    .map_err(|error| format!("连接浏览器级 WebSocket 失败：{}", error.detail()))?;

    let targets = call(&mut connection, "Target.getTargets", None).await?;
    let target_id = targets
        .pointer("/targetInfos")
        .and_then(Value::as_array)
        .and_then(|infos| {
            infos
                .iter()
                .find(|info| info.get("type").and_then(Value::as_str) == Some("page"))
                .and_then(|info| info.get("targetId"))
                .and_then(Value::as_str)
        })
        .ok_or("浏览器没有 page 目标")?
        .to_string();

    let attached = call(
        &mut connection,
        "Target.attachToTarget",
        Some(serde_json::json!({ "targetId": target_id, "flatten": true })),
    )
    .await?;
    let session_id = attached
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("attach 没有返回 sessionId")?
        .to_string();
    Ok((connection, session_id))
}

/// 起一个极小的本地 HTTP 服务，只回一个固定页面，返回端口。
///
/// 为什么需要它：本套件要验证的是"真的导航到某个页面并把地址/标题读回来"，
/// 这需要一个**能成功加载**的地址。本地 http 页面既不依赖外网，也能在页面里放
/// 脚本与按钮（点击测试要用）。
///
/// 两个细节是为稳定性加的，不是装饰：
/// - **读完请求头再回**：Chrome 的请求可能分多个包到达，没读完就回、然后关连接，
///   会在某些平台上触发 RST，Chrome 把它报成 `net::ERR_ABORTED`（本测试实测撞到过）；
/// - **写完显式 shutdown 写半端**：给对端一个干净的 EOF，而不是靠 drop 关连接。
async fn serve_one_page(html: &'static str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("绑定本地端口");
    let port = listener.local_addr().expect("取本地地址").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                // 读到请求头结束（`\r\n\r\n`）为止；最多读 16 KB 防呆。
                let mut request = Vec::with_capacity(1024);
                let mut chunk = [0u8; 1024];
                while request.len() < 16 * 1024 {
                    match socket.read(&mut chunk).await {
                        Ok(0) => break,
                        Ok(read) => {
                            request.extend_from_slice(&chunk[..read]);
                            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
                let _ = socket.shutdown().await;
            });
        }
    });
    port
}

/// 求值一个表达式并取回它的值。
async fn evaluate(connection: &mut CdpConnection, expression: &str) -> Result<Value, String> {
    let result = call(
        connection,
        "Runtime.evaluate",
        Some(serde_json::json!({ "expression": expression, "returnByValue": true })),
    )
    .await?;
    if let Some(details) = result.get("exceptionDetails") {
        return Err(format!("页面脚本抛异常：{details}"));
    }
    Ok(result.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

#[tokio::test]
async fn 真实浏览器上顶层sessionId能路由到已attach的页面() {
    // 本项缺陷的端到端回归钉：旧实现把 sessionId 放进 `params`，命令落在浏览器级
    // 会话上，`Runtime.evaluate` 会以"方法不存在"失败。假端点抓不到这个 —— 它按
    // 我们的理解回话。
    let _serial = serialize();
    let Some(executable) = find_browser() else {
        skip_or_fail("未找到 Chrome/Edge");
        return;
    };
    let (guard, websocket_url) = match launch_browser(&executable) {
        Ok(value) => value,
        Err(error) => {
            skip_or_fail(&error);
            return;
        }
    };
    let _guard = guard;

    let (mut connection, session_id) = attach_to_page(&websocket_url)
        .await
        .expect("应能 attach 到页面目标");

    // 关键一步：设定目标会话后再求值。sessionId 若不在顶层，这里必然失败。
    connection.set_session_id(Some(session_id.clone()));
    let value = evaluate(&mut connection, "1 + 1")
        .await
        .expect("带会话的 Runtime.evaluate 应成功（sessionId 必须在顶层）");
    assert_eq!(value, serde_json::json!(2), "求值结果应为 2");
}

#[tokio::test]
async fn 真实浏览器上不带会话的命令走浏览器级() {
    // 反向钉子：不设 sessionId 时 `Target.getTargets` 这类浏览器级方法必须可用。
    // 少了它，一个"把所有命令都塞进某个会话"的实现也能通过上一条测试。
    let _serial = serialize();
    let Some(executable) = find_browser() else {
        skip_or_fail("未找到 Chrome/Edge");
        return;
    };
    let (guard, websocket_url) = match launch_browser(&executable) {
        Ok(value) => value,
        Err(error) => {
            skip_or_fail(&error);
            return;
        }
    };
    let _guard = guard;

    let mut connection = CdpConnection::connect(ConnectOptions {
        websocket_url: websocket_url.clone(),
        ..ConnectOptions::default()
    })
    .await
    .expect("应能连上浏览器级 WebSocket");
    let targets = call(&mut connection, "Target.getTargets", None)
        .await
        .expect("浏览器级 Target.getTargets 应成功");
    assert!(
        targets.pointer("/targetInfos").and_then(Value::as_array).is_some(),
        "应返回 targetInfos 列表，实际：{targets}"
    );
}

#[tokio::test]
async fn 真实浏览器上attach后能导航并读到新地址() {
    // 覆盖"动作真的发生"：导航后地址必须变。只发命令不看结果的话，
    // 一条永远不生效的导航也能让测试通过。
    let _serial = serialize();
    let Some(executable) = find_browser() else {
        skip_or_fail("未找到 Chrome/Edge");
        return;
    };
    let (guard, websocket_url) = match launch_browser(&executable) {
        Ok(value) => value,
        Err(error) => {
            skip_or_fail(&error);
            return;
        }
    };
    let _guard = guard;

    let (mut connection, session_id) = attach_to_page(&websocket_url)
        .await
        .expect("应能 attach 到页面目标");
    connection.set_session_id(Some(session_id));

    let port = serve_one_page("<title>e2e</title><p>hello</p>").await;
    let url = format!("http://127.0.0.1:{port}/");
    // 先 enable Page 域：CDP 的惯例是导航前打开它，让导航相关事件与簿记就位。
    let _ = call(&mut connection, "Page.enable", None).await;

    // 冷启动的 headless 浏览器上，**第一次**导航可能被渲染进程 abort
    // （`net::ERR_ABORTED`）。这是环境抖动，不是我们的协议问题 —— 我们的代码只是
    // 发一条 `Page.navigate` 并如实读取结果（`errorText` 那条事实测试已单独钉住）。
    // 所以这里**有界重试**，并把每次的原因累积下来以便归因；无界重试会掩盖真实失败。
    let mut refusal = String::from("（从未收到 errorText）");
    let mut accepted = false;
    for attempt in 1..=5u32 {
        let navigated = call(&mut connection, "Page.navigate", Some(serde_json::json!({ "url": url })))
            .await
            .expect("导航命令本身应成功返回");
        match navigated.get("errorText").and_then(Value::as_str) {
            None => {
                accepted = true;
                break;
            }
            Some(reason) => {
                refusal = format!("第 {attempt} 次：{reason}");
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
    }
    assert!(accepted, "导航在 5 次尝试内均被拒绝，最后一次：{refusal}");

    // 导航是异步的：轮询到标题真的变了，而不是读一次就算。
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let title = evaluate(&mut connection, "document.title").await;
        if matches!(title, Ok(Value::String(ref value)) if value == "e2e") {
            return;
        }
        if Instant::now() >= deadline {
            panic!("导航后 15 秒内页面标题仍未变成 e2e，最后一次读取：{title:?}");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[tokio::test]
async fn 真实浏览器上失败的导航以errorText报错而不是CDP错误() {
    // 这是一条**协议事实**，不是我们的选择：`Page.navigate` 对"导航没成"的地址
    // 返回的是**成功响应 + `errorText`**（net:: 错误码），而不是 CDP 错误。
    // 因此只判 `CommandOutcome::Err` 是不够的 —— 会把一次没发生的导航报成成功。
    // 本测试把这条事实钉住，`browser_tools.rs` 的 `rejected_action_text` 以此为依据。
    //
    // 用什么地址触发：**一个没人监听的本地端口**。这是最可靠的失败来源 ——
    // 不依赖 DNS、不依赖外网，也不依赖浏览器的安全策略。
    // （曾经用 `data:` 顶层导航，以为它会被策略挡下；实测它**能成功**，
    //  当时看到的 errorText 其实是冷启动抖动。写错的依据比没有依据更糟。）
    let _serial = serialize();
    let Some(executable) = find_browser() else {
        skip_or_fail("未找到 Chrome/Edge");
        return;
    };
    let (guard, websocket_url) = match launch_browser(&executable) {
        Ok(value) => value,
        Err(error) => {
            skip_or_fail(&error);
            return;
        }
    };
    let _guard = guard;

    let (mut connection, session_id) = attach_to_page(&websocket_url)
        .await
        .expect("应能 attach 到页面目标");
    connection.set_session_id(Some(session_id));

    // 绑一个端口再立刻释放：这个端口上不会有人监听。
    let dead_port = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("探测端口");
        probe.local_addr().expect("取地址").port()
    };
    let url = format!("http://127.0.0.1:{dead_port}/");
    let navigated = call(&mut connection, "Page.navigate", Some(serde_json::json!({ "url": url })))
        .await
        .expect("命令本身应当成功返回（失败在 errorText 里）");
    let error_text = navigated.get("errorText").and_then(Value::as_str);
    assert!(
        error_text.is_some(),
        "连不上的地址应带 errorText，实际：{navigated}"
    );
    assert!(
        error_text.unwrap_or_default().starts_with("net::"),
        "errorText 应是 net:: 错误码，实际：{error_text:?}"
    );
}

#[tokio::test]
async fn 真实浏览器上点击能真的触发页面事件() {
    // 覆盖 click 的**后置条件**：坐标点击必须真的落到元素上，页面要收到事件。
    // 只算坐标不点击（旧实现）时，页面计数器永远停在 0。
    let _serial = serialize();
    let Some(executable) = find_browser() else {
        skip_or_fail("未找到 Chrome/Edge");
        return;
    };
    let (guard, websocket_url) = match launch_browser(&executable) {
        Ok(value) => value,
        Err(error) => {
            skip_or_fail(&error);
            return;
        }
    };
    let _guard = guard;

    let (mut connection, session_id) = attach_to_page(&websocket_url)
        .await
        .expect("应能 attach 到页面目标");
    connection.set_session_id(Some(session_id));

    // 一个铺满视口的大按钮 + 计数器，避免"坐标算对了但落在别的元素上"的歧义。
    // 走本地 http 而不是 data: —— 与真实用法一致，也便于在页面里放脚本与按钮。
    let port = serve_one_page(
        "<button id='b' style='position:fixed;left:0;top:0;width:300px;height:200px' onclick='window.__hits=(window.__hits||0)+1'>go</button>",
    )
    .await;
    let url = format!("http://127.0.0.1:{port}/");
    call(&mut connection, "Page.navigate", Some(serde_json::json!({ "url": url })))
        .await
        .expect("导航应成功");
    // 等页面就绪（按钮存在）。
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match evaluate(&mut connection, "!!document.getElementById('b')").await {
            Ok(Value::Bool(true)) => break,
            _ if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(150)).await,
            other => panic!("页面未在 10 秒内就绪：{other:?}"),
        }
    }

    // 与 `tool_map::map_click` 的选择器分支同构：先算中心坐标。
    let point = evaluate(
        &mut connection,
        "(() => { const el = document.querySelector('#b'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
    )
    .await
    .expect("应能算出元素中心坐标");
    let x = point.get("x").and_then(Value::as_f64).expect("x 应为数字");
    let y = point.get("y").and_then(Value::as_f64).expect("y 应为数字");

    // 再在坐标上派发完整的按下 + 抬起（与 `click_at` 同构）。
    for event_type in ["mousePressed", "mouseReleased"] {
        call(
            &mut connection,
            "Input.dispatchMouseEvent",
            Some(serde_json::json!({
                "type": event_type,
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1
            })),
        )
        .await
        .expect("派发鼠标事件应成功");
    }

    let hits = evaluate(&mut connection, "window.__hits || 0").await.expect("应能读到计数器");
    assert_eq!(hits, serde_json::json!(1), "点击应真的触发页面 onclick");
}

#[tokio::test]
async fn 真实浏览器上截图返回可解码的PNG() {
    // 覆盖 P2-8：截图必须是**完整**的图片数据。
    // 上一版把它当文本截断到 128_000 字符，产出不可解码的半个 base64。
    let _serial = serialize();
    let Some(executable) = find_browser() else {
        skip_or_fail("未找到 Chrome/Edge");
        return;
    };
    let (guard, websocket_url) = match launch_browser(&executable) {
        Ok(value) => value,
        Err(error) => {
            skip_or_fail(&error);
            return;
        }
    };
    let _guard = guard;

    let (mut connection, session_id) = attach_to_page(&websocket_url)
        .await
        .expect("应能 attach 到页面目标");
    connection.set_session_id(Some(session_id));

    let captured = call(
        &mut connection,
        "Page.captureScreenshot",
        Some(serde_json::json!({ "format": "png", "captureBeyondViewport": false })),
    )
    .await
    .expect("截图应成功");
    let data = captured.get("data").and_then(Value::as_str).expect("截图应带 data");

    // PNG 魔数：能解码的最直接证据。被截断的 base64 解不出这个头。
    use base64::Engine as _;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("截图 base64 应可解码（被截断则解不出）");
    assert!(
        decoded.starts_with(&[0x89, b'P', b'N', b'G']),
        "解码结果应是 PNG（魔数不符，长度 {}）",
        decoded.len()
    );
}
