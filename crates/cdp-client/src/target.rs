//! CDP 目标发现：解析 `/json/version` 与 `/json/list`，并**只接受本机调试端点**。
//!
//! ## 为什么端点校验必须在这里做
//!
//! CDP 的 HTTP 发现接口返回一个 `webSocketDebuggerUrl`。**这个 URL 由对端给出**，
//! 直接连上去等于「把控制权交给一个远端声称的地址」。若解析结果是一个任意主机，
//! 那么一个被劫持的发现响应就能把整个浏览器控制通道指到攻击者那里——而调用方
//! 不会看到任何异常，只会看到「连上了，能发命令」。
//!
//! 因此本模块对 `webSocketDebuggerUrl` 做**白名单校验**，只接受：
//!
//! - scheme 为 `ws:`（**不**接受 `wss:`——本机调试端口不提供 TLS，接受 `wss:`
//!   只会让一个畸形响应看起来合法）；
//! - host 为 `127.0.0.1`、`::1` 或 `localhost`（**精确匹配**，不做后缀匹配——
//!   `localhost.evil.com` 不是 localhost）；
//! - 不含用户名/密码（`ws://user:pass@host/` 一律拒）；
//! - 端口必须是显式整数且在 1–65535 内（无端口时默认 80 是错的——调试端口
//!   必然带端口，缺端口说明这不是调试端点）。
//!
//! ## 边界
//!
//! 纯解析：不做 HTTP 请求。`http://127.0.0.1:9222` 到 `Vec<BrowserTarget>` 之间
//! 的所有判断都在这里，因而可被纯数据单测覆盖。

use serde::Deserialize;
use serde_json::Value;

/// 浏览器调试端点的主机白名单判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointVerdict {
    /// 是本机调试端点，可用。
    Allowed,
    /// 拒绝，带稳定原因。
    Rejected(EndpointRejectReason),
}

/// 端点被拒的稳定原因（闭集）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointRejectReason {
    /// 不是合法 URL。
    NotUrl,
    /// scheme 不是 `ws:`。
    NotWsScheme,
    /// 主机不在本机白名单。
    NotLoopbackHost,
    /// 带用户名或密码。
    HasCredentials,
    /// 缺端口。
    MissingPort,
    /// 端口为 0 或超出 65535。
    InvalidPort,
    /// 路径为空——调试端点必然形如 `/devtools/page/<id>`。
    EmptyPath,
}

impl EndpointRejectReason {
    /// 稳定字符串码，供日志与跨语言归因使用。
    pub fn code(self) -> &'static str {
        match self {
            Self::NotUrl => "endpoint_not_url",
            Self::NotWsScheme => "endpoint_not_ws_scheme",
            Self::NotLoopbackHost => "endpoint_not_loopback_host",
            Self::HasCredentials => "endpoint_has_credentials",
            Self::MissingPort => "endpoint_missing_port",
            Self::InvalidPort => "endpoint_invalid_port",
            Self::EmptyPath => "endpoint_empty_path",
        }
    }
}

impl EndpointVerdict {
    /// 是否放行。
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }

    /// 拒绝原因；放行时返回 `None`。
    pub fn rejection(self) -> Option<EndpointRejectReason> {
        match self {
            Self::Allowed => None,
            Self::Rejected(reason) => Some(reason),
        }
    }
}

/// 手写的极简 URL 切分结果。
///
/// 刻意**不引入 url crate**：本 crate 的依赖面越小，"协议正确性可被纯数据单测"
/// 这个性质就越稳固；而这里需要的切分规则很窄（scheme/host/port/path），
/// 用 20 行显式代码比引入一个能解析整个 URL 规范的依赖更容易审计。
/// 任何切分不了的输入一律 `None`（fail-closed），而不是尽力猜一个。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitUrl {
    /// 小写 scheme，如 `ws`。
    pub scheme: String,
    /// 小写主机名（`::1` 形态去掉了方括号）。
    pub host: String,
    /// 显式端口；缺省为 `None`。
    pub port: Option<u16>,
    /// 路径（含首个 `/`），可空串。
    pub path: String,
    /// 是否带用户名或密码。
    pub has_credentials: bool,
}

