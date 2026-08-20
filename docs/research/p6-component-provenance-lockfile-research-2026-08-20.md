# P6.2：可激活构件 provenance 与 lockfile 调研

**日期：** 2026-08-20
**状态：** 已完成设计输入调研；本项目不实现安装、下载、签名验证或自动升级，只实现本地 metadata 的受控登记、锁定比对与隔离决策。

## 外部基线

| 来源 | 可复用原则 | 本项目的收敛实现 |
|---|---|---|
| SLSA Provenance v1 | Provenance 使消费者能够判断工件是否按预期构建；resolved dependency 应保留 URI 与 digest；未知/意外的外部参数应被 verifier 拒绝。 | 将构件的 `sourceKind`、受限 `sourceRef`、SHA-256 `contentDigest`、`version`、`licenseId` 和 `reviewStatus` 作为只读登记 metadata；不保存 URL、路径、令牌、签名材料或原文。 |
| in-toto Attestation Framework | 证明是可验证的软件生产声明，消费者据此验证来源并建立供应链信任。 | 使用版本化 `ComponentProvenanceV1` 与 SHA-256 lock digest；该轻量本地契约不宣称具备远程签名/供应链证明能力。 |
| OpenClaw Plugins | 安装等同运行代码，应固定版本；冷路径 manifest/registry 不证明运行时状态；校验失败的 enabled plugin 应在本次启动隔离、其余可继续服务。 | manifest 仍只是 metadata；本阶段绝不安装或激活。已登记构件只有在 reviewed、digest 与当前 lock 一致且未撤销时可生成 `eligible` 决策；不一致一律为 `quarantined`，不会被静默加载或升级。 |

> “Treat plugin installs like running code. Prefer pinned versions for reproducible production installs.” — OpenClaw Plugins 文档。

## P6.2 契约边界

| 维度 | 必须具备 | 明确禁止 |
|---|---|---|
| 构件身份 | 受限 ID、kind、版本、来源类别、来源引用、许可证标识、SHA-256 digest | 任意 URL、绝对路径、凭据、原始 manifest、自由文本安装命令 |
| 评审 | `candidate` / `reviewed` / `revoked` 单向状态；撤销不可恢复 | 由审计、HTTP GET、UI 或 lockfile 自动批准/恢复 |
| 锁定 | 版本化 lock revision；每项绑定 component ID、digest 与 provenance digest；稳定排序后计算 lock digest | 根据 registry、网络或本地路径隐式刷新；静默升级版本或 digest |
| 漂移 | 当前 digest 与 lock digest 不同、缺少 lock、未评审、撤销或 provenance 不匹配时均 `quarantined` | 自动修复、重新安装、重新计算受信任 hash 后继续激活 |
| 控制面 | 领域层作纯决策；SQLite WAL append-only 账本；Gateway 只读报告；Workbench 仅观测 | 路由直接创建 DB、UI 直接读 SQLite、审计触发下载/执行/加载 |

## 拟定验收条件

1. 同一组 provenance/lock 输入产生稳定、可回放的 decision 和 drift reason 排序。
2. `reviewed + matching digest + matching provenance + active lock` 才为 `eligible`；其他所有情况均 fail-closed 为 `quarantined`。
3. `revoked` 恒为终态，不能由新 lock、UI 或审计恢复。
4. SQLite 重开后保留 revision 历史，返回防御性副本。
5. Gateway 与 Workbench 严格拒绝可执行字段、URL、路径、秘密或 remediation command。
6. 全量架构、TS、Rust、Python 与依赖审计质量门通过。

## 参考资料

[1]: https://slsa.dev/provenance/v1 "SLSA Provenance v1"
[2]: https://github.com/in-toto/attestation "in-toto Attestation Framework"
[3]: https://docs.openclaw.ai/tools/plugin "OpenClaw Plugins"

[1] [2] [3]
