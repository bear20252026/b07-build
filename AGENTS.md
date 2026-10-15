# AGENTS.md —— 架构治理与协作约定

本文件是仓库的**协作契约**，不是教程。改动架构前先读这里。

## 1. spec-first：先改策略，再改代码

模块边界的事实源是 **`architecture-policy.yaml`**，不是某个脚本里的硬编码规则。

要新增模块、放宽或收紧依赖、把某个模块从 legacy 提升为受管，**先改策略文件**，
再改代码，最后跑检查。反过来（先写代码、再想办法让检查闭嘴）在本仓库是不接受的。

```
architecture-policy.yaml      ← 声明：模块、roots、managed、requires、publicEntrypoints、owner
.architecture-baseline.json   ← 存量违规白名单（只压制已登记项）
dependency-graph.mmd          ← 由策略 + 真实依赖生成的产物，请勿手工编辑
```

## 2. 检查怎么跑

```bash
npm run architecture:check      # CI 与 npm test 用的总入口
npm run architecture:policy     # 只跑策略检查（依赖边界 / 循环 / 深引用）
npm run architecture:policy:report   # 输出 JSON 结果，便于排查
npm run architecture:graph      # 重新生成 dependency-graph.mmd
npm run architecture:graph:check     # 校验依赖图产物是否与当前依赖一致
npm run architecture:baseline:update # 把当前违规写入基线（仅在明确要接纳存量时使用）
```

`npm test` 会先跑 `architecture:check`，所以本地 `npm test` 全绿 == CI 的架构门全绿。

## 3. 规则语义

| 规则 | 含义 | 怎么修 |
| --- | --- | --- |
| `module-dependency` | 模块 A import 了模块 B，但 A 的 `requires` 没声明 B | 要么在策略里声明依赖，要么改代码不依赖 |
| `deep-import` | 跨模块引用了对方**非公开入口**的文件 | 改走 `publicEntrypoints` 里声明的入口 |
| `cycle` | 受管模块之间出现循环依赖 | 拆依赖方向；必要时抽出更底层的模块 |
| `missing-module-root` | 策略里声明的 `roots` 目录不存在 | 修策略或恢复目录 |

`managed: true` 的模块受上述强校验；`managed: false` 是**存量 legacy**，只记录依赖关系、
不阻塞（对应策略文件头的设计意图：存量先标 legacy，迁移完成的再设 `managed: true`）。

## 4. 基线：只对「新增」违规失败

`.architecture-baseline.json` 是存量违规白名单。检查结果按**稳定指纹**与基线比对，
只有指纹不在基线里的违规才让 `architecture:check` 失败。

指纹 = `sha256(规则 \0 仓库相对路径 \0 detail)` 取前 16 位十六进制。它**不含行号、不含绝对路径**，因此：

- 同一文件里违规上下移动，不会造成基线漂移；
- 换机器、换工作目录，不会造成基线漂移；
- 文件被移动或改名视为真实变更，需要显式更新基线（这是刻意的）。

接纳存量违规时用 `npm run architecture:baseline:update`，并在 PR 里说明为什么接纳。
**不要**通过放宽策略或注释掉规则来让检查变绿。

## 5. 提交与评审约定

- 每个批次一个分支，从 `origin/main` 起；不直接提交 `main`。
- 提交信息用中文，写清「做了什么、修了什么、怎么验证的」。
- 合并前必须全绿：
  ```bash
  npm run typecheck
  npm run typecheck --workspace=@awo/workbench   # 工作台 React 面，根 tsc -b 覆盖不到
  npm test                                       # 含 architecture:check
  ```
  改了 Rust 的话再加：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`。
- 移植上游（ZCode，Apache-2.0）代码时，必须在 `THIRD-PARTY-NOTICES.md` 的表格里
  补一行：本仓库文件 / 上游出处 / 相对上游差异。
- **不要**在测试夹具里写形似真实密钥的高熵字面量（CI 有 gitleaks 密钥扫描门）。