/// 切分一个 URL；任何无法确定解析的输入返回 `None`。
pub fn split_url(raw: &str) -> Option<SplitUrl> {
    let trimmed = raw.trim();
    let (scheme, rest) = trimmed.split_once(':')?;
    if scheme.is_empty() {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    // 只处理 `scheme://authority[/path]` 形态；`ws:/foo` 一类判为不可解析。
    let after = rest.strip_prefix("//")?;
    let (authority, path) = match after.find('/') {
        Some(index) => (&after[..index], &after[index..]),
        None => (after, ""),
    };
    if authority.is_empty() {
        return None;
    }

    // 先切凭据（`@` 之后才是主机），再切主机与端口。
    let (credentials, host_port) = match authority.rsplit_once('@') {
        Some((credentials, host_port)) => (Some(credentials), host_port),
        None => (None, authority),
    };
    if host_port.is_empty() {
        return None;
    }

    // IPv6 字面量用方括号包裹（`[::1]:9222`）；去括号后再切端口。
    let (host, port) = if let Some(rest) = host_port.strip_prefix('[') {
        let (inside, tail) = rest.split_once(']')?;
        let port = match tail.strip_prefix(':') {
            Some(value) => Some(value.parse::<u16>().ok()?),
            None if tail.is_empty() => None,
            None => return None,
        };
        (inside.to_ascii_lowercase(), port)
    } else {
        match host_port.rsplit_once(':') {
            Some((host, value)) => (host.to_ascii_lowercase(), Some(value.parse::<u16>().ok()?)),
            None => (host_port.to_ascii_lowercase(), None),
        }
    };
    if host.is_empty() {
        return None;
    }

    Some(SplitUrl {
        scheme,
        host,
        port,
        path: path.to_string(),
        has_credentials: credentials.is_some_and(|value| !value.is_empty()),
    })
}

/// 判定一个 `webSocketDebuggerUrl` 是否可连。
///
/// 这是本模块唯一的对外判定入口——**所有**连前校验都必须经它，避免出现
/// 「某条路径忘了校验」的缝隙。
pub fn evaluate_debugger_endpoint(raw: &str) -> EndpointVerdict {
    let Some(url) = split_url(raw) else {
        return EndpointVerdict::Rejected(EndpointRejectReason::NotUrl);
    };
    if url.scheme != "ws" {
        return EndpointVerdict::Rejected(EndpointRejectReason::NotWsScheme);
    }
    if url.has_credentials {
        return EndpointVerdict::Rejected(EndpointRejectReason::HasCredentials);
    }
    if !is_loopback_host(&url.host) {
        return EndpointVerdict::Rejected(EndpointRejectReason::NotLoopbackHost);
    }
    let Some(port) = url.port else {
        return EndpointVerdict::Rejected(EndpointRejectReason::MissingPort);
    };
    if port == 0 {
        return EndpointVerdict::Rejected(EndpointRejectReason::InvalidPort);
    }
    if url.path.is_empty() || url.path == "/" {
        return EndpointVerdict::Rejected(EndpointRejectReason::EmptyPath);
    }
    EndpointVerdict::Allowed
}

/// 本机主机白名单：**精确匹配**三个字面量，不做后缀或前缀匹配。
///
/// 后缀匹配是这类判定的经典漏洞：`localhost.attacker.com` 与 `127.0.0.1.evil.com`
/// 都会"看起来像"本机。精确匹配把这整类绕过一次性关掉。
fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "localhost")
}

/// 一个可调试目标（来自 `/json/list` 或 `/json/new`）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BrowserTarget {
    /// 目标 id（CDP 内部标识）。
    pub id: String,
    /// 目标类型，如 `page`、`background_page`、`service_worker`。
    #[serde(rename = "type")]
    pub target_type: String,
    /// 标题。
    #[serde(default)]
    pub title: String,
    /// 当前 URL。
    #[serde(default)]
    pub url: String,
    /// 调试该目标的 WebSocket 地址（字段名由 CDP 定死为 camelCase）。
    #[serde(rename = "webSocketDebuggerUrl", default)]
    pub web_socket_debugger_url: Option<String>,
}

