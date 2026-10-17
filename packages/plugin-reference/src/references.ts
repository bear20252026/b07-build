// 插件 @ 引用的**严格**解析。
//
// ## 为什么"严格"是这层的全部意义
//
// 用户消息里的 `@某插件` 会变成一条 Markdown 链接，其中的 destination 被当作**插件身份**。
// 身份一旦可以被伪造或误读，后果不是"引用错了插件"，而是**模型被告知它有某些能力** ——
// 而能力提示会直接影响它下一步调什么工具。所以这里的每一条限制都不是洁癖：
//
// - **身份只来自 destination，label 永不参与。**
//   `[my-plugin@official](plugin://evil@attacker)` 这种写法里，人眼看到的是可信名字、
//   机器读到的却是另一个插件。只要 label 参与任何判定，这种欺骗就成立。
// - **协议名大小写敏感**（只接受小写 `plugin://`）。大小写变体不是"宽容"，是两套语义：
//   接受它等于让 `Plugin://` 与 `plugin://` 都能进，而下游只按其中一种做过滤。
// - **不做隐式 percent-decoding**。`%2F`、`%40` 解码后才判断，等于先信任再检查；
//   而"先信任再检查"在安全上是没有检查。
// - **段级字符集即完整边界**。`name@marketplace` 两段都限死在 `[A-Za-z0-9][A-Za-z0-9._-]*`，
//   query / fragment / credentials / 空白 / 控制字符 / `%` 全都不在这个集合里，一律拒绝。
//
// ## 与 ZCode 的关系
//
// 形态照搬 ZCode `@zcode/core` 的 `plugin-reference/references.ts`：同样的 Markdown 链接
// 语法、同样的 stable-id 规则、同样的单轮上限与三类计数（引用 / 截断 / 非法）。
// b07 的插件 id 本来就叫 `${name}@${marketplace}`（见 `InstalledPluginRecord`），
// 所以这套规则是**直接适用**的，不需要改格式。
//
// 一处刻意的差别：ZCode 把"意图命中但解析失败"单独计数（`invalidCount`），b07 保留它 ——
// 这个数字是"有人在试 `Plugin://` 或带 query 的写法"的唯一信号，丢掉它就没法发现这类输入。

/** 协议前缀。**只接受小写**。 */
const PLUGIN_REFERENCE_SCHEME = 'plugin://';

/**
 * Markdown 链接：`[label](destination)`。
 *
 * 与 ZCode 同一条正则：label 支持 `\` 转义，destination 支持 `<...>` 或裸形式。
 * 用 `matchAll` 而不是 `exec` 循环，避免 `lastIndex` 残留导致"同一条消息第二次解析结果不同"。
 */
const MARKDOWN_LINK_PATTERN = /\[(?:\\.|[^\\\]])*\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)\s])*))\)/g;

/** 单段字符集：首字符是字母数字，其余允许 `._-`。 */
const PLUGIN_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 单轮最多认多少个引用。超出的按"截断"计数，不静默丢弃。 */
export const MAX_PLUGIN_REFERENCES_PER_TURN = 8;

/** stable id 总长上限。 */
const MAX_PLUGIN_STABLE_ID_LENGTH = 256;

/**
 * 校验一个候选字符串是否为严格合法的插件 stable id（`name@marketplace`）。
 *
 * 同时用于解析侧与输出侧的防御：reminder 在把 id 写进上下文之前会**再验一次**，
 * 因为它的输入可能来自别处（续跑、回放、外部调用）。输出侧不复用解析侧的信任，
 * 是"不可信数据要反复验"的最低要求。
 */
export function isValidPluginStableId(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_PLUGIN_STABLE_ID_LENGTH) return false;
  const separatorIndex = candidate.indexOf('@');
  // 必须**恰好一个** `@` 且不在开头：`a@b@c` 与 `@b` 都不是合法身份。
  if (separatorIndex <= 0 || separatorIndex !== candidate.lastIndexOf('@')) return false;
  const name = candidate.slice(0, separatorIndex);
  const marketplace = candidate.slice(separatorIndex + 1);
  return PLUGIN_ID_SEGMENT_PATTERN.test(name) && PLUGIN_ID_SEGMENT_PATTERN.test(marketplace);
}

/** 解析一个 destination；不是合法插件引用时返回 `null`。 */
function parsePluginDestination(destination: string): string | null {
  // 大小写敏感：`Plugin://` 不算合法引用（但会计入 invalidCount，见下）。
  if (!destination.startsWith(PLUGIN_REFERENCE_SCHEME)) return null;
  const stableId = destination.slice(PLUGIN_REFERENCE_SCHEME.length);
  return isValidPluginStableId(stableId) ? stableId : null;
}

/**
 * 这个 destination 是不是**意图上**想引用插件？
 *
 * 大小写不敏感：`Plugin://`、`PLUGIN://` 都算"想引用但写法不对"，
 * 计入 invalidCount 而不是被当成无关链接。**不能**用它决定是否接受 ——
 * 它只用于统计，避免 label 欺骗绕过诊断。
 */
function isPluginSchemeIntent(destination: string): boolean {
  return /^plugin:\/\//i.test(destination);
}

/** 解析结果。 */
export interface ExtractPluginReferencesResult {
  /** 按正文首次出现顺序、按 stable id 去重后的引用。 */
  readonly references: readonly string[];
  /** 超过单轮上限被丢弃的次数（调用方应记日志，而不是当作没发生）。 */
  readonly truncatedCount: number;
  /** 意图命中插件协议但格式不合法的次数。 */
  readonly invalidCount: number;
}

/**
 * 从用户文本里提取插件引用。
 *
 * 去重保序：同一个插件被引用多次只算一次，位置取**首次出现**——
 * 顺序会影响 reminder 里的预算分配，所以不能让它取决于 Map 的迭代顺序。
 */
export function extractPluginReferences(input: string): ExtractPluginReferencesResult {
  const references: string[] = [];
  const seen = new Set<string>();
  let truncatedCount = 0;
  let invalidCount = 0;

  for (const match of input.matchAll(MARKDOWN_LINK_PATTERN)) {
    // `<...>` 形式在 match[1]，裸形式在 match[2]。
    const destination = match[1] ?? match[2] ?? '';
    if (!isPluginSchemeIntent(destination)) continue;
    const stableId = parsePluginDestination(destination);
    if (stableId === null) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(stableId)) continue;
    if (references.length >= MAX_PLUGIN_REFERENCES_PER_TURN) {
      truncatedCount += 1;
      continue;
    }
    seen.add(stableId);
    references.push(stableId);
  }

  return { references, truncatedCount, invalidCount };
}
