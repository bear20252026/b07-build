// 一个文件=一种作用：未实现能力的 fail-closed 权限端口。
//
// 语义**对齐** agent-runtime 的 `permission-broker.ts`（「未装配人工入口 =
// 拒绝」，`DenyPermissionBroker` 是缺省实现），不另造一套权限模型：只有
// 「拒绝」这一种缺省，没有 always-allow，也不存在把拒绝改回放行的路径。
//
// 为什么不直接复用 `DenyPermissionBroker`：本包是零依赖的**契约层**（未实现
// 能力的最底层），反向依赖 agent-runtime 会引入环与分层倒置。因此这里以
// **结构兼容**的方式复刻同一纪律——`CapabilityPermissionPort` 与
// `PermissionBroker` 同形（`ask → Promise<boolean>`），任何接受后者的位置
// 都能接受本端口；行为一致性由测试断言（恒拒绝、不抛错）。

/** 一次能力裁决请求（问题字段与 PermissionQuestion 同形的最小子集）。 */
export interface CapabilityPermissionQuestion {
  readonly actionId: string;
  readonly toolName: string;
  /** 决策链给的理由（供人工入口展示，占位端口不读取）。 */
  readonly reason: string;
}

/** 权限端口契约：`true` = 放行，`false` = 拒绝。 */
export interface CapabilityPermissionPort {
  ask(question: CapabilityPermissionQuestion): Promise<boolean>;
}

/**
 * fail-closed 缺省端口：一切裁决请求都以拒绝收尾。
 * 与 agent-runtime 的 `DenyPermissionBroker` 同一纪律——没有人工入口时，
 * 问什么都是拒绝，绝不静默放行。
 */
export class DenyCapabilityPermissionPort implements CapabilityPermissionPort {
  // 问题参数故意不读：拒绝与问什么无关。
  async ask(_question: CapabilityPermissionQuestion): Promise<boolean> {
    return false;
  }
}