/// 目标解析结果。
#[derive(Debug, Clone, PartialEq)]
pub enum TargetParseOutcome {
    /// 解析成功，返回**只保留可安全连接**的目标。
    Parsed(Vec<BrowserTarget>),
    /// 解析失败，带稳定原因。
    Failed(TargetParseFailure),
}

/// 目标解析失败的稳定原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetParseFailure {
    /// 不是合法 JSON。
    NotJson,
    /// 顶层不是数组。
    NotArray,
    /// 某个元素不是合法目标对象。
    MalformedEntry,
}

impl TargetParseFailure {
    /// 稳定字符串码。
    pub fn code(self) -> &'static str {
        match self {
            Self::NotJson => "targets_not_json",
            Self::NotArray => "targets_not_array",
            Self::MalformedEntry => "targets_malformed_entry",
        }
    }
}

/// 解析 `/json/list` 的响应体，并**只保留 endpoint 校验通过的目标**。
///
/// 过滤掉不可连的目标是刻意的：让不可连的目标出现在列表里，会把"端点被劫持"
/// 这件事伪装成"这个目标暂时连不上"，调用方会在重试里耗掉整个超时窗口。
/// 过滤掉之后，列表为空本身就是信号。
pub fn parse_targets(raw: &str) -> TargetParseOutcome {
    let value: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return TargetParseOutcome::Failed(TargetParseFailure::NotJson),
    };
    let Some(entries) = value.as_array() else {
        return TargetParseOutcome::Failed(TargetParseFailure::NotArray);
    };

    let mut targets = Vec::with_capacity(entries.len());
    for entry in entries {
        let target: BrowserTarget = match serde_json::from_value(entry.clone()) {
            Ok(target) => target,
            Err(_) => return TargetParseOutcome::Failed(TargetParseFailure::MalformedEntry),
        };
        // 只保留可安全连接的目标；缺 url 或 url 不合规的一律丢弃。
        let connectable = target
            .web_socket_debugger_url
            .as_deref()
            .is_some_and(|url| evaluate_debugger_endpoint(url).is_allowed());
        if connectable {
            targets.push(target);
        }
    }
    TargetParseOutcome::Parsed(targets)
}

/// `/json/version` 的响应（用于握手确认对端确为 CDP 端点）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BrowserVersion {
    /// 浏览器版本串，如 `HeadlessChrome/120.0.6099.109`。
    #[serde(rename = "Browser", default)]
    pub browser: String,
    /// CDP 协议版本，如 `1.3`。
    #[serde(rename = "Protocol-Version", default)]
    pub protocol_version: String,
    /// 版本端点自己的调试 WebSocket（浏览器级，非页面级）。
    #[serde(rename = "webSocketDebuggerUrl", default)]
    pub web_socket_debugger_url: Option<String>,
}

/// 解析 `/json/version`。
pub fn parse_version(raw: &str) -> Option<BrowserVersion> {
    serde_json::from_str::<BrowserVersion>(raw).ok()
}

/// 从基地址构造发现用的 HTTP URL（`http://127.0.0.1:9222` + `/json/list`）。
///
/// 只接受本机主机与显式端口，与 WebSocket 端点同一套白名单——否则一个
/// "把发现请求发到远端"的配置就能绕开后续所有校验。
pub fn discovery_url(base_host: &str, port: u16, endpoint: DiscoveryEndpoint) -> Option<String> {
    if !is_loopback_host(&base_host.to_ascii_lowercase()) || port == 0 {
        return None;
    }
    let path = match endpoint {
        DiscoveryEndpoint::List => "/json/list",
        DiscoveryEndpoint::Version => "/json/version",
    };
    // IPv6 字面量需要方括号才能构成合法 URL。
    let host = if base_host.contains(':') {
        format!("[{base_host}]")
    } else {
        base_host.to_string()
    };
    Some(format!("http://{host}:{port}{path}"))
}

