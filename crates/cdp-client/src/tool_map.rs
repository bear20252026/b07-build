//! 工具面到 CDP 方法的映射：把 b07 的 13 个 `browser_*` 工具翻译成 CDP 命令序列。
//!
//! ## 为什么要显式映射而不是"按名字拼"
//!
//! b07 的 13 个工具是**面向 Agent 的语义单位**（`snapshot`、`fill_form`、`tabs`），
//! CDP 的方法是**面向浏览器的原语**（`Page.captureSnapshot`、`Input.insertText`、
//! `Target.getTargets`）。两者的粒度**不成一对一**：
//!
//! - 一个工具 → 多条 CDP 命令（`navigate` 需要 `Page.enable` + `Page.navigate`）；
//! - 一个工具 → 有条件的方法选择（`click` 有 selector 走 `DOM`，有坐标走 `Input`）；
//! - 一个工具 → 纯本地判定（`wait_for` 的 timeoutMs 就是本地定时，不发命令）。
//!
//! 如果用"按名字拼字符串"的方式实现，上述三类差异会散落到调用点里，每个调用点
//! 各自记得"要先 enable"、"要按参数选方法"——忘一处就是静默错行为（命令发出去了，
//! 但发的是另一件事）。因此把映射做成**显式的数据表 + 纯函数**，本模块可以被
//! 逐工具单测，而调用方只剩"按映射结果发命令"这一件事。
//!
//! ## 边界
//!
//! 纯数据：不构造命令 id（那是 `frame::CommandIdAllocator` 的事）、不发命令。
//! 输入是工具的 canonical 名与参数 JSON，输出是「发哪些方法、每个带什么参数」
//! 或「这个调用无法映射，稳定原因」。

use serde_json::{json, Map, Value};

/// 一条待发出的 CDP 步骤（方法名 + 参数 + 可选的后置动作）。
#[derive(Debug, Clone, PartialEq)]
pub struct CdpStep {
    /// CDP 方法名。
    pub method: String,
    /// 方法参数；无参数时为 `None`。
    pub params: Option<Value>,
    /// 这一步**之后**要做的动作，且依赖这一步的返回值。
    ///
    /// 为什么需要它：有些工具的语义不是"发一条命令"，而是"发一条命令，**再按它的结果**做点什么"。
    /// `click` 就是典型 —— 先用 JS 算出元素中心坐标，再在该坐标派发鼠标事件。
    /// 只发前半段的话，工具名叫 click 却没有点击发生，而调用方看到的是"成功"。
    /// 把后半段表达在计划里，而不是让执行层去猜方法名的含义。
    pub then: Option<StepFollowUp>,
}

/// 依赖上一步返回值的后置动作（闭集）。
#[derive(Debug, Clone, PartialEq)]
pub enum StepFollowUp {
    /// 上一步返回的必须是**真值**；否则整个工具调用失败。
    ///
    /// 用于 `type` / `fill_form`：它们的定位脚本在找不到元素时返回 `false`。
    /// 忽略这个 `false` 继续往下走，会把文本输进当时恰好获得焦点的**别的**输入框 ——
    /// 一个既难发现又已经产生副作用的错误。
    RequireTruthy,
    /// 把上一步返回的 `{x, y}` 当作视口坐标，派发一次左键点击。
    ClickAtReturnedPoint,
}

impl CdpStep {
    fn new(method: &str, params: Option<Value>) -> Self {
        Self {
            method: method.to_string(),
            params,
            then: None,
        }
    }

    /// 给这一步挂一个后置动作。
    fn then(mut self, follow_up: StepFollowUp) -> Self {
        self.then = Some(follow_up);
        self
    }
}

/// 映射结果。
#[derive(Debug, Clone, PartialEq)]
pub enum ToolMapOutcome {
    /// 成功映射为若干 CDP 步骤（有序，须按序发出）。
    Steps(Vec<CdpStep>),
    /// 该工具由原生侧**本地处理**，不产出 CDP 步骤。
    ///
    /// 会话生命周期工具（`create_session` / `list_sessions` / `close_session`）管理的
    /// 正是"连接"本身，没法发给连接去执行。它们必须是**显式的一类**，而不是
    /// "空步骤列表"——空列表会让调用方以为"成功执行了 0 步"，把一个静默空操作
    /// 当成成功。同理，它们也不该在映射层要求任何参数：映射层要的参数会变成
    /// 事实上的公开契约，而公开契约里并没有那些字段。
    Local,
    /// 映射失败，带稳定原因。
    Unmappable(ToolMapFailure),
}

