// 一个文件=一种作用：Hook 信任域契约（来源、信任状态、策略与准入类型）。
//
// ## 为什么需要这一层
//
// `hook-contract/hook-registry/hook-executor` 三件套补上了"可注册的扩展点"，但它们是
// **无条件执行**的：`HookRegistry.register()` 只校验 id 唯一与 `when` 语法，不校验"这条
// Hook 从哪来、值不值得执行"。而 Hook 是**任意代码执行面**——一旦某条 Hook 的 handler
// 来自工作区（比如克隆下来的第三方仓库自带的配置），无条件执行等于把"读了别人的代码"
// 升级成"跑了别人的代码"。
//
// 本模块补的就是这层准入：**先判定来源可信，再决定是否放进执行清单**。
//
// ## 设计来源与许可
//
// 设计研读自 ZCode v3.15.1（Apache-2.0）的 `apps/zcode-cli/packages/core/src/hooks/`
// 下 9 个 `workspace-hook-*.ts`（信任协调 / 信任域 / 信任评估 / 信任记录 / 策略 /
// 运行时准入 / 审查流 / 遥测）。上游为 Apache-2.0，与本仓库（MIT）兼容，但本模块
// **未复制其任何代码**——不复制文件、不逐行翻译、不沿用其命名（`WorkspaceHookTrust*`
// 等一律重新命名），只研读其设计约束并按 b07 形态重写。详见 `THIRD-PARTY-NOTICES.md`。
//
// ## 从上游学到的三条关键设计
//
// 1. **信任的粒度是"声明"而非"文件"**：上游用 `hookDeclarationDigest`（声明摘要）而非
//    路径做信任键。理由是同一路径的内容可以被替换——若按路径信任，攻击者只要覆盖文件
//    就能沿用旧信任。本模块沿用：**内容变了，信任自动失效**。
// 2. **信任要能被"吊销"且有"陈旧"态**：上游区分 `revoked`（显式吊销）与
//    `stale_digest`（同位置但内容变了）。两者都不可执行，但诊断含义不同——前者是"你
//    主动关掉了"，后者是"有东西偷偷换了内容"。本模块沿用这个区分。
// 3. **默认不是"信任"也不是"全拒"，而是"待用户决定"**：上游默认策略是
//    `user_decides`。这是安全性与可用性的正确折中——全自动信任等于没有防线，全拒则
//    让 hook 机制形同虚设。本模块沿用。
//
// ## 与 b07 既有能力的边界
//
// 不与 `security-posture-audit`（姿态审计，回答"当前安全配置是什么"）重叠：那个是**只读
// 报告**，本模块是**执行前的准入判定**。也不与 `taint-policy`（污点传播）重叠：那个管
// 数据流，本模块管代码来源。

/**
 * 信任判定所需的来源信息。
 *
 * 刻意只有四个字段：工作区身份、声明摘要、来源路径、来源类别。**不含 handler 本身**——
 * 信任判定只看"这条 Hook 从哪来、内容是什么"，不看它做什么。理由是 handler 是不可静态
 * 分析的黑盒，试图"审查 handler 代码"来判定信任是自欺；可靠的做法是判定来源 + 要求
 * 用户显式授权。
 */
export interface HookTrustSource {
  /** 工作区身份（如项目根路径的规范化形式）。空串表示"无工作区上下文"。 */
  readonly workspaceIdentity: string;
  /**
   * Hook 声明的内容摘要（形如 `sha256:<hex>`）。
   *
   * **这是信任键的一半，也是防替换的核心**：同一条 Hook 声明的内容一旦变化，摘要就变，
   * 已授予的信任不再命中，该 Hook 退回"待决定"。
   */
  readonly declarationDigest: string;
  /** 声明来源的可读路径，用于诊断与用户审查展示。 */
  readonly sourcePath: string;
  /**
   * 来源类别。决定默认姿态：
   * - `builtin` —— b07 自身内置，**免信任**（等同于可信根）
   * - `workspace` —— 工作区自带（第三方仓库常见），**必须显式授权**
   * - `user` —— 用户级配置（如用户主目录下的全局配置），**必须显式授权**
   * - `remote` —— 远端来源，**必须显式授权**，且不允许批量授权
   */
  readonly origin: HookTrustOrigin;
}

export type HookTrustOrigin = 'builtin' | 'workspace' | 'user' | 'remote';

/** 来源类别闭集（顺序即文档顺序，供 UI 稳定遍历）。 */
export const HOOK_TRUST_ORIGINS = [
  'builtin',
  'workspace',
  'user',
  'remote',
] as const satisfies readonly HookTrustOrigin[];

export function isHookTrustOrigin(value: string): value is HookTrustOrigin {
  return (HOOK_TRUST_ORIGINS as readonly string[]).includes(value);
}

/**
 * 一条 Hook 的信任状态。
 *
 * 六态，每个都可执行性明确。**除 `trusted` 外一律不可执行**——这是 fail-closed 的落点。
 */
