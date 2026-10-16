// 一个文件=一种作用：Hook 信任判定与准入过滤（纯函数，零副作用）。
//
// 两个导出：
// - `evaluateHookTrust()` —— 单条 Hook 的信任判定
// - `withHookTrust()` —— 把判定做成 `HookSelector` 的组合装饰器
//
// ## 为什么判定是纯函数
//
// 与 `permission-chain.ts` 同款理由：判定会被每次工具调用前执行，不确定性会让
// "为什么这次被拦了"无法复现。因此本模块**不读时钟、不碰存储、不发事件**——
// 记录与吊销集合由调用方注入，判定只做纯计算。
//
// ## 为什么准入用装饰器而非改执行器
//
// `hook-executor.ts` 的四条纪律（顺序执行 / 阻塞即停 / 改写叠加 / 异常即阻塞）
// 讲的是"Hook 跑起来之后怎么协同"；信任判定讲的是"Hook 该不该跑"。两件事混在一个
// 函数里会让两者都难以独立测试。而 `HookSelector` 是函数签名，装饰器能零侵入地
// 插进 `controlled-tool-runner` 的现有调用——不接入时行为逐字节不变。

import type { HookRegistration } from './hook-contract.js';
import type { HookSelector } from './hook-executor.js';
import {
  type HookTrustDecisionInput,
  type HookTrustEvaluation,
  type HookTrustRecord,
  type HookTrustSource,
} from './hook-trust-contract.js';

/**
 * 信任键：`workspaceIdentity \0 declarationDigest`（内存中的规范形式）。
 *
 * 用 NUL 分隔而非 `:` 或 `/`，是因为工作区身份与摘要都可能含这些字符——
 * 用可出现的字符作分隔符会让 `a:b` + `c` 与 `a` + `b:c` 撞成同一个键。
 * NUL 不可能出现在路径或摘要中，因此是内存表示里唯一安全的连接符。
 *
 * ⚠️ **落库前必须经 [`encodeHookTrustKey`]**：SQLite 的 TEXT 绑定在 NUL 处**截断**
 * （实测写入 32 字符读回 11 字符），裸用本键会让"同工作区的不同摘要"塌缩成同一个
 * 键——授权与吊销都会串线。`SqliteHookTrustStore` 已在内部做这个转换。
 */
export function hookTrustKey(workspaceIdentity: string, declarationDigest: string): string {
  return `${workspaceIdentity}\u0000${declarationDigest}`;
}

/**
 * 把信任键编码为可安全落库的字符串。
 *
 * 规则：NUL → `\u0000` 两字符转义序列 `\\0`，反斜杠自身转义为 `\\\\`。
 * 这样编码后**不含 NUL**，SQLite 不会再截断；且映射是单射（转义反斜杠在前，
 * 故 `\\0` 不会被误读成"原本的反斜杠 + 0"），可无损还原。
 */
export function encodeHookTrustKey(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/\u0000/g, '\\0');
}

/** 还原 [`encodeHookTrustKey`] 的编码。非法输入返回 undefined（fail-closed）。 */
export function decodeHookTrustKey(encoded: string): string | undefined {
  let out = '';
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = encoded[i + 1];
    if (next === '\\') {
      out += '\\';
      i += 1;
      continue;
    }
    if (next === '0') {
      out += '\u0000';
      i += 1;
      continue;
    }
    // 未知转义序列：拒绝而非猜测，避免把一个畸形键解成另一个合法键。
    return undefined;
  }
  return out;
}

/** 判定单条 Hook 的信任状态。**永不抛异常**——判定失败一律收敛为不可执行。 */
export function evaluateHookTrust(input: HookTrustDecisionInput): HookTrustEvaluation {
  const { source, policy, records, revokedKeys, storeStatus, declarationIndex } = input;
  const key = hookTrustKey(source.workspaceIdentity, source.declarationDigest);

  // 1. 策略全拒优先于一切（紧急刹车必须能刹住内置来源）。
  if (policy.mode === 'deny') {
    return {
      state: 'blocked_policy',
      reasonCode: 'denied_by_policy',
      runnable: false,
      explanation: `信任策略为 deny，全部 Hook 不执行（来源：${source.origin}）`,
    };
  }

  // 2. 存储损坏 → 视为全部未授权。宁可让用户重授一次，也不要把损坏的存储
  //    解读成"没有记录所以放行"。
  if (storeStatus === 'corrupt') {
    return {
      state: 'blocked_untrusted',
      reasonCode: 'denied_untrusted_origin',
      runnable: false,
      explanation: '信任存储损坏，已按未授权处理；请修复存储后重新授权',
    };
  }

  // 3. 内置来源免信任。这是唯一的"不需要用户点头"的来源类别——
  //    它随 b07 一起发布，与用户从工作区/远端取来的内容不是同一个信任级。
  if (source.origin === 'builtin') {
    return {
      state: 'trusted_builtin',
      reasonCode: 'builtin_origin',
      runnable: true,
      explanation: 'b07 内置来源，免信任',
    };
  }

  // 4. 显式吊销优先于持久授权：用户说"关掉"就该关掉，即使记录还在。
  if (revokedKeys.has(key)) {
    return {
      state: 'revoked',
      reasonCode: 'revoked_by_user',
      runnable: false,
      explanation: '该 Hook 已被显式吊销，需重新授权后才可执行',
    };
  }

  // 5. 持久授权命中 → 可信。
  const record = records.get(key);
  if (record !== undefined) {
    return {
      state: 'trusted',
      reasonCode: 'persistent_grant',
      runnable: true,
      explanation: `已授权（授权于 ${record.grantedAt}）`,
    };
  }

  // 6. 只读模式：未授权一律拒绝，不给交互授权入口。
  if (policy.mode === 'allow_trusted_only') {
    return {
      state: 'blocked_untrusted',
      reasonCode: 'denied_untrusted_origin',
      runnable: false,
      explanation: `策略为 allow_trusted_only，未授权的 ${source.origin} 来源不执行`,
    };
  }

  // 7. 同位置曾授权但摘要变了 → 陈旧。放在 pending 之前，因为它是更具体的诊断：
  //    "你自己见过这条，但它现在的内容和当时不一样了"。
  if (hasStaleGrant(source, declarationIndex, records.values())) {
    return {
      state: 'stale_digest',
      reasonCode: 'declaration_changed_since_grant',
      runnable: false,
      explanation: `该位置的 Hook 声明在授权后发生了变化（路径：${source.sourcePath}），需重新授权`,
    };
  }

  // 8. 兜底：待用户决定。默认姿态不是拒绝——用户仍有授权入口。
  return {
    state: 'pending',
    reasonCode: 'awaiting_user_decision',
    runnable: false,
    explanation: `来源 ${source.origin} 尚未授权，等待用户决定`,
  };
}