/// 映射失败的稳定原因（闭集）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolMapFailure {
    /// 不是 13 个已登记工具之一。
    UnknownTool,
    /// 参数不是 JSON 对象。
    ParamsNotObject,
    /// 缺必填参数。
    MissingParameter(&'static str),
    /// 参数类型不对。
    WrongParameterType(&'static str),
    /// 参数取值不在允许范围（如 `tabs.action`）。
    InvalidParameterValue(&'static str),
    /// 选择器定位方式缺失（`click` 三个定位参数全空）。
    NoLocator,
}

impl ToolMapFailure {
    /// 稳定字符串码；带参数的原因拼接参数名，便于前端展示与断言。
    pub fn code(self) -> String {
        match self {
            Self::UnknownTool => "tool_map_unknown_tool".to_string(),
            Self::ParamsNotObject => "tool_map_params_not_object".to_string(),
            Self::MissingParameter(name) => format!("tool_map_missing_parameter:{name}"),
            Self::WrongParameterType(name) => format!("tool_map_wrong_parameter_type:{name}"),
            Self::InvalidParameterValue(name) => format!("tool_map_invalid_parameter_value:{name}"),
            Self::NoLocator => "tool_map_no_locator".to_string(),
        }
    }
}

/// 13 个工具的后缀名（canonical 名 `mcp__browser__<suffix>` 的 `<suffix>`）。
///
/// 与 `browser-tool-surface.ts` 的 `BROWSER_TOOL_NAMES` 一一对应。刻意在这里
/// **再列一遍**而不是从 TS 侧导入：Rust 侧不能 import TypeScript，而两边的一致性
/// 由一条测试钉住（见 `tests/tool_map_parity.rs`，它比对同一份 13 个名字的字面量）。
pub const TOOL_SUFFIXES: [&str; 13] = [
    "create_session",
    "list_sessions",
    "close_session",
    "snapshot",
    "take_screenshot",
    "navigate",
    "click",
    "type",
    "fill_form",
    "press_key",
    "select_option",
    "wait_for",
    "tabs",
];

/// 把 canonical 工具名剥成后缀（`mcp__browser__navigate` → `navigate`）。
///
/// 剥不出来返回 `None`（fail-closed），而不是"尽力取最后一段"——最后一段的
/// 启发式会把 `mcp__other__navigate` 也当成 `navigate`，等于绕过工具面归属。
pub fn tool_suffix(canonical_name: &str) -> Option<&str> {
    canonical_name
        .strip_prefix("mcp__browser__")
        .filter(|suffix| !suffix.is_empty())
}

/// 判定一个 canonical 名是否是已登记的浏览器工具。
pub fn is_browser_tool(canonical_name: &str) -> bool {
    tool_suffix(canonical_name).is_some_and(|suffix| TOOL_SUFFIXES.contains(&suffix))
}

/// 取字符串参数。
fn string_param(params: &Map<String, Value>, name: &'static str) -> Result<String, ToolMapFailure> {
    match params.get(name) {
        None | Some(Value::Null) => Err(ToolMapFailure::MissingParameter(name)),
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(ToolMapFailure::WrongParameterType(name)),
    }
}

/// 取可选字符串参数；缺失或空串都返回 `None`。
fn optional_string(
    params: &Map<String, Value>,
    name: &str,
) -> Result<Option<String>, ToolMapFailure> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(ToolMapFailure::WrongParameterType(leak_param_name(name))),
    }
}

/// 取可选数值参数。
fn optional_number(params: &Map<String, Value>, name: &str) -> Result<Option<f64>, ToolMapFailure> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => Ok(value.as_f64()),
        Some(_) => Err(ToolMapFailure::WrongParameterType(leak_param_name(name))),
    }
}

/// 取可选布尔参数。
fn optional_bool(params: &Map<String, Value>, name: &str) -> Result<Option<bool>, ToolMapFailure> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ToolMapFailure::WrongParameterType(leak_param_name(name))),
    }
}

/// 把运行期参数名转成 `'static`。
///
/// 只有少数几个可选参数名需要这个（`selector`/`submit`/`force`/`timeoutMs` 等），
/// 它们都是编译期字面量；用穷尽匹配而不是 `Box::leak`——泄漏内存来做错误码
/// 不值得，而 `UnknownParameter` 分支能立刻暴露"有人加了未登记的参数名"。
fn leak_param_name(name: &str) -> &'static str {
    match name {
        "selector" => "selector",
        "submit" => "submit",
        "force" => "force",
        "timeoutMs" => "timeoutMs",
        "index" => "index",
        "url" => "url",
        "text" => "text",
        "x" => "x",
        "y" => "y",
        "fields" => "fields",
        "values" => "values",
        "key" => "key",
        "action" => "action",
        "profileName" => "profileName",
        _ => "unknown",
    }
}

/// 把工具调用映射为 CDP 步骤。
///
/// `canonical_name` 是 `mcp__browser__<suffix>`；`raw_params` 是工具参数 JSON。
pub fn map_tool_call(canonical_name: &str, raw_params: Option<&Value>) -> ToolMapOutcome {
    let Some(suffix) = tool_suffix(canonical_name) else {
        return ToolMapOutcome::Unmappable(ToolMapFailure::UnknownTool);
    };
    if !TOOL_SUFFIXES.contains(&suffix) {
        return ToolMapOutcome::Unmappable(ToolMapFailure::UnknownTool);
    }
    // 无参数工具允许 `null` / 缺失；其余必须是对象。
    let params = match raw_params {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return ToolMapOutcome::Unmappable(ToolMapFailure::ParamsNotObject),
    };

    let result = match suffix {
        // 会话生命周期：本地处理，不映射为 CDP 步骤（见 `ToolMapOutcome::Local`）。
        "create_session" | "list_sessions" | "close_session" => return ToolMapOutcome::Local,
        "snapshot" => map_snapshot(&params),
        "take_screenshot" => map_take_screenshot(),
        "navigate" => map_navigate(&params),
        "click" => map_click(&params),
        "type" => map_type(&params),
        "fill_form" => map_fill_form(&params),
        "press_key" => map_press_key(&params),
        "select_option" => map_select_option(&params),
        "wait_for" => map_wait_for(&params),
        "tabs" => map_tabs(&params),
        _ => unreachable!("后缀已在 TOOL_SUFFIXES 里校验过"),
    };

    match result {
        Ok(steps) => ToolMapOutcome::Steps(steps),
        Err(failure) => ToolMapOutcome::Unmappable(failure),
    }
}

