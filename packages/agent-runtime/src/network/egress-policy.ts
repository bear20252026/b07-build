// packages/agent-runtime/src/network/egress-policy.ts
// 一个文件=一种作用：出网目标的公网边界判定（主机名归一化 + IP 字面量公网校验）。
//
// 移植自 ZCode v3.15.1（Apache-2.0）：
//   - apps/zcode-cli/packages/contracts/src/network/public-egress-ip.ts
//   - apps/zcode-cli/packages/core/src/tool/handlers/webfetch-egress-guard.ts
// 上游用 ipaddr.js 做字面量解析；本实现改为只依赖 node:net 的 BlockList，
// 并把 NAT64/DNS64 与 IPv4-mapped 的私网还原写成显式的等价子网。
// 来源与差异见 THIRD-PARTY-NOTICES.md。

import { BlockList, isIP } from 'node:net';

export type IpAddressVersion = 0 | 4 | 6;

export interface PublicEgressIpBlockReason {
  readonly reason: string;
  readonly version: IpAddressVersion;
}

export interface PublicEgressDecision {
  readonly allowed: boolean;
  /** 归一化后的主机名（小写、去方括号、去末尾点）。 */
  readonly hostname: string;
  /** 被拒绝的原因；允许时为 undefined。 */
  readonly reason?: string;
}

interface BlockedIpRange {
  readonly address: string;
  readonly family: 'ipv4' | 'ipv6';
  readonly prefix: number;
  readonly reason: string;
}

/**
 * 非公网目标的地址段。
 *
 * `198.18.0.0/15` 与 `100::/64`、`2001:2::/48` 这类 special-use 前缀，
 * 在部分地址库（含 ipaddr.js）里会被归类成 unicast，必须显式排除。
 */
const BLOCKED_IP_RANGES: readonly BlockedIpRange[] = [
  { address: '0.0.0.0', family: 'ipv4', prefix: 8, reason: 'unspecified IPv4 address' },
  { address: '10.0.0.0', family: 'ipv4', prefix: 8, reason: 'private IPv4 address' },
  { address: '127.0.0.0', family: 'ipv4', prefix: 8, reason: 'loopback IPv4 address' },
  { address: '100.64.0.0', family: 'ipv4', prefix: 10, reason: 'carrier-grade NAT IPv4 address' },
  { address: '169.254.0.0', family: 'ipv4', prefix: 16, reason: 'link-local IPv4 address' },
  { address: '172.16.0.0', family: 'ipv4', prefix: 12, reason: 'private IPv4 address' },
  { address: '192.168.0.0', family: 'ipv4', prefix: 16, reason: 'private IPv4 address' },
  { address: '192.0.0.0', family: 'ipv4', prefix: 24, reason: 'IETF protocol assignment IPv4 address' },
  { address: '198.18.0.0', family: 'ipv4', prefix: 15, reason: 'benchmark IPv4 address' },
  { address: '224.0.0.0', family: 'ipv4', prefix: 4, reason: 'multicast IPv4 address' },
  { address: '240.0.0.0', family: 'ipv4', prefix: 4, reason: 'reserved IPv4 address' },
  { address: '::', family: 'ipv6', prefix: 128, reason: 'unspecified IPv6 address' },
  { address: '::1', family: 'ipv6', prefix: 128, reason: 'loopback IPv6 address' },
  { address: 'fc00::', family: 'ipv6', prefix: 7, reason: 'unique-local IPv6 address' },
  { address: 'fe80::', family: 'ipv6', prefix: 10, reason: 'link-local IPv6 address' },
  { address: 'ff00::', family: 'ipv6', prefix: 8, reason: 'multicast IPv6 address' },
  { address: '64:ff9b:1::', family: 'ipv6', prefix: 48, reason: 'local-use NAT64 IPv6 address' },
  { address: '100::', family: 'ipv6', prefix: 64, reason: 'discard-only IPv6 address' },
  { address: '2001:2::', family: 'ipv6', prefix: 48, reason: 'benchmark IPv6 address' },
  { address: '2001:10::', family: 'ipv6', prefix: 28, reason: 'ORCHID IPv6 address' },
  { address: '2001:20::', family: 'ipv6', prefix: 28, reason: 'ORCHIDv2 IPv6 address' },
];

/** IPv4-mapped IPv6 前缀 `::ffff:0:0/96` 的长度。 */
const IPV4_MAPPED_PREFIX_LENGTH = 96;
/** NAT64 / DNS64 well-known 前缀 `64:ff9b::/96` 的长度。 */
const DNS64_WELL_KNOWN_PREFIX_LENGTH = 96;