/**
 * 是否存在"同位置但摘要不同"的授权记录。
 *
 * 判据是**位置四元组**（工作区 + 来源路径 + 序号 + 事件），不是路径单独——
 * 同一文件里可以有多条 Hook，只比对路径会把"文件里新增了一条"误报成"某条被替换"。
 * 位置相同而摘要不同，才是真正的"内容被换掉"。
 */
function hasStaleGrant(
  source: HookTrustSource,
  declarationIndex: number,
  records: Iterable<HookTrustRecord>,
): boolean {
  for (const record of records) {
    if (record.workspaceIdentity !== source.workspaceIdentity) continue;
    // 摘要相同说明是当前这条自己（已在上一步命中），跳过。
    if (record.declarationDigest === source.declarationDigest) continue;
    if (record.sourcePathAtGrant !== source.sourcePath) continue;
    if (record.indexAtGrant !== declarationIndex) continue;
    return true;
  }
  return false;
}

/**
 * 判定本次调用**是否需要向用户展示授权入口**。
 *
 * `pending` 与 `stale_digest` 需要；其余不需要（要么已经能跑、要么是硬拒绝）。
 * 与 `runnable` 分开，因为"要问用户"和"能不能跑"是两个不同的问题——
 * `blocked_policy` 既不能跑也不该问，`stale_digest` 不能跑但**该问**（且要提醒内容变了）。
 */
export function needsUserDecision(evaluation: HookTrustEvaluation): boolean {
  return evaluation.state === 'pending' || evaluation.state === 'stale_digest';
}

/**
 * 是否允许对该来源批量授权。
 *
 * 除策略开关外，**`remote` 与 `builtin` 恒不允许**：
 * - `remote` 是最不可控的来源，批量授权等于把防线交给远端内容；
 * - `builtin` 本来就免信任，不需要批授权。
 */
export function canBatchGrant(
  origin: HookTrustSource['origin'],
  policy: { readonly allowWorkspaceBatchGrant: boolean },
): boolean {
  if (origin === 'builtin' || origin === 'remote') return false;
  return policy.allowWorkspaceBatchGrant;
}

/**
 * 把信任判定包装成 `HookSelector` 装饰器。
 *
 * 用法：
 * ```ts
 * const selector = withHookTrust(baseSelector, {
 *   resolveSource: (registration) => sourceOf(registration),
 *   policy: DEFAULT_HOOK_TRUST_POLICY,
 *   records, revokedKeys, storeStatus,
 * });
 * ```
 *
 * **未提供 `resolveSource` 返回值时一律不可执行**（fail-closed）：拿不到来源就无从判定
 * 信任，此时放行等于把防线交给"配置没写对"。这条与 `isToolReadOnlyWith` 的
 * "描述符缺失 → 视为写入"同款纪律。
 *
 * @param base 基础选择器（通常是 `registry.matching`）。
 * @param options 判定所需的来源解析与策略数据。
 * @returns 过滤后的选择器。返回值只含**已通过判定**的 Hook，保持原顺序。
 */
export function withHookTrust(
  base: HookSelector,
  options: {
    readonly resolveSource: (
      registration: HookRegistration,
    ) => { readonly source: HookTrustSource; readonly declarationIndex: number } | undefined;
    readonly policy: HookTrustDecisionInput['policy'];
    readonly records: ReadonlyMap<string, HookTrustRecord>;
    readonly revokedKeys: ReadonlySet<string>;
    readonly storeStatus: HookTrustDecisionInput['storeStatus'];
    /** 可选：观察每次拒绝，用于遥测/UI。**同步调用，不得抛异常外溢**。 */
    readonly onDenied?: (
      registration: HookRegistration,
      evaluation: HookTrustEvaluation,
    ) => void;
  },
): HookSelector {
  return (event, toolName) => {
    const candidates = base(event, toolName);
    const admitted: HookRegistration[] = [];

    for (const registration of candidates) {
      const resolved = options.resolveSource(registration);
      if (resolved === undefined) {
        // fail-closed：无法确定来源 → 不执行。
        options.onDenied?.(registration, {
          state: 'blocked_untrusted',
          reasonCode: 'denied_untrusted_origin',
          runnable: false,
          explanation: '无法解析该 Hook 的来源，按未授权处理',
        });
        continue;
      }

      const evaluation = evaluateHookTrust({
        source: resolved.source,
        policy: options.policy,
        records: options.records,
        revokedKeys: options.revokedKeys,
        storeStatus: options.storeStatus,
        declarationIndex: resolved.declarationIndex,
      });

      if (evaluation.runnable) {
        admitted.push(registration);
      } else {
        options.onDenied?.(registration, evaluation);
      }
    }

    return admitted;
  };
}