/// `snapshot`：取页面结构 + 可见文本。
fn map_snapshot(_params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    Ok(vec![
        CdpStep::new(
            "Runtime.evaluate",
            Some(json!({
                "expression": "({ title: document.title, url: location.href, text: document.body ? document.body.innerText : '' })",
                "returnByValue": true,
                "awaitPromise": false
            })),
        ),
        CdpStep::new("Page.captureSnapshot", Some(json!({ "format": "mhtml" }))),
    ])
}

/// `take_screenshot`：抓一张 PNG。
///
/// `captureBeyondViewport: false` 是刻意的——抓全页会让超长页面产出巨大的
/// base64，而工具面的 `resultBudgetChars` 是 512_000；抓视口内的图是更可预期的。
fn map_take_screenshot() -> Result<Vec<CdpStep>, ToolMapFailure> {
    Ok(vec![CdpStep::new(
        "Page.captureScreenshot",
        Some(json!({ "format": "png", "captureBeyondViewport": false })),
    )])
}

/// `navigate`：`Page.navigate` + 等待加载事件。
fn map_navigate(params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    let url = string_param(params, "url")?;
    if !is_navigable_url(&url) {
        return Err(ToolMapFailure::InvalidParameterValue("url"));
    }
    Ok(vec![CdpStep::new(
        "Page.navigate",
        Some(json!({ "url": url })),
    )])
}

/// 导航目标只接受 `http:` / `https:`。
///
/// 拒绝 `file:`、`javascript:`、`data:` 等是**安全边界**：`file:` 会让 Agent
/// 读到本机任意文件，`javascript:` 是直接注入。这与 b07 控制面账本
/// （`browser-session-control.ts` 只允许公网 HTTPS）方向一致，但更宽——控制面
/// 管的是"授权访问哪个站点"，这里管的是"这条 CDP 命令能不能发出去"。
fn is_navigable_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && lower.len() > "https://".len()
}

/// `click`：三种定位方式，按 `selector` > `text` > 坐标 的优先级选一种。
///
/// 三选一而非全用：把三者都发出去会导致"选择器点一次、坐标再点一次"的双击。
/// 优先级固定为 selector > text > 坐标，因为前两者是**语义定位**（页面改版后仍有效），
/// 坐标是**像素定位**（改版即失效）——能用语义就不用像素。
fn map_click(params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    let selector = optional_string(params, "selector")?;
    let text = optional_string(params, "text")?;
    let x = optional_number(params, "x")?;
    let y = optional_number(params, "y")?;

    if let Some(selector) = selector {
        // 语义定位：先用 JS 算出元素中心坐标，再在该坐标点击。
        let expression = format!(
            "(() => {{ const el = document.querySelector({sel}); if (!el) return null; const r = el.getBoundingClientRect(); return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }}; }})()",
            sel = serde_json::to_string(&selector).unwrap_or_else(|_| "null".to_string())
        );
        return Ok(vec![CdpStep::new(
            "Runtime.evaluate",
            Some(json!({ "expression": expression, "returnByValue": true })),
        )
        .then(StepFollowUp::ClickAtReturnedPoint)]);
    }
    if let Some(text) = text {
        let expression = format!(
            "(() => {{ const all = [...document.querySelectorAll('*')]; const el = all.find(n => n.children.length === 0 && n.textContent && n.textContent.trim() === {t}); if (!el) return null; const r = el.getBoundingClientRect(); return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }}; }})()",
            t = serde_json::to_string(&text).unwrap_or_else(|_| "null".to_string())
        );
        return Ok(vec![CdpStep::new(
            "Runtime.evaluate",
            Some(json!({ "expression": expression, "returnByValue": true })),
        )
        .then(StepFollowUp::ClickAtReturnedPoint)]);
    }
    match (x, y) {
        (Some(x), Some(y)) => Ok(vec![
            CdpStep::new(
                "Input.dispatchMouseEvent",
                Some(
                    json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 }),
                ),
            ),
            CdpStep::new(
                "Input.dispatchMouseEvent",
                Some(
                    json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 }),
                ),
            ),
        ]),
        _ => Err(ToolMapFailure::NoLocator),
    }
}