interface CompiledRange extends BlockedIpRange {
  readonly blockList: BlockList;
}

const BLOCKED_RANGES: readonly CompiledRange[] = BLOCKED_IP_RANGES.map((range) => {
  const blockList = new BlockList();
  blockList.addSubnet(range.address, range.prefix, range.family);
  if (range.family === 'ipv4') {
    // 同一个私网 IPv4 段会以三种写法到达这里：点分十进制、IPv4-mapped IPv6、
    // 以及 NAT64/DNS64 well-known 前缀承载。三者都必须命中同一条策略，
    // 否则 `[::ffff:127.0.0.1]` 或 `[64:ff9b::7f00:1]` 就能绕过私网阻断。
    blockList.addSubnet(
      `::ffff:${range.address}`,
      IPV4_MAPPED_PREFIX_LENGTH + range.prefix,
      'ipv6',
    );
    blockList.addSubnet(
      `64:ff9b::${range.address}`,
      DNS64_WELL_KNOWN_PREFIX_LENGTH + range.prefix,
      'ipv6',
    );
  }
  return { ...range, blockList };
});

/**
 * 主机名归一化：去空白、转小写、去方括号、去末尾点。
 *
 * 末尾点必须去掉——`https://127.0.0.1./` 与 `https://localhost./` 在 URL 解析后
 * 仍然带着点，不归一化就会绕过本机判定。
 */
export function normalizeEgressHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets.endsWith('.') ? withoutBrackets.slice(0, -1) : withoutBrackets;
}

/** `localhost` 及其任意子域（`foo.localhost`）都算本机。 */
export function isLocalEgressHostname(hostname: string): boolean {
  const normalized = normalizeEgressHostname(hostname);
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

/** 主机名是否是 IP 字面量（IPv4 或 IPv6）。 */
export function isEgressIpLiteral(hostname: string): boolean {
  return isIP(normalizeEgressHostname(hostname)) !== 0;
}

/** IP 字面量的公网阻断原因；公网地址返回 undefined，非 IP 返回 version 0。 */
export function getPublicEgressIpBlockReason(
  value: string,
): PublicEgressIpBlockReason | undefined {
  const normalized = normalizeEgressHostname(value);
  const version = isIP(normalized) as IpAddressVersion;
  if (version === 0) {
    return { reason: 'not an IP address', version };
  }
  const family = version === 4 ? 'ipv4' : 'ipv6';
  for (const range of BLOCKED_RANGES) {
    if (range.blockList.check(normalized, family)) {
      return { reason: range.reason, version };
    }
  }
  return undefined;
}

/**
 * 判定一个主机名是否允许出网。
 *
 * 只做 URL 字面量层面的判定，不对普通域名做本地 DNS 解析：DNS preflight
 * 在部分网络下无法在合理时间内完成，会让公网目标在真正发起请求前失败。
 */
export function evaluatePublicEgressHost(hostname: string): PublicEgressDecision {
  const normalized = normalizeEgressHostname(hostname);
  if (!normalized) {
    return { allowed: false, hostname: normalized, reason: 'empty hostname' };
  }
  if (isLocalEgressHostname(normalized)) {
    return { allowed: false, hostname: normalized, reason: 'local hostname' };
  }
  if (!isEgressIpLiteral(normalized)) {
    return { allowed: true, hostname: normalized };
  }
  const blocked = getPublicEgressIpBlockReason(normalized);
  if (blocked) {
    return { allowed: false, hostname: normalized, reason: blocked.reason };
  }
  return { allowed: true, hostname: normalized };
}

/** 判定一个 URL 的出网目标是否落在公网。 */
export function evaluatePublicEgressUrl(url: URL): PublicEgressDecision {
  return evaluatePublicEgressHost(url.hostname);
}

export class PublicEgressError extends Error {
  readonly hostname: string;
  readonly reason: string;

  constructor(hostname: string, reason: string) {
    super(`出网目标被拒绝：${reason}（${hostname}）`);
    this.name = 'PublicEgressError';
    this.hostname = hostname;
    this.reason = reason;
  }
}

/** 断言 URL 的出网目标落在公网，否则抛出 `PublicEgressError`。 */
export function assertPublicEgressUrl(url: URL): void {
  const decision = evaluatePublicEgressUrl(url);
  if (!decision.allowed) {
    throw new PublicEgressError(decision.hostname, decision.reason ?? 'not public');
  }
}
