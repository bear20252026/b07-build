//! 传输层集成测试：用**真的**本地 WebSocket 端点驱动完整收发路径。
//!
//! 本文件的存在理由写在 `fake_cdp.rs` 的模块头里：`send` / `receive_one` /
//! `await_response` 三条路径都要求活连接，只测"端点被拒"等于把接收路径整段
//! 留在无测试覆盖的状态下。
//!
//! 测试名用中文描述行为（仓库既有风格）。中文标识符与 `snake_case` 互斥；而当
//! 测试名需要引用协议里的 camelCase 字段名（`sessionId`）时，按 snake_case 改写
//! 反而会让读者对不上协议字段。故与 `cdp-client` 同样在 crate 级关闭该 lint。
#![allow(non_snake_case)]

mod fake_cdp;

use cdp_transport::{CdpConnection, ConnectOptions, TransportError};
use fake_cdp::{event_text, response_text, FakeCdpEndpoint, OutFrame};

/// 起一个假端点与一条真连接，**同步**拿回服务端 socket。
///
/// 两侧必须并发：服务端 `accept` 与客户端 `connect` 都是会阻塞的 await，
/// 顺序执行会死锁（客户端等握手，服务端等 accept 被调度）。
async fn connected_with_server() -> (CdpConnection, fake_cdp::FakeCdpSocket) {
    let (endpoint, listener) = FakeCdpEndpoint::bind().await.expect("绑定本地端口");
    let url = endpoint.websocket_url();
    // 服务端 accept 与客户端 connect 必须并发：两者都是会阻塞的 await。
    let (connection, server) = tokio::join!(
        CdpConnection::connect(ConnectOptions {
            websocket_url: url,
            ..ConnectOptions::default()
        }),
        FakeCdpEndpoint::accept(&listener),
    );
    (
        connection.expect("合法本机端点应当连上"),
        server.expect("服务端握手应当成功"),
    )
}

#[tokio::test]
async fn 一次完整往返_命令被发出且响应被路由() {
    let (mut client, mut server) = connected_with_server().await;
    let registered = client
        .send("Page.enable", None, None)
        .await
        .expect("发送应当成功");
    assert_eq!(registered.id.0, 1, "首个命令 id 应为 1（0 保留）");

    // 服务端应当收到一条形态正确的命令。
    let received = server
        .read_json()
        .await
        .expect("读取应当成功")
        .expect("应当收到一条帧");
    assert_eq!(received["id"], serde_json::json!(1));
    assert_eq!(received["method"], serde_json::json!("Page.enable"));
    assert!(
        received.get("params").is_none(),
        "无参数时不应发出 params 字段（部分实现拒收显式 null）"
    );

    // 回一条成功响应，客户端应当路由成功。
    server
        .send(OutFrame::Text(response_text(1, serde_json::json!({}))))
        .await
        .unwrap();
    let outcome = client
        .await_response(registered.id)
        .await
        .expect("应当拿到响应");
    assert_eq!(
        outcome,
        cdp_client::frame::CommandOutcome::Ok(serde_json::json!({}))
    );
    assert_eq!(client.pending_count(), 0, "路由后不应留下在途命令");
}