/// 发现端点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryEndpoint {
    /// `/json/list` —— 列出可调试目标。
    List,
    /// `/json/version` —— 握手确认。
    Version,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 切分标准调试端点() {
        let url = split_url("ws://127.0.0.1:9222/devtools/page/ABCD").unwrap();
        assert_eq!(url.scheme, "ws");
        assert_eq!(url.host, "127.0.0.1");
        assert_eq!(url.port, Some(9222));
        assert_eq!(url.path, "/devtools/page/ABCD");
        assert!(!url.has_credentials);
    }

    #[test]
    fn 切分ipv6字面量() {
        let url = split_url("ws://[::1]:9222/devtools/page/X").unwrap();
        assert_eq!(url.host, "::1");
        assert_eq!(url.port, Some(9222));
    }

    #[test]
    fn 切分无路径() {
        let url = split_url("ws://127.0.0.1:9222").unwrap();
        assert_eq!(url.path, "");
    }

    #[test]
    fn 切分带凭据() {
        let url = split_url("ws://user:pass@127.0.0.1:9222/devtools/page/X").unwrap();
        assert!(url.has_credentials);
        assert_eq!(url.host, "127.0.0.1");
    }

    #[test]
    fn 不可解析的输入返回none() {
        assert!(split_url("").is_none());
        assert!(split_url("just-a-string").is_none());
        assert!(split_url("ws:/foo").is_none());
        assert!(split_url("ws://").is_none());
        assert!(split_url("ws://:9222/x").is_none());
    }

    #[test]
    fn 端口非数字判不可解析() {
        assert!(split_url("ws://127.0.0.1:abc/x").is_none());
        assert!(split_url("ws://127.0.0.1:99999/x").is_none());
    }

    #[test]
    fn 放行本机ws端点() {
        assert!(evaluate_debugger_endpoint("ws://127.0.0.1:9222/devtools/page/A").is_allowed());
        assert!(evaluate_debugger_endpoint("ws://localhost:9222/devtools/page/A").is_allowed());
        assert!(evaluate_debugger_endpoint("ws://[::1]:9222/devtools/page/A").is_allowed());
    }

    #[test]
    fn 拒绝非ws_scheme() {
        let verdict = evaluate_debugger_endpoint("wss://127.0.0.1:9222/devtools/page/A");
        assert_eq!(verdict.rejection(), Some(EndpointRejectReason::NotWsScheme));
        let verdict = evaluate_debugger_endpoint("http://127.0.0.1:9222/devtools/page/A");
        assert_eq!(verdict.rejection(), Some(EndpointRejectReason::NotWsScheme));
    }

    #[test]
    fn 拒绝远端主机() {
        let verdict = evaluate_debugger_endpoint("ws://evil.example.com:9222/devtools/page/A");
        assert_eq!(
            verdict.rejection(),
            Some(EndpointRejectReason::NotLoopbackHost)
        );
    }

    #[test]
    fn 拒绝伪装成本机的主机名() {
        // 这条测试同时守住三个方向——任一方向的放宽都会让它失败：
        //   - 前缀伪装（`localhost.evil.com`）：只有 `starts_with` 写法的实现会放行；
        //   - 后缀伪装（`evil.com.localhost`）：只有 `ends_with` 写法的实现会放行；
        //   - 中间夹带（`evil.127.0.0.1.com`）：`contains` 写法的实现会放行。
        // 三种"看起来像本机"的写法都必须在精确匹配下被挡住。
        // 不写成逐条断言是刻意的：一个用例遍历全部敌对输入，加新变体时不必再写一条。
        for hostile in [
            "localhost.evil.com",
            "127.0.0.1.evil.com",
            "evil.com.localhost",
            "evil.127.0.0.1.com",
            "localhosting.test",
            "127.0.0.10",
        ] {
            let url = format!("ws://{hostile}:9222/devtools/page/A");
            let verdict = evaluate_debugger_endpoint(&url);
            assert_eq!(
                verdict.rejection(),
                Some(EndpointRejectReason::NotLoopbackHost),
                "{hostile} 必须被拒为「非本机」，实际：{verdict:?}"
            );
        }
    }

    #[test]
    fn 拒绝带凭据() {
        let verdict = evaluate_debugger_endpoint("ws://u:p@127.0.0.1:9222/devtools/page/A");
        assert_eq!(
            verdict.rejection(),
            Some(EndpointRejectReason::HasCredentials)
        );
    }

    #[test]
    fn 拒绝缺端口() {
        let verdict = evaluate_debugger_endpoint("ws://127.0.0.1/devtools/page/A");
        assert_eq!(verdict.rejection(), Some(EndpointRejectReason::MissingPort));
    }

    #[test]
    fn 拒绝零端口() {
        let verdict = evaluate_debugger_endpoint("ws://127.0.0.1:0/devtools/page/A");
        assert_eq!(verdict.rejection(), Some(EndpointRejectReason::InvalidPort));
    }

    #[test]
    fn 拒绝空路径与根路径() {
        assert_eq!(
            evaluate_debugger_endpoint("ws://127.0.0.1:9222").rejection(),
            Some(EndpointRejectReason::EmptyPath)
        );
        assert_eq!(
            evaluate_debugger_endpoint("ws://127.0.0.1:9222/").rejection(),
            Some(EndpointRejectReason::EmptyPath)
        );
    }

    #[test]
    fn 拒绝原因有稳定码() {
        assert_eq!(
            EndpointRejectReason::NotLoopbackHost.code(),
            "endpoint_not_loopback_host"
        );
        assert_eq!(
            EndpointRejectReason::HasCredentials.code(),
            "endpoint_has_credentials"
        );
    }

    #[test]
    fn 解析目标列表并过滤不可连项() {
        let raw = r#"[
            {"id":"A","type":"page","title":"Good","url":"https://a.test","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/A"},
            {"id":"B","type":"page","title":"Remote","url":"https://b.test","webSocketDebuggerUrl":"ws://evil.com:9222/devtools/page/B"},
            {"id":"C","type":"page","title":"NoWs","url":"https://c.test"}
        ]"#;
        match parse_targets(raw) {
            TargetParseOutcome::Parsed(targets) => {
                assert_eq!(targets.len(), 1);
                assert_eq!(targets[0].id, "A");
            }
            other => panic!("应解析成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 目标列表非json判失败() {
        assert_eq!(
            parse_targets("nope"),
            TargetParseOutcome::Failed(TargetParseFailure::NotJson)
        );
    }

    #[test]
    fn 目标列表顶层非数组判失败() {
        assert_eq!(
            parse_targets(r#"{"a":1}"#),
            TargetParseOutcome::Failed(TargetParseFailure::NotArray)
        );
    }

    #[test]
    fn 目标元素畸形判失败而不静默跳过() {
        let raw = r#"[{"id":"A","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/A"}]"#;
        assert_eq!(
            parse_targets(raw),
            TargetParseOutcome::Failed(TargetParseFailure::MalformedEntry)
        );
    }

    #[test]
    fn 解析版本端点() {
        let raw = r#"{"Browser":"HeadlessChrome/120.0","Protocol-Version":"1.3"}"#;
        let version = parse_version(raw).unwrap();
        assert_eq!(version.browser, "HeadlessChrome/120.0");
        assert_eq!(version.protocol_version, "1.3");
    }

    #[test]
    fn 发现url只接受本机与显式端口() {
        assert_eq!(
            discovery_url("127.0.0.1", 9222, DiscoveryEndpoint::List).as_deref(),
            Some("http://127.0.0.1:9222/json/list")
        );
        assert_eq!(
            discovery_url("localhost", 9222, DiscoveryEndpoint::Version).as_deref(),
            Some("http://localhost:9222/json/version")
        );
        assert_eq!(
            discovery_url("evil.com", 9222, DiscoveryEndpoint::List),
            None
        );
        assert_eq!(discovery_url("127.0.0.1", 0, DiscoveryEndpoint::List), None);
    }

    #[test]
    fn 发现url给ipv6加方括号() {
        assert_eq!(
            discovery_url("::1", 9222, DiscoveryEndpoint::List).as_deref(),
            Some("http://[::1]:9222/json/list")
        );
    }
}
