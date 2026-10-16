//! 一个**真的**本地 CDP 端点，用于驱动 `cdp-transport` 的完整接收路径。
//!
//! ## 为什么必须是真的 WebSocket 服务器
//!
//! 本 crate 的 `send` / `receive_one` / `await_response` 三条路径全都要求一条活着的
//! 连接。若只用"端点被拒绝"这类测试，那些路径**一行都不会被执行**——功能齐全、
//! 编译通过、clippy 干净、测试全绿，但里面的判定在测试里从不生效。
//!
//! 这一条不是假想：本项目在批次 4 已经吃过一次同形的亏（`decideMicrocompact`
//! 只有测试在调，生产代码零调用点）。本模块是对同一类缺口的修补。
//!
//! ## 为什么不引入 WebSocket 服务端库
//!
//! 需要的能力只有一件：把一条 TCP 连接升级成 WebSocket 文本帧流。为此引入
//! `tokio-tungstenite` 的 `accept` 特性、再加一个 HTTP 解析器，会让本 crate 的
//! 依赖面显著变大——而这段代码**只在测试里**运行，不进入产品。手写极简版
//! （仅处理 `Sec-WebSocket-Accept` 明文帧，无掩码扩展、无压缩）反而更可控：
//! 它短到可以被通读，且不会因为上游库的版本变化而影响断言的稳定性。
//!
//! 帧读写严格按 RFC 6455 实现**服务端**一侧：服务端**不回掩码**，但必须**能解
//! 客户端的掩码**（浏览器与客户端一律掩码发送）。

use std::net::SocketAddr;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// WebSocket 握手用的固定 GUID（RFC 6455 §4.2.2）。
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// 一个已升级的 WebSocket 连接（服务端一侧）。
pub struct FakeCdpSocket {
    stream: BufReader<TcpStream>,
}

/// 一条待发给客户端的帧。
#[derive(Debug, Clone, PartialEq)]
pub enum OutFrame {
    /// 文本帧。
    Text(String),
    /// 二进制帧（用于验证"CDP 是文本协议，二进制帧必须被拒"）。
    Binary(Vec<u8>),
    /// 关闭帧。
    Close,
}

impl FakeCdpSocket {
    /// 对端（客户端）的端口。测试用它来判断"连接是否真的断了"。
    pub fn peer_port(&self) -> u16 {
        self.stream
            .get_ref()
            .peer_addr()
            .expect("已建立的连接必有对端地址")
            .port()
    }

    /// 发送一条帧。
    pub async fn send(&mut self, frame: OutFrame) -> std::io::Result<()> {
        let (opcode, payload): (u8, Vec<u8>) = match frame {
            OutFrame::Text(text) => (0x1, text.into_bytes()),
            OutFrame::Binary(bytes) => (0x2, bytes),
            OutFrame::Close => (0x8, Vec::new()),
        };
        let mut out = Vec::with_capacity(payload.len() + 10);
        out.push(0x80 | opcode); // FIN + opcode
                                 // 服务端**不加掩码**，因此 mask 位为 0。
        match payload.len() {
            length if length < 126 => out.push(length as u8),
            length if length <= u16::MAX as usize => {
                out.push(126);
                out.extend_from_slice(&(length as u16).to_be_bytes());
            }
            length => {
                out.push(127);
                out.extend_from_slice(&(length as u64).to_be_bytes());
            }
        }
        out.extend_from_slice(&payload);
        self.stream.get_mut().write_all(&out).await
    }

    /// 读一条帧的载荷（文本/二进制）。返回 `None` 表示连接已关闭。
    ///
    /// 客户端帧一律带掩码，这里按 RFC 6455 解掩码；分片帧不会出现在本 crate 的
    /// 用法里（命令都是单帧），因此不做分片重组——遇到分片直接返回错误而不是
    /// 假装完整。
    pub async fn read(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        let mut header = [0u8; 2];
        if self.stream.read_exact(&mut header).await.is_err() {
            return Ok(None);
        }
        let opcode = header[0] & 0x0F;
        let masked = header[1] & 0x80 != 0;
        let mut length = (header[1] & 0x7F) as u64;
        if length == 126 {
            let mut extended = [0u8; 2];
            self.stream.read_exact(&mut extended).await?;
            length = u16::from_be_bytes(extended) as u64;
        } else if length == 127 {
            let mut extended = [0u8; 8];
            self.stream.read_exact(&mut extended).await?;
            length = u64::from_be_bytes(extended);
        }
        let mut mask = [0u8; 4];
        if masked {
            self.stream.read_exact(&mut mask).await?;
        }
        let mut payload = vec![0u8; length as usize];
        self.stream.read_exact(&mut payload).await?;
        if masked {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        // 关闭帧 → 视为结束。
        if opcode == 0x8 {
            return Ok(None);
        }
        Ok(Some(payload))
    }

    /// 读一条文本帧并解析成 JSON。
    pub async fn read_json(&mut self) -> std::io::Result<Option<serde_json::Value>> {
        match self.read().await? {
            None => Ok(None),
            Some(bytes) => Ok(Some(
                serde_json::from_slice(&bytes).expect("客户端应当发送合法 JSON 文本帧"),
            )),
        }
    }
}

/// 一个本地假 CDP 端点：绑定 loopback 随机端口。
pub struct FakeCdpEndpoint {
    addr: SocketAddr,
}

impl FakeCdpEndpoint {
    /// 绑定 `127.0.0.1:0`（由系统分配端口）并返回端点与监听器。
    pub async fn bind() -> std::io::Result<(Self, TcpListener)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        Ok((Self { addr }, listener))
    }

    /// 可用的 `ws://` 地址（path 用 `/devtools/browser/fake`——判定只关心
    /// scheme/host/port/path 非空）。
    pub fn websocket_url(&self) -> String {
        format!("ws://127.0.0.1:{}/devtools/browser/fake", self.addr.port())
    }

    /// 接受一条连接并完成 WebSocket 握手，返回可读写的服务端 socket。
    pub async fn accept(listener: &TcpListener) -> std::io::Result<FakeCdpSocket> {
        let (stream, _) = listener.accept().await?;
        let mut reader = BufReader::new(stream);
        // 读到 HTTP 头结束（空行）。极简：不处理分块与 body——握手请求没有 body。
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            if reader.read_exact(&mut byte).await.is_err() {
                break;
            }
            request.push(byte[0]);
            if request.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let text = String::from_utf8_lossy(&request).to_string();
        let key = text
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.trim()
                    .eq_ignore_ascii_case("sec-websocket-key")
                    .then(|| value.trim().to_string())
            })
            .expect("握手请求必须带 Sec-WebSocket-Key");
        let mut hasher = Sha1::new();
        hasher.update(key.as_bytes());
        hasher.update(WS_GUID.as_bytes());
        let accept = BASE64.encode(hasher.finalize());
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        reader.get_mut().write_all(response.as_bytes()).await?;
        reader.get_mut().flush().await?;
        Ok(FakeCdpSocket { stream: reader })
    }
}

/// 把一段 JSON 编成"某条命令的成功响应"文本帧。
pub fn response_text(id: u64, result: serde_json::Value) -> String {
    serde_json::json!({ "id": id, "result": result }).to_string()
}

/// 把一段 JSON 编成事件的文本帧（**无 `id`**——这是事件与响应的唯一判据）。
pub fn event_text(method: &str, params: serde_json::Value) -> String {
    serde_json::json!({ "method": method, "params": params }).to_string()
}

pub use serde_json;