#[tokio::test]
async fn 失败响应被上抛而不是当成空结果() {
    let (mut client, mut server) = connected_with_server().await;
    let registered = client.send("Runtime.evaluate", None, None).await.unwrap();
    let _ = server.read_json().await.unwrap();
    server
        .send(OutFrame::Text(
            serde_json::json!({
                "id": registered.id.0,
                "error": { "code": -32000, "message": "Cannot find context" }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let outcome = client.await_response(registered.id).await.unwrap();
    assert_eq!(
        outcome,
        cdp_client::frame::CommandOutcome::Err {
            code: -32000,
            message: "Cannot find context".to_string()
        }
    );
}

#[tokio::test]
async fn 途中的事件入缓冲且不打断等待() {
    let (mut client, mut server) = connected_with_server().await;
    let registered = client.send("Page.navigate", None, None).await.unwrap();
    let _ = server.read_json().await.unwrap();
    // 先推两条事件，再回响应。
    server
        .send(OutFrame::Text(event_text(
            "Page.frameNavigated",
            serde_json::json!({ "frame": { "id": "A" } }),
        )))
        .await
        .unwrap();
    server
        .send(OutFrame::Text(event_text(
            "Page.loadEventFired",
            serde_json::json!({ "timestamp": 7 }),
        )))
        .await
        .unwrap();
    server
        .send(OutFrame::Text(response_text(
            registered.id.0,
            serde_json::json!({ "frameId": "A" }),
        )))
        .await
        .unwrap();

    let outcome = client.await_response(registered.id).await.unwrap();
    assert_eq!(
        outcome,
        cdp_client::frame::CommandOutcome::Ok(serde_json::json!({ "frameId": "A" }))
    );
    // 事件必须被**保留**而不是在路上丢掉。
    assert_eq!(client.session().events().len(), 2);
    assert_eq!(
        client.session().events_named("Page.loadEventFired").len(),
        1
    );
}

#[tokio::test]
async fn 孤儿响应被判协议不可信并上抛() {
    // 本测试直接钉住 `await_response` 对孤儿响应的处置。若实现改成"静默继续等待"，
    // 本测试会因为超时/挂起而失败——正是它存在的意义。
    let (mut client, mut server) = connected_with_server().await;
    let registered = client.send("Page.enable", None, None).await.unwrap();
    let _ = server.read_json().await.unwrap();
    // 回一条 id 完全对不上的响应（模拟"这条连接上有别的东西在说话"）。
    server
        .send(OutFrame::Text(response_text(9_999, serde_json::json!({}))))
        .await
        .unwrap();
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.await_response(registered.id),
    )
    .await
    .expect("孤儿响应必须立刻上抛，而不是让调用方一直等")
    .unwrap_err();
    match error {
        TransportError::ConnectFailed(detail) => {
            assert!(
                detail.contains("orphan_never_seen"),
                "应带上孤儿原因，实际：{detail}"
            );
        }
        other => panic!("应为协议不可信错误，实际：{other:?}"),
    }
}

#[tokio::test]
async fn 二进制帧被拒绝而不是静默忽略() {
    let (mut client, mut server) = connected_with_server().await;
    let registered = client.send("Page.enable", None, None).await.unwrap();
    let _ = server.read_json().await.unwrap();
    server
        .send(OutFrame::Binary(vec![0x00, 0x01, 0x02]))
        .await
        .unwrap();
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.await_response(registered.id),
    )
    .await
    .expect("二进制帧必须立刻上抛")
    .unwrap_err();
    assert_eq!(error, TransportError::BinaryFrameRejected);
}

#[tokio::test]
async fn 坏帧被拒绝而不是静默忽略() {
    let (mut client, mut server) = connected_with_server().await;
    let registered = client.send("Page.enable", None, None).await.unwrap();
    let _ = server.read_json().await.unwrap();
    server
        .send(OutFrame::Text("not json at all".to_string()))
        .await
        .unwrap();
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.await_response(registered.id),
    )
    .await
    .expect("坏帧必须立刻上抛")
    .unwrap_err();
    match error {
        TransportError::ConnectFailed(detail) => {
            assert!(
                detail.contains("not_json"),
                "应带上坏帧原因，实际：{detail}"
            );
        }
        other => panic!("应为坏帧错误，实际：{other:?}"),
    }
}

#[tokio::test]
async fn 连接被关闭时等待返回关闭错误() {
    let (mut client, mut server) = connected_with_server().await;
    let registered = client.send("Page.enable", None, None).await.unwrap();
    let _ = server.read_json().await.unwrap();
    server.send(OutFrame::Close).await.unwrap();
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.await_response(registered.id),
    )
    .await
    .expect("关闭必须立刻上抛")
    .unwrap_err();
    assert_eq!(error, TransportError::Closed);
}

#[tokio::test]
async fn 超时的命令被清扫且不再等待() {
    let (mut client, mut server) = connected_with_server().await;
    // 超时窗口极短，且服务端**不回**任何东西。
    let registered = client.send("Page.enable", None, Some(50)).await.unwrap();
    let _ = server.read_json().await.unwrap();
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.await_response(registered.id),
    )
    .await
    .expect("超时必须被判出并上抛，而不是永远等待")
    .unwrap_err();
    match error {
        TransportError::CommandTimedOut { method, .. } => assert_eq!(method, "Page.enable"),
        other => panic!("应为超时错误，实际：{other:?}"),
    }
    assert_eq!(client.pending_count(), 0, "超时后不应留下在途命令");
}