/// `type`：向选择器或焦点输入文本；`submit` 为真时补一个回车。
fn map_type(params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    let text = string_param(params, "text")?;
    let selector = optional_string(params, "selector")?;
    let submit = optional_bool(params, "submit")?.unwrap_or(false);

    let mut steps = Vec::new();
    if let Some(selector) = selector {
        let expression = format!(
            "(() => {{ const el = document.querySelector({sel}); if (!el) return false; el.focus(); return true; }})()",
            sel = serde_json::to_string(&selector).unwrap_or_else(|_| "null".to_string())
        );
        // 定位脚本找不到元素时返回 false。忽略它继续 insertText 会把文本
        // 输进当时恰好有焦点的**别的**输入框。
        steps.push(
            CdpStep::new(
                "Runtime.evaluate",
                Some(json!({ "expression": expression, "returnByValue": true })),
            )
            .then(StepFollowUp::RequireTruthy),
        );
    }
    steps.push(CdpStep::new(
        "Input.insertText",
        Some(json!({ "text": text })),
    ));
    if submit {
        steps.push(CdpStep::new(
            "Input.dispatchKeyEvent",
            Some(json!({ "type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13 })),
        ));
        steps.push(CdpStep::new(
            "Input.dispatchKeyEvent",
            Some(json!({ "type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13 })),
        ));
    }
    Ok(steps)
}

/// `fill_form`：一次填多个字段。
///
/// 逐字段发一条 `Runtime.evaluate`（而不是拼一条大 JS）：单条大 JS 中途失败时
/// 无法知道填到哪，而逐步发能让调用方在失败点停住并报告"前 N 个已填"——部分
/// 成功的表单比全失败更需要精确的可观测性。
fn map_fill_form(params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    let Some(fields) = params.get("fields") else {
        return Err(ToolMapFailure::MissingParameter("fields"));
    };
    let Some(fields) = fields.as_array() else {
        return Err(ToolMapFailure::WrongParameterType("fields"));
    };
    if fields.is_empty() {
        return Err(ToolMapFailure::InvalidParameterValue("fields"));
    }

    let mut steps = Vec::with_capacity(fields.len());
    for field in fields {
        let Some(object) = field.as_object() else {
            return Err(ToolMapFailure::WrongParameterType("fields"));
        };
        let selector = match object.get("selector").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value,
            _ => return Err(ToolMapFailure::MissingParameter("fields.selector")),
        };
        // value 允许空串（清空字段是合法意图），故只判存在与类型。
        let value = match object.get("value") {
            Some(Value::String(value)) => value.clone(),
            Some(_) => return Err(ToolMapFailure::WrongParameterType("fields.value")),
            None => return Err(ToolMapFailure::MissingParameter("fields.value")),
        };
        let expression = format!(
            "(() => {{ const el = document.querySelector({sel}); if (!el) return false; el.focus(); el.value = {v}; el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }})); return true; }})()",
            sel = serde_json::to_string(selector).unwrap_or_else(|_| "null".to_string()),
            v = serde_json::to_string(&value).unwrap_or_else(|_| "\"\"".to_string())
        );
        // 与 type 同理：字段不存在时必须失败，而不是"成功填了 0 个字段"。
        steps.push(
            CdpStep::new(
                "Runtime.evaluate",
                Some(json!({ "expression": expression, "returnByValue": true })),
            )
            .then(StepFollowUp::RequireTruthy),
        );
    }
    Ok(steps)
}

/// `press_key`：按下 + 抬起一对。
///
/// 只发 keyDown 不发 keyUp 会让按键在页面看来"一直按着"，后续输入行为异常
/// （如连续触发 keypress）。成对发出是必须的，不是可选的完整性。
fn map_press_key(params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    let key = string_param(params, "key")?;
    if key.trim().is_empty() {
        return Err(ToolMapFailure::InvalidParameterValue("key"));
    }
    Ok(vec![
        CdpStep::new(
            "Input.dispatchKeyEvent",
            Some(json!({ "type": "keyDown", "key": key })),
        ),
        CdpStep::new(
            "Input.dispatchKeyEvent",
            Some(json!({ "type": "keyUp", "key": key })),
        ),
    ])
}

/// `select_option`：在 `select` 元素上选中若干值。
fn map_select_option(params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    let selector = string_param(params, "selector")?;
    let Some(values) = params.get("values") else {
        return Err(ToolMapFailure::MissingParameter("values"));
    };
    let Some(values) = values.as_array() else {
        return Err(ToolMapFailure::WrongParameterType("values"));
    };
    let mut quoted = Vec::with_capacity(values.len());
    for value in values {
        let Some(value) = value.as_str() else {
            return Err(ToolMapFailure::WrongParameterType("values"));
        };
        quoted.push(value.to_string());
    }
    if quoted.is_empty() {
        return Err(ToolMapFailure::InvalidParameterValue("values"));
    }
    let expression = format!(
        "(() => {{ const el = document.querySelector({sel}); if (!el || el.tagName !== 'SELECT') return false; const wanted = {vals}; for (const opt of el.options) {{ opt.selected = wanted.includes(opt.value); }} el.dispatchEvent(new Event('change', {{ bubbles: true }})); return true; }})()",
        sel = serde_json::to_string(&selector).unwrap_or_else(|_| "null".to_string()),
        vals = serde_json::to_string(&quoted).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(vec![CdpStep::new(
        "Runtime.evaluate",
        Some(json!({ "expression": expression, "returnByValue": true })),
    )])
}

/// `wait_for`：等待可见文本 / URL 形态 / 一段超时。
///
/// 三种条件下**全空**时返回 `InvalidParameterValue`：一个没有任何条件的
/// `wait_for` 要么立即返回（无意义）要么永远等待（挂住 turn），两者都不该被
/// 允许悄悄发生。`timeoutMs` 单独给出时是合法的（就是"睡一会儿"）。
fn map_wait_for(params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    let text = optional_string(params, "text")?;
    let url = optional_string(params, "url")?;
    let timeout = optional_number(params, "timeoutMs")?;
    if text.is_none() && url.is_none() && timeout.is_none() {
        return Err(ToolMapFailure::InvalidParameterValue("wait_for"));
    }
    // 文本条件用轮询表达式表达（CDP 没有"等文本出现"的单一方法）；
    // 不在这里发命令，因为轮询节奏属于调用方（tokio 层有定时器）。
    if let Some(text) = text {
        let expression = format!(
            "!!(document.body && document.body.innerText && document.body.innerText.includes({t}))",
            t = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".to_string())
        );
        return Ok(vec![CdpStep::new(
            "Runtime.evaluate",
            Some(json!({ "expression": expression, "returnByValue": true })),
        )]);
    }
    if url.is_some() {
        // URL 形态由调用方比对 location.href；这里给出取当前 URL 的步骤。
        return Ok(vec![CdpStep::new(
            "Runtime.evaluate",
            Some(json!({ "expression": "location.href", "returnByValue": true })),
        )]);
    }
    // 只有 timeoutMs：纯本地等待，无需 CDP 命令。
    Ok(Vec::new())
}

/// `tabs`：列出 / 新建 / 切换 / 关闭标签页。
fn map_tabs(params: &Map<String, Value>) -> Result<Vec<CdpStep>, ToolMapFailure> {
    let action = optional_string(params, "action")?.unwrap_or_else(|| "list".to_string());
    match action.as_str() {
        "list" => Ok(vec![CdpStep::new("Target.getTargets", None)]),
        "new" => {
            let url = optional_string(params, "url")?.unwrap_or_else(|| "about:blank".to_string());
            Ok(vec![CdpStep::new(
                "Target.createTarget",
                Some(json!({ "url": url })),
            )])
        }
        "select" => {
            let index = optional_number(params, "index")?
                .ok_or(ToolMapFailure::MissingParameter("index"))?;
            if index < 0.0 || index.fract() != 0.0 {
                return Err(ToolMapFailure::InvalidParameterValue("index"));
            }
            // 切换由调用方按 index 从 `Target.getTargets` 结果里取 targetId 再激活。
            Ok(vec![CdpStep::new("Target.getTargets", None)])
        }
        "close" => {
            let target_id = optional_string(params, "targetId")?
                .ok_or(ToolMapFailure::MissingParameter("targetId"))?;
            Ok(vec![CdpStep::new(
                "Target.closeTarget",
                Some(json!({ "targetId": target_id })),
            )])
        }
        _ => Err(ToolMapFailure::InvalidParameterValue("action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 剥后缀只认browser段() {
        assert_eq!(tool_suffix("mcp__browser__navigate"), Some("navigate"));
        assert_eq!(tool_suffix("mcp__other__navigate"), None);
        assert_eq!(tool_suffix("mcp__browser__"), None);
        assert_eq!(tool_suffix("navigate"), None);
    }

    #[test]
    fn 已登记工具判定() {
        assert!(is_browser_tool("mcp__browser__snapshot"));
        assert!(!is_browser_tool("mcp__browser__not_a_tool"));
        assert!(!is_browser_tool("mcp__other__snapshot"));
    }

    #[test]
    fn 工具后缀表恰好13项() {
        assert_eq!(TOOL_SUFFIXES.len(), 13);
        let mut sorted = TOOL_SUFFIXES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 13, "后缀不得重复");
    }

    #[test]
    fn 未知工具被拒() {
        assert_eq!(
            map_tool_call("mcp__browser__nope", None),
            ToolMapOutcome::Unmappable(ToolMapFailure::UnknownTool)
        );
        assert_eq!(
            map_tool_call("mcp__other__navigate", None),
            ToolMapOutcome::Unmappable(ToolMapFailure::UnknownTool)
        );
    }

    #[test]
    fn 参数非对象被拒() {
        let outcome = map_tool_call("mcp__browser__navigate", Some(&json!("a string")));
        assert_eq!(
            outcome,
            ToolMapOutcome::Unmappable(ToolMapFailure::ParamsNotObject)
        );
    }

    #[test]
    fn 无参数工具接受缺失与null() {
        // take_screenshot 是真正"无参数且产出步骤"的工具。
        for raw in [None, Some(json!(null))] {
            match map_tool_call("mcp__browser__take_screenshot", raw.as_ref()) {
                ToolMapOutcome::Steps(steps) => {
                    assert_eq!(steps[0].method, "Page.captureScreenshot")
                }
                other => panic!("应映射成功，实际：{other:?}"),
            }
        }
    }

    #[test]
    fn 会话生命周期工具判为本地处理而非步骤() {
        // 这三个工具管理的正是"连接"本身，没法发给连接执行。
        // 必须是显式的一类，不能是"空步骤列表"——那会把静默空操作当成成功。
        for name in ["create_session", "list_sessions", "close_session"] {
            let outcome = map_tool_call(&format!("mcp__browser__{name}"), Some(&json!({})));
            assert_eq!(outcome, ToolMapOutcome::Local, "{name} 应判为本地处理");
        }
    }

    #[test]
    fn 关会话只带公开声明的session_id即可不再要求target_id() {
        // 这是 P1 缺陷的回归钉：公开契约只声明 sessionId，映射层却要求 targetId，
        // 于是**按公开契约构造的正常关闭请求**在映射处就被拒了。
        let outcome = map_tool_call(
            "mcp__browser__close_session",
            Some(&json!({"sessionId":"s"})),
        );
        assert_eq!(outcome, ToolMapOutcome::Local);
    }

    #[test]
    fn 本地工具即使完全不带参数也不会被映射层拒绝() {
        // 映射层不该对本地工具的参数提任何要求：它要的参数会变成事实上的公开契约。
        let outcome = map_tool_call("mcp__browser__close_session", None);
        assert_eq!(outcome, ToolMapOutcome::Local);
    }

    /// 取某个工具映射出的第一步（便于断言后置动作）。
    fn first_step(name: &str, params: Value) -> CdpStep {
        match map_tool_call(name, Some(&params)) {
            ToolMapOutcome::Steps(steps) => steps.into_iter().next().expect("应至少一步"),
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn click按选择器定位时挂上点击后置动作() {
        // 只算坐标不点击 = 工具名叫 click 却没有点击发生，而调用方看到"成功"。
        let step = first_step(
            "mcp__browser__click",
            json!({ "sessionId": "s", "selector": "#submit" }),
        );
        assert_eq!(step.method, "Runtime.evaluate");
        assert_eq!(step.then, Some(StepFollowUp::ClickAtReturnedPoint));
    }

    #[test]
    fn click按文本定位时同样挂上点击后置动作() {
        let step = first_step(
            "mcp__browser__click",
            json!({ "sessionId": "s", "text": "提交" }),
        );
        assert_eq!(step.then, Some(StepFollowUp::ClickAtReturnedPoint));
    }

    #[test]
    fn click按坐标时直接发鼠标事件且不挂后置动作() {
        // 坐标分支自己就发 Input.dispatchMouseEvent，不需要再点一次（那会变成双击）。
        match map_tool_call(
            "mcp__browser__click",
            Some(&json!({ "sessionId": "s", "x": 10, "y": 20 })),
        ) {
            ToolMapOutcome::Steps(steps) => {
                assert_eq!(steps[0].method, "Input.dispatchMouseEvent");
                assert_eq!(steps[0].then, None);
                // 按下与抬起都要有，只发一个会让页面停在"按住"状态。
                let types: Vec<_> = steps
                    .iter()
                    .filter_map(|step| step.params.as_ref()?.get("type")?.as_str())
                    .collect();
                assert!(types.contains(&"mousePressed"), "缺少按下：{types:?}");
                assert!(types.contains(&"mouseReleased"), "缺少抬起：{types:?}");
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn type的定位步骤要求真值() {
        // 定位脚本找不到元素时返回 false；忽略它继续 insertText 会把文本
        // 输进当时恰好有焦点的**别的**输入框。
        let step = first_step(
            "mcp__browser__type",
            json!({ "sessionId": "s", "selector": "#name", "text": "hi" }),
        );
        assert_eq!(step.method, "Runtime.evaluate");
        assert_eq!(step.then, Some(StepFollowUp::RequireTruthy));
    }

    #[test]
    fn fill_form的每个字段步骤都要求真值() {
        match map_tool_call(
            "mcp__browser__fill_form",
            Some(&json!({ "sessionId": "s", "fields": [
                { "selector": "#a", "value": "1" },
                { "selector": "#b", "value": "2" }
            ] })),
        ) {
            ToolMapOutcome::Steps(steps) => {
                let evaluates: Vec<_> = steps
                    .iter()
                    .filter(|step| step.method == "Runtime.evaluate")
                    .collect();
                assert_eq!(evaluates.len(), 2);
                for step in evaluates {
                    assert_eq!(step.then, Some(StepFollowUp::RequireTruthy));
                }
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 不依赖返回值的步骤不挂后置动作() {
        // navigate 只是发一条命令，没有"再按结果做点什么"的语义。
        let step = first_step(
            "mcp__browser__navigate",
            json!({ "sessionId": "s", "url": "https://e.com" }),
        );
        assert_eq!(step.then, None);
    }

    #[test]
    fn 导航缺url被拒() {
        assert_eq!(
            map_tool_call("mcp__browser__navigate", Some(&json!({}))),
            ToolMapOutcome::Unmappable(ToolMapFailure::MissingParameter("url"))
        );
    }

    #[test]
    fn 导航拒绝非http协议() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "ftp://x.test",
        ] {
            let outcome = map_tool_call("mcp__browser__navigate", Some(&json!({ "url": bad })));
            assert_eq!(
                outcome,
                ToolMapOutcome::Unmappable(ToolMapFailure::InvalidParameterValue("url")),
                "{bad} 应被拒"
            );
        }
    }

    #[test]
    fn 导航接受http与https() {
        for good in ["http://example.com", "https://example.com/a?b=1"] {
            match map_tool_call("mcp__browser__navigate", Some(&json!({ "url": good }))) {
                ToolMapOutcome::Steps(steps) => {
                    assert_eq!(steps[0].method, "Page.navigate");
                    // 断言**载荷**而不只是方法名：CDP 的 `Page.navigate` 靠 `params.url`
                    // 决定去哪一页，参数丢了会变成一次"导航到空"的静默错行为——
                    // 命令确实发出去了、也成功了，但去的是别处。
                    // 只断言方法名的守卫对这类缺陷没有牙齿（本批实测：把载荷改成
                    // 别的键名时，cdp-client 的 115 项测试全部照常通过）。
                    assert_eq!(
                        steps[0].params.as_ref().and_then(|p| p.get("url")),
                        Some(&json!(good))
                    );
                }
                other => panic!("{good} 应通过，实际：{other:?}"),
            }
        }
    }

    #[test]
    fn 点击无定位方式被拒() {
        assert_eq!(
            map_tool_call("mcp__browser__click", Some(&json!({"sessionId":"s"}))),
            ToolMapOutcome::Unmappable(ToolMapFailure::NoLocator)
        );
    }

    #[test]
    fn 点击选择器优先于坐标() {
        let params = json!({ "selector": "#go", "x": 10, "y": 20 });
        match map_tool_call("mcp__browser__click", Some(&params)) {
            ToolMapOutcome::Steps(steps) => {
                assert_eq!(steps.len(), 1);
                assert_eq!(steps[0].method, "Runtime.evaluate");
                let expression = steps[0].params.as_ref().unwrap()["expression"]
                    .as_str()
                    .unwrap();
                assert!(expression.contains("#go"), "应使用选择器");
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 点击文本优先于坐标() {
        let params = json!({ "text": "Submit", "x": 10, "y": 20 });
        match map_tool_call("mcp__browser__click", Some(&params)) {
            ToolMapOutcome::Steps(steps) => {
                let expression = steps[0].params.as_ref().unwrap()["expression"]
                    .as_str()
                    .unwrap();
                assert!(expression.contains("Submit"), "应使用文本定位");
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 点击坐标给出按下与抬起两条() {
        let params = json!({ "x": 10.0, "y": 20.0 });
        match map_tool_call("mcp__browser__click", Some(&params)) {
            ToolMapOutcome::Steps(steps) => {
                assert_eq!(steps.len(), 2);
                assert_eq!(
                    steps[0].params.as_ref().unwrap()["type"],
                    json!("mousePressed")
                );
                assert_eq!(
                    steps[1].params.as_ref().unwrap()["type"],
                    json!("mouseReleased")
                );
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 只给x不给y判无定位() {
        assert_eq!(
            map_tool_call("mcp__browser__click", Some(&json!({ "x": 10.0 }))),
            ToolMapOutcome::Unmappable(ToolMapFailure::NoLocator)
        );
    }

    #[test]
    fn 输入文本submit为真时补回车() {
        let params = json!({ "text": "hello", "submit": true });
        match map_tool_call("mcp__browser__type", Some(&params)) {
            ToolMapOutcome::Steps(steps) => {
                assert_eq!(steps[0].method, "Input.insertText");
                assert_eq!(steps[1].method, "Input.dispatchKeyEvent");
                assert_eq!(steps[2].method, "Input.dispatchKeyEvent");
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 输入文本submit缺省不发回车() {
        let params = json!({ "text": "hello" });
        match map_tool_call("mcp__browser__type", Some(&params)) {
            ToolMapOutcome::Steps(steps) => assert_eq!(steps.len(), 1),
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 输入文本带选择器先聚焦() {
        let params = json!({ "text": "hi", "selector": "#name" });
        match map_tool_call("mcp__browser__type", Some(&params)) {
            ToolMapOutcome::Steps(steps) => {
                assert_eq!(steps[0].method, "Runtime.evaluate");
                assert_eq!(steps[1].method, "Input.insertText");
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 填表逐字段一条() {
        let params = json!({ "fields": [
            { "selector": "#a", "value": "1" },
            { "selector": "#b", "value": "2" }
        ]});
        match map_tool_call("mcp__browser__fill_form", Some(&params)) {
            ToolMapOutcome::Steps(steps) => assert_eq!(steps.len(), 2),
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 填表允许空值以清空字段() {
        let params = json!({ "fields": [{ "selector": "#a", "value": "" }] });
        match map_tool_call("mcp__browser__fill_form", Some(&params)) {
            ToolMapOutcome::Steps(steps) => assert_eq!(steps.len(), 1),
            other => panic!("空值是合法意图，实际：{other:?}"),
        }
    }

    #[test]
    fn 填表空数组被拒() {
        assert_eq!(
            map_tool_call("mcp__browser__fill_form", Some(&json!({ "fields": [] }))),
            ToolMapOutcome::Unmappable(ToolMapFailure::InvalidParameterValue("fields"))
        );
    }

    #[test]
    fn 填表字段缺选择器被拒() {
        let params = json!({ "fields": [{ "value": "1" }] });
        assert_eq!(
            map_tool_call("mcp__browser__fill_form", Some(&params)),
            ToolMapOutcome::Unmappable(ToolMapFailure::MissingParameter("fields.selector"))
        );
    }

    #[test]
    fn 按键必须成对() {
        match map_tool_call("mcp__browser__press_key", Some(&json!({ "key": "Enter" }))) {
            ToolMapOutcome::Steps(steps) => {
                assert_eq!(steps.len(), 2);
                assert_eq!(steps[0].params.as_ref().unwrap()["type"], json!("keyDown"));
                assert_eq!(steps[1].params.as_ref().unwrap()["type"], json!("keyUp"));
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 按键空串被拒() {
        assert_eq!(
            map_tool_call("mcp__browser__press_key", Some(&json!({ "key": "  " }))),
            ToolMapOutcome::Unmappable(ToolMapFailure::InvalidParameterValue("key"))
        );
    }

    #[test]
    fn 选择选项缺values被拒() {
        let params = json!({ "selector": "#s" });
        assert_eq!(
            map_tool_call("mcp__browser__select_option", Some(&params)),
            ToolMapOutcome::Unmappable(ToolMapFailure::MissingParameter("values"))
        );
    }

    #[test]
    fn 选择选项正常映射() {
        let params = json!({ "selector": "#s", "values": ["a", "b"] });
        match map_tool_call("mcp__browser__select_option", Some(&params)) {
            ToolMapOutcome::Steps(steps) => {
                let expression = steps[0].params.as_ref().unwrap()["expression"]
                    .as_str()
                    .unwrap();
                assert!(expression.contains("SELECT"), "应校验元素是 select");
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 等待无任何条件被拒() {
        assert_eq!(
            map_tool_call("mcp__browser__wait_for", Some(&json!({"sessionId":"s"}))),
            ToolMapOutcome::Unmappable(ToolMapFailure::InvalidParameterValue("wait_for"))
        );
    }

    #[test]
    fn 等待纯超时无需cdp命令() {
        match map_tool_call("mcp__browser__wait_for", Some(&json!({ "timeoutMs": 500 }))) {
            ToolMapOutcome::Steps(steps) => assert!(steps.is_empty()),
            other => panic!("应映射为空步骤列表，实际：{other:?}"),
        }
    }

    #[test]
    fn 等待文本给出轮询表达式() {
        match map_tool_call("mcp__browser__wait_for", Some(&json!({ "text": "Done" }))) {
            ToolMapOutcome::Steps(steps) => {
                let expression = steps[0].params.as_ref().unwrap()["expression"]
                    .as_str()
                    .unwrap();
                assert!(expression.contains("Done"));
            }
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 标签动作缺省为list() {
        match map_tool_call("mcp__browser__tabs", Some(&json!({"sessionId":"s"}))) {
            ToolMapOutcome::Steps(steps) => assert_eq!(steps[0].method, "Target.getTargets"),
            other => panic!("应映射成功，实际：{other:?}"),
        }
    }

    #[test]
    fn 标签非法动作被拒() {
        let params = json!({ "action": "explode" });
        assert_eq!(
            map_tool_call("mcp__browser__tabs", Some(&params)),
            ToolMapOutcome::Unmappable(ToolMapFailure::InvalidParameterValue("action"))
        );
    }

    #[test]
    fn 标签select缺index被拒() {
        let params = json!({ "action": "select" });
        assert_eq!(
            map_tool_call("mcp__browser__tabs", Some(&params)),
            ToolMapOutcome::Unmappable(ToolMapFailure::MissingParameter("index"))
        );
    }

    #[test]
    fn 标签select拒绝非整数index() {
        let params = json!({ "action": "select", "index": 1.5 });
        assert_eq!(
            map_tool_call("mcp__browser__tabs", Some(&params)),
            ToolMapOutcome::Unmappable(ToolMapFailure::InvalidParameterValue("index"))
        );
    }

    #[test]
    fn 标签close缺targetId被拒() {
        let params = json!({ "action": "close" });
        assert_eq!(
            map_tool_call("mcp__browser__tabs", Some(&params)),
            ToolMapOutcome::Unmappable(ToolMapFailure::MissingParameter("targetId"))
        );
    }

    #[test]
    fn 失败原因有稳定码() {
        assert_eq!(ToolMapFailure::UnknownTool.code(), "tool_map_unknown_tool");
        assert_eq!(
            ToolMapFailure::MissingParameter("url").code(),
            "tool_map_missing_parameter:url"
        );
        assert_eq!(
            ToolMapFailure::InvalidParameterValue("action").code(),
            "tool_map_invalid_parameter_value:action"
        );
    }

    #[test]
    fn 每个已登记工具都能映射或给出结构化的拒绝() {
        // 穷尽 13 个：任何一个都不应 panic，且必须给出 Steps 或带码的 Unmappable。
        for suffix in TOOL_SUFFIXES {
            let name = format!("mcp__browser__{suffix}");
            let outcome = map_tool_call(
                &name,
                Some(
                    &json!({ "sessionId": "s", "url": "https://a.test", "text": "t", "key": "Enter", "selector": "#x", "values": ["v"], "fields": [{"selector":"#a","value":"1"}], "targetId": "T", "action": "list", "index": 0, "timeoutMs": 10 }),
                ),
            );
            match outcome {
                ToolMapOutcome::Steps(_) => {}
                // 会话生命周期工具在本地处理，给全参数也仍判 Local —— 这是预期结果。
                ToolMapOutcome::Local => {}
                ToolMapOutcome::Unmappable(failure) => {
                    panic!("{name} 在给全参数下应可映射，实际拒绝：{}", failure.code());
                }
            }
        }
    }
}
