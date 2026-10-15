// 一个文件=一种作用：MCP App 沙箱「来源标识」的派生与校验（P2-3）。
//
// 上游 ZCode 用 Electron 持久化 partition `persist:plugin-sandbox-v2-<sha256(appIdentity)>`
// 让每个插件沙箱拿到**稳定且持久**的 origin（`localStorage`/`IndexedDB` 跨卡片、跨重启保留）。
// b07 没有 Electron partition，但同样需要「同一 app 稳定、不同 app 隔离」的来源标识：
// 来源 = scheme + host（路径不参与 origin），所以把 appIdentity 派生出的稳定标签放进 **host**，
// 路径继续承载 instanceId（既有路由语义不变）。
//
// 本文件只放可单测的纯逻辑：标签/partition 名派生、格式校验、孤儿识别。
// 真正删除 partition 目录、清空存储这类需要原生能力的动作在 b07 无对应实现（见报告「未做」）。
//
// 与上游的差异：上游 `node:crypto` 的 sha256 是同步加密摘要；工作台是浏览器上下文，
// `crypto.subtle.digest` 只有异步形态，而来源派生必须同步（URL 在渲染前即需确定）。
// 故改用纯 TS 的 FNV-1a 64 位（16 个十六进制字符）。appIdentity 来自 Agent 侧可信来源、
// 不接受页面自报（对齐上游注释），此处要的是「稳定且互不相同」的标签而非密码学承诺。

/** 沙箱标签前缀（对齐上游 v2 命名，去掉 Electron 专属的 `persist:`）。 */
export const MCP_APP_SANDBOX_LABEL_PREFIX = 'plugin-sandbox-v2-';

/** 上游同名常量：Electron 持久化 partition 前缀。b07 无 partition，保留以对齐命名与校验。 */
export const MCP_APP_SANDBOX_PARTITION_PREFIX = `persist:${MCP_APP_SANDBOX_LABEL_PREFIX}`;

/** 标签/partition 名的哈希段：FNV-1a 64 位定长 16 个十六进制字符。 */
const SANDBOX_KEY_HEX_LENGTH = 16;

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** FNV-1a 64 位，输出定长小写十六进制（不足补零）。 */
function fnv1a64Hex(input: string): string {
  let hash = FNV1A_64_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(input)) {
    hash = ((hash ^ BigInt(byte)) * FNV1A_64_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(SANDBOX_KEY_HEX_LENGTH, '0');
}

/**
 * 派生 app 的稳定沙箱标签 `plugin-sandbox-v2-<key>`：合法 DNS 标签（小写字母/数字/连字符，
 * 不以连字符开头或结尾，长度 ≤ 63），可直接作为自定义协议 URL 的 host。
 */
export function deriveMcpAppSandboxLabel(appIdentity: string): string {
  return `${MCP_APP_SANDBOX_LABEL_PREFIX}${fnv1a64Hex(appIdentity)}`;
}

/** 派生 app 的稳定 partition 名 `persist:plugin-sandbox-v2-<key>`（对齐上游命名规则）。 */
export function deriveMcpAppSandboxPartition(appIdentity: string): string {
  return `${MCP_APP_SANDBOX_PARTITION_PREFIX}${fnv1a64Hex(appIdentity)}`;
}

/** 校验 partition 名是否属于本方案（对齐上游「按前缀正则识别沙箱 partition」的做法）。 */
export function isMcpAppSandboxPartition(name: string): boolean {
  return new RegExp(`^${MCP_APP_SANDBOX_PARTITION_PREFIX}[a-f0-9]{${SANDBOX_KEY_HEX_LENGTH}}$`).test(name);
}

/**
 * 孤儿识别：给定现存 partition 名与仍活跃的 appIdentity，返回应清理的 partition 名。
 * 只认本方案的 partition；活跃集合按同一派生规则换算，避免误删他方数据。返回升序去重结果。
 */
export function findOrphanMcpAppSandboxPartitions(
  existingPartitions: readonly string[],
  liveAppIdentities: readonly string[],
): string[] {
  const live = new Set(liveAppIdentities.map(deriveMcpAppSandboxPartition));
  return [...new Set(existingPartitions.filter((name) => isMcpAppSandboxPartition(name) && !live.has(name)))].sort();
}