#[tokio::test]
async fn 两条并发命令的乱序响应各归其主() {
    let (mut client, mut server) = connected_with_server().await;
    let first = client.send("Page.navigate", None, None).await.unwrap();
    let second = client.send("Runtime.evaluate", None, None).await.unwrap();
    assert_ne!(first.id, second.id, "并发命令必须拿到不同的 id");
    let _ = server.read_json().await.unwrap();
    let _ = server.read_json().await.unwrap();

    // 后发的先回。
    server
        .send(OutFrame::Text(response_text(
            second.id.0,
            serde_json::json!({ "which": "second" }),
        )))
        .await
        .unwrap();
    server
        .send(OutFrame::Text(response_text(
            first.id.0,
            serde_json::json!({ "which": "first" }),
        )))
        .await
        .unwrap();

    let first_result = client.await_response(first.id).await.unwrap();
    assert_eq!(
        first_result,
        cdp_client::frame::CommandOutcome::Ok(serde_json::json!({ "which": "first" })),
        "第一条命令必须拿到自己的结果（绝不能串台）"
    );
}

#[tokio::test]
async fn 命令id逐条递增且不重用() {
    // id 单调是 `session` 放弃窗口纪律的前提：复用 id 会反复撞上
    // `IdInAbandonedWindow`，把纪律变成噪音。
    let (mut client, mut server) = connected_with_server().await;
    let mut seen = Vec::new();
    for _ in 0..5 {
        let registered = client.send("Page.enable", None, None).await.unwrap();
        seen.push(registered.id.0);
        let _ = server.read_json().await.unwrap();
    }
    assert_eq!(seen, vec![1, 2, 3, 4, 5]);
}

#[tokio::test]
async fn 发送后服务端收到顶层sessionId的命令() {
    // 扁平会话模型：`sessionId` 必须与 `id`、`method` **并列在顶层**。
    // 本测试原先断言的是 `params.sessionId` —— 那恰好把错误格式固定成了通过条件。
    // 现在两路都断言：顶层必须有，`params` 内必须没有。
    let (mut client, mut server) = connected_with_server().await;
    client.set_session_id(Some("SESSION-1".to_string()));
    assert_eq!(client.session_id(), Some("SESSION-1"));
    let _ = client
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({ "expression": "1+1" })),
            None,
        )
        .await
        .unwrap();
    let received = server.read_json().await.unwrap().unwrap();
    assert_eq!(received["sessionId"], serde_json::json!("SESSION-1"));
    assert_eq!(received["method"], serde_json::json!("Runtime.evaluate"));
    assert_eq!(received["params"]["expression"], serde_json::json!("1+1"));
    // 反向断言：只断言顶层存在的话，"两处都写"的实现也能通过。
    assert!(
        received["params"].get("sessionId").is_none(),
        "sessionId 不得出现在 params 内，实际：{}",
        received["params"]
    );
}

#[tokio::test]
async fn 无会话的命令不带sessionId且参数原样() {
    // 无会话时不得凭空出现 `sessionId`（浏览器级命令）。
    let (mut client, mut server) = connected_with_server().await;
    let _ = client
        .send("Page.navigate", Some(serde_json::json!({ "url": "about:blank" })), None)
        .await
        .unwrap();
    let received = server.read_json().await.unwrap().unwrap();
    assert!(received.get("sessionId").is_none());
    assert_eq!(received["params"]["url"], serde_json::json!("about:blank"));
}

#[tokio::test]
async fn 会话命令无参数时省略params() {
    // 带会话但没有参数：顶层要有 sessionId，且**不应**发一个只有 sessionId 的 params。
    let (mut client, mut server) = connected_with_server().await;
    client.set_session_id(Some("S-7".to_string()));
    let _ = client.send("Page.enable", None, None).await.unwrap();
    let received = server.read_json().await.unwrap().unwrap();
    assert_eq!(received["sessionId"], serde_json::json!("S-7"));
    assert!(received.get("params").is_none(), "无参数时不应出现 params");
}

