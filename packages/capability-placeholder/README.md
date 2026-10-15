# @awo/capability-placeholder

fail-closed 契约占位包。本构建不含桌面控制 / 计算机使用能力：**每一个运行时面
（计算机使用运行时、能力谓词、权限端口）都报告 unavailable 并失败关闭**，
关于未实现能力的谓词恒为 `false`，权限端口保持隐私 fail-closed 语义
（未装配人工入口 = 拒绝）。

本包是「契约包 + 全拒实现」的占位形态，而非缺席或半成品：调用方现在就能照着
类型写代码，运行期得到明确的 fail-closed 结果，而不是一个偶尔能跑通的半成品
被误当成可用能力。

## 机器可检的占位标记

- `package.json`：`"awoCapabilityPlaceholder": true`
- 运行期：`CAPABILITY_PLACEHOLDER === true`

两者必须一致；「本包仍是占位」由测试断言。任何真正落地能力的批次都必须显式
把标记改为 `false` 并删除对应谓词 / 运行时的拒答路径。

## 出口

| 子路径 | 作用 |
| --- | --- |
| `@awo/capability-placeholder` | 全部契约的聚合出口 |
| `@awo/capability-placeholder/predicates` | 恒 `false` 的能力谓词（单一事实源） |
| `@awo/capability-placeholder/computer-use` | fail-closed 的计算机使用运行时 |
| `@awo/capability-placeholder/permission` | fail-closed 权限端口 |

范式参考 ZCode `@zcode/zcode-cua`（Apache-2.0），出处与差异见根目录
`THIRD-PARTY-NOTICES.md`。