export type HookTrustState =
  /** 已通过显式授权（持久记录命中）。唯一可执行态。 */
  | 'trusted'
  /** b07 内置来源，免信任。唯一另一个可执行态。 */
  | 'trusted_builtin'
  /** 尚未授权。**默认姿态**——等用户决定，不是拒绝。 */
  | 'pending'
  /** 策略显式拒绝（如企业策略 `deny`，或来源类别被禁）。 */
  | 'blocked_policy'
  /** 来源不可信且策略不允许交互授权（如远端来源在无人值守场景）。 */
  | 'blocked_untrusted'
  /** 显式吊销。 */
  | 'revoked'
  /**
   * 陈旧：同一位置（来源路径 + 序号）曾授权过，但**当前声明摘要与授权时不同**。
   * 与 `pending` 的区别是诊断含义——`pending` 是"没见过"，`stale` 是"见过但内容变了"，
   * 后者是可疑信号，值得在 UI 上更醒目。
   */
  | 'stale_digest';

/** 信任状态闭集。 */
export const HOOK_TRUST_STATES = [
  'trusted',
  'trusted_builtin',
  'pending',
  'blocked_policy',
  'blocked_untrusted',
  'revoked',
  'stale_digest',
] as const satisfies readonly HookTrustState[];

export function isHookTrustState(value: string): value is HookTrustState {
  return (HOOK_TRUST_STATES as readonly string[]).includes(value);
}

/** 决策原因码，用于稳定诊断（不随文案变化）。 */
export type HookTrustReasonCode =
  | 'builtin_origin'
  | 'persistent_grant'
  | 'awaiting_user_decision'
  | 'denied_by_policy'
  | 'denied_untrusted_origin'
  | 'revoked_by_user'
  | 'declaration_changed_since_grant';

/**
 * 信任策略模式。
 *
 * 与 ZCode 的 `user_decides` / `allow_trusted_only` / `deny` 同构，但 b07 额外收紧了
 * `user_decides` 的批授权边界（见 `HookTrustPolicy.allowBatchGrant`）。
 */
export type HookTrustPolicyMode =
  /** 默认：未授权者进入待决定，由用户逐条或批量授权。 */
  | 'user_decides'
  /** 只允许已持久授权者执行；未授权者直接拒绝，**不给交互授权入口**（无人值守场景）。 */
  | 'allow_trusted_only'
  /** 全部拒绝（紧急刹车）。连内置来源也不执行。 */
  | 'deny';

export interface HookTrustPolicy {
  readonly mode: HookTrustPolicyMode;
  /**
   * 是否允许对 `workspace` 来源批量授权。
   *
   * **默认 false，且这是有意的**：批量授权把"逐条审查"降级为"一键信任整个工作区"，
   * 而工作区内容恰好是最不可控的输入。b07 保留该开关是因为大仓库逐个点确实痛苦，
   * 但要求调用方**显式打开**——默认不提供这条捷径。
   *
   * `remote` 来源**无论如何都不允许批量授权**（见 `canBatchGrant`）。
   */
  readonly allowWorkspaceBatchGrant: boolean;
  /** 策略版本标识，进入诊断，便于排查"为什么当时允许了"。 */
  readonly policyRevision: string;
}

/** 默认策略：待用户决定，不允许工作区批量授权。 */
export const DEFAULT_HOOK_TRUST_POLICY: HookTrustPolicy = Object.freeze({
  mode: 'user_decides',
  allowWorkspaceBatchGrant: false,
  policyRevision: 'builtin:user-decides:v1',
});

/**
 * 一条持久化的信任记录——即"用户曾授权过这条 Hook"的证据。
 *
 * 记录里冗余存了**授权时**的来源快照（路径、序号），不是为了判定（判定只用摘要），
 * 而是为了在内容变化后能回答"它当时是从哪来的、变成了什么"——没有这组字段，
 * `stale_digest` 就只能报"变了"，报不出"从哪变到哪"。
 */
export interface HookTrustRecord {
  readonly workspaceIdentity: string;
  readonly declarationDigest: string;
  /** 授权时的来源路径。 */
  readonly sourcePathAtGrant: string;
  /** 授权时该声明在其来源文件中的序号，用于识别"同位置被替换"。 */
  readonly indexAtGrant: number;
  /** 授权时间（ISO 8601）。 */
  readonly grantedAt: string;
  /** 授权时的应用版本，便于排查"某版本引入的授权是否仍适用"。 */
  readonly appVersionAtGrant?: string;
}

/** 一条 Hook 的评估结果。 */
export interface HookTrustEvaluation {
  readonly state: HookTrustState;
  readonly reasonCode: HookTrustReasonCode;
  /** 是否允许执行。**仅 `trusted` 与 `trusted_builtin` 为 true**。 */
  readonly runnable: boolean;
  /** 人类可读的说明，用于 UI 与诊断。 */
  readonly explanation: string;
}

/** 信任存储的读取状态——存储损坏必须能被区分于"没有记录"。 */
export type HookTrustStoreStatus =
  | 'missing'
  | 'ok'
  /** 存储损坏。**按 fail-closed 处理：视为全部未授权**。 */
  | 'corrupt';

/**
 * 判定一次运行时准入用的完整输入。
 */
export interface HookTrustDecisionInput {
  readonly source: HookTrustSource;
  readonly policy: HookTrustPolicy;
  /** 已持久化的授权记录（按信任键索引）。 */
  readonly records: ReadonlyMap<string, HookTrustRecord>;
  /** 显式吊销的信任键集合。 */
  readonly revokedKeys: ReadonlySet<string>;
  readonly storeStatus: HookTrustStoreStatus;
  /** 该声明在其来源文件中的序号，用于 `stale_digest` 的同位置比对。 */
  readonly declarationIndex: number;
}