#[tokio::test]
async fn 非对象参数被拒绝() {
    // 参数不是对象：拒绝而不是发出去——对端可能接受一条语义不明的命令
    // 并做出意外动作。这条校验与会话无关（CDP 的 params 本就是对象）。
    let (mut client, mut server) = connected_with_server().await;
    client.set_session_id(Some("SESSION-1".to_string()));
    let error = client
        .send("Runtime.evaluate", Some(serde_json::json!([1, 2, 3])), None)
        .await
        .unwrap_err();
    assert!(matches!(error, TransportError::SendFailed(_)));
    // 失败的命令不得留在在途表里（泄漏）。
    assert_eq!(client.pending_count(), 0);
    // 服务端不应收到任何帧。
    let nothing =
        tokio::time::timeout(std::time::Duration::from_millis(200), server.read_json()).await;
    assert!(nothing.is_err(), "被拒绝的命令不应被发出，实际收到了帧");
}

#[tokio::test]
async fn 连接已断时发送失败且不留下在途命令() {
    // 真实场景：命令发出前，浏览器标签页/调试端口那一侧已经关了连接。
    //
    // 本测试刻意**两路都断言**，因为 `send` 与"等待响应"是两条不同的清理路径：
    // - 写入本身就失败 → `send` 内部撤回登记；
    // - 写入被内核缓冲接受（TCP 允许）→ 命令确实"发出"，由等待路径撤回。
    // 只断言 `pending_count() == 0` 会让两者变得无法区分（任一条路径生效都通过），
    // 因此这里对每条路径分别断言其**特有的**可观察后果。
    //
    // 实测：在本环境下（Windows + tokio）几乎总是走**第二条**路径——对端消失后
    // 内核仍接受写入，真正的失败在下一次读时浮现。第一条路径是防御性的，见
    // `CdpConnection::send` 的文档说明。因此本测试实际钉住的是等待路径的清理。
    let (mut client, server) = connected_with_server().await;
    // 关掉服务端，并**等它真的消失**：只 `drop` 不够——TCP 允许内核继续
    // 接受写入，于是写入会"成功"，测试就永远走不到发送失败那条路。
    let port = server.peer_port();
    drop(server);
    wait_until_port_closed(port).await;

    match client.send("Page.enable", None, None).await {
        Err(TransportError::Disconnected(_)) => {
            // 路径一：写入失败。特有后果 = 登记被撤回（否则泄漏成永不到达的等待）。
            assert_eq!(
                client.pending_count(),
                0,
                "发送失败的命令不得留在在途表里（否则泄漏成永不到达的等待）"
            );
        }
        Ok(registered) => {
            // 路径二：写入被接受。特有后果 = 连接已断，等待**立刻**结束（不是挂到超时）。
            assert_eq!(client.pending_count(), 1);
            let error = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                client.await_response(registered.id),
            )
            .await
            .expect("连接已断时等待必须立刻结束，而不是挂到超时")
            .unwrap_err();
            assert!(
                matches!(
                    error,
                    TransportError::Closed
                        | TransportError::Disconnected(_)
                        | TransportError::CommandTimedOut { .. }
                ),
                "应为连接关闭/断开或超时，实际：{error:?}"
            );
            assert_eq!(client.pending_count(), 0, "等待结束后在途表必须干净");
        }
        Err(other) => panic!("应为发送失败（连接已断），实际：{other:?}"),
    }
}

/// 轮询直到该端口上的连接被拒绝（说明服务端确实消失了）。
///
/// 不能只 `sleep` 一个固定时长：那在不同机器上要么太短（FIN 还没传完，
/// 测试偶发走错分支）要么太长。轮询让测试**确定性地**进入目标状态。
async fn wait_until_port_closed(port: u16) {
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("端口 {port} 一直可连——服务端应当已消失");
}

#[tokio::test]
async fn 无会话时不附加sessionId字段() {
    let (mut client, mut server) = connected_with_server().await;
    let _ = client
        .send(
            "Page.navigate",
            Some(serde_json::json!({ "url": "https://example.com" })),
            None,
        )
        .await
        .unwrap();
    let received = server.read_json().await.unwrap().unwrap();
    assert!(
        received["params"].get("sessionId").is_none(),
        "未设定目标会话时不应凭空造一个 sessionId"
    );
    assert_eq!(
        received["params"]["url"],
        serde_json::json!("https://example.com")
    );
}

#[tokio::test]
async fn 无会话无参数时命令不带params字段() {
    let (mut client, mut server) = connected_with_server().await;
    let _ = client.send("Page.enable", None, None).await.unwrap();
    let received = server.read_json().await.unwrap().unwrap();
    assert!(received.get("params").is_none());
}
