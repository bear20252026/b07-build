# 工作区文件回退与 SHA256 CAS 的交互设计

状态：已批准实施

## 1. 问题

ZCode 的 `runtime/methods/file-rewind.ts` 让「回退对话」同时把工作区文件退回当时状态。
b07 的 `DirectConversationCheckpoint` 只存**对话快照**（`use-direct-conversations.ts`），
回退对话**不还原文件**——这是报告 §4.2 认定的真实差异。

报告 §5 把这一项标为「与 SHA256 CAS 模型的交互需先设计，**不是纯移植**」，成本「中（含设计）」。
本文件即那个设计。

### 1.1 为什么不能照抄

b07 的写入模型与 ZCode 不同：

| | ZCode | b07 |
| --- | --- | --- |
| 写入守卫 | `FileSystemPort` 只接受绝对路径，无内容级 CAS | **内容级 CAS**：`workspace-tools.ts` 的 `previousSha256` / `nextSha256`，原生侧 `workspace_approval` 校验后原子消耗票据 |
| 陈旧检测 | 无（`read-file-state.ts` 是 mtime 级，用于编辑前置检测） | 原生比对磁盘摘要，不符即 `workspace-write-approval-stale` |
| 多文件原子性 | 手写 `journal` + `compensateFileRewindJournal` 逆序补偿 | 原生 `workspace_patch` 批次已带 `rollback_from` 与 `rollbackErrors` |

照抄 ZCode 的 `journal` 补偿会在 b07 里**重复实现一个已经存在且已被测试的机制**，
而且是在更弱的一层（TS 侧）实现原生已经做对的回滚。故不移植其补偿逻辑。

## 2. 核心设计决策：回退本身就是一次 CAS 写入

报告点名的冲突是「CAS 的 `previousSha256` 与回退目标状态可能冲突」。解法是把两者的**角色分开**：

```text
回退的目标状态（要写到磁盘上的内容）  = 检查点记录的 before 内容
回退的 CAS 期望值（写之前磁盘必须等于）= 检查点记录的 after  内容
```

即：**`previousSha256` 不来自"刚刚读到的内容"，而来自检查点记录的"我上次写完之后的状态"。**

### 2.1 为什么是这个方向

一次受控写入在 b07 里必然经过 CAS：

```text
读原文 → 用户批准 → 票据绑定 (previousSha256=原文, nextSha256=新文) → 原生校验磁盘仍等于原文 → 写入
```

因此**写入成功后，磁盘内容必然等于 `nextSha256`**。这条不变式是回退的安全前提：
检查点记录里的 `after` 内容，就是"系统已知的最后落盘状态"。

- 若回退时磁盘哈希 **等于** 记录的 after → 自该检查点以来这个文件没有被任何人改过 →
  回退是安全的，可以覆盖。
- 若 **不等于** → 文件在检查点之后被改动过（外部编辑器，或一次本检查点不知道的写入）→
  此时覆盖会**静默丢弃别人的改动**。判定 `external_modified`，**阻断整次回退**。

这正是 ZCode 的 `external_modified` 判据，但 b07 侧它不再需要额外的读文件状态机——
CAS 已经提供了内容级比对所需的全部信息。

### 2.2 复用既有原生面，不新增写入路径

回退的每个操作与原生 `workspace_patch` 的 `PatchOperation` **一一对应**：

| 检查点记录 | 回退操作 | 原生 `PatchOperation` |
| --- | --- | --- |
| `beforeContent === null`（写入前不存在） | `delete` | `{kind:'delete', path, previous_sha256: sha256(afterContent)}` |
| `beforeContent !== null` | `restore` | `{kind:'update', path, previous_sha256: sha256(afterContent), next_content: beforeContent, next_sha256: sha256(beforeContent)}` |

于是回退**直接映射成一次 patch 批次**，从而自动获得：

- **原生 CAS**：`previous_sha256` 不符 → `workspace-write-approval-stale`（每个操作独立校验）；
- **原生回滚**：批次中途失败 → `rollback_from` 逆序还原，`rollbackErrors` 如实上报；
- **审批门**：`workspace_commit_patch` 需要已签发的票据（回退是破坏性动作，要人确认）。

**b07 不新增任何原生写入命令。** 这是本设计与"纯移植"最大的区别。

## 3. 规划器（纯逻辑，零 IO）

`apps/workbench/src/runtime/workspace-file-rewind.ts`（契约在同目录
`workspace-file-rewind-contract.ts`）。按 `memory-recall` 的
「契约 + 纯逻辑 + 注入端口」范式：规划器不读文件、不算哈希，两者都由调用方注入。

```ts
buildWorkspaceFileRewindPlan({ records, reader, hasher }) → FileRewindPlan
```

`FileRewindPlan` 是**可审计的结构体**而非布尔：要能回答"哪些文件会动、哪些被阻断、为什么"。

配套三件（同目录）：

| 文件 | 职责 |
| --- | --- |
| `workspace-file-journal.ts` | 变更日志的**存取**：按会话 append-only，逐字段校验不可信存储 |
| `workspace-file-rewind-client.ts` | 把日志、规划器与原生写入面接起来：完整性闸、映射到原生 patch 操作、两个 IO 适配器 |
| `workspace-tools.ts`（改造） | 写入**成功之后**回调录制器；失败与回滚不留痕 |

### 3.0 为什么放在 workbench 而不是 agent-runtime

第一版按 `memory-recall` 的先例放进了 `packages/agent-runtime`，核对架构策略后**搬回 workbench**。
两条理由：

1. **它服务的对象全在 workbench**：`use-direct-conversations.ts` 的对话检查点、
   `workspace-tools.ts` 的写入路径、以及同目录的变更日志。agent-runtime 侧最近的邻居
   `run-workspace-ledger.ts` 是**只读 metadata 账本**（不变量 #3 明写不能读写文件），
   把文件回退放在它旁边只会造成误解。
2. **架构策略不允许**：`architecture-policy.yaml` 里 workbench 的 `requires` 是
   `[protocol, provider-sdk-browser, capability-placeholder]`，**不含 agent-runtime**。
   为一个纯函数助手放宽一个 managed 模块的依赖面，等于把一次架构决策夹带进功能批次。
   （代价是 `apps/*/test` 不在 tsconfig 覆盖内，该模块的测试文件因此不被类型检查——
   这是**已知的存量缺陷**，有独立修复计划，不在本批夹带。）

### 3.1 逆序模拟（继承自 ZCode，理由不同）

对同一路径的多次写入，**必须从最新一条往回走**：

1. 最新操作的 `after` 应当等于**当前磁盘**内容 → 用磁盘真实状态做 CAS 校验；
2. 校验通过后，把模拟状态置为它的 `before`；
3. 再处理更早一条时，CAS 期望值取该条的 `after`，与**模拟状态**（而非磁盘）比对。

正向走会拿"上一条的 after"去比"磁盘当前值"，第二条起必然误判为 `external_modified`。
走完后模拟状态里留下的是**最早的 before 内容**，正是回退的目标。

### 3.2 阻断粒度：整次阻断，不是逐文件跳过

`canApply = safeFiles.length > 0 && unsafeFiles.length === 0`。

只要有一个文件不安全，`operations` 就返回空数组、整次回退不做。
理由：回退是**一个语义动作**（"把工作区带回那一刻"）。只回退一半会让工作区进入
一个**从未存在过的中间状态**——比不回退更难理解和恢复。宁可整次拒绝并报告原因。

### 3.3 闭集：不安全的原因

| 原因 | 含义 | 处置 |
| --- | --- | --- |
| `external_modified` | 磁盘哈希 ≠ 检查点记录的 after | 阻断，附 `currentSha256` / `expectedSha256` |
| `file_read_failed` | 当前状态读不到 | 阻断（读不到就不能判定，fail-closed） |
| `unsupported_record` | 记录缺可用 after 内容或字段非法 | 阻断（记录来自持久化存储，必须校验） |
| `checkpoint_unreadable` | 检查点/日志本身不可读或不完整 | 阻断。**由调用方补入**（规划器只认识记录与文件状态），见 §3.5 |
| `too_many_operations` | 待回退文件数超过单批上限 32 | 阻断，**不截断** |

### 3.4 单批上限与路径折叠

回退映射成**一个**原生 patch 批次，因此继承批次的两条约束：

- `MAX_BATCH_OPERATIONS = 32`（`workspace_patch.rs`）→ 超过即整次拒绝，**不截断**。
  截断等于部分回退，正是 §3.2 禁止的。
- **同批不允许重复路径** → 同一路径的多次写入必须**折叠成一条**：CAS 期望值取最新一条的
  after（磁盘现状），目标内容取最早一条的 before。折叠不损失信息，因为中间状态本来
  就不需要还原（用户要回到的是检查点那一刻）。

两处常量（`MAX_REWIND_OPERATIONS` 与原生 `MAX_BATCH_OPERATIONS`）由注释交叉引用并由测试钉住；
两边漂移的表现为"规划说可以、提交说不行"，是必须避免的困惑。

### 3.5 完整性闸：不完整就阻断，不留洞

日志可能不完整（丢过记录、配额写失败、结构损坏）。**不能**拿一份不完整的历史去规划：
它会算出一个**漏掉文件的"安全"计划**，用户看到"回退成功"，而工作区并没有回到那一刻 ——
比明确拒绝更危险。

故 `previewWorkspaceFileRewind()` 在交给规划器之前先过一道闸：日志 `unjournalable` 或
`droppedCount > 0` 时，直接返回一个带 `checkpoint_unreadable` 的阻断计划。

对应地，日志本身遵守"**不完整就作废，不留洞**"：单条过大、配额写失败或结构损坏时，
整份日志作废而不是跳过那一条。理由同上 —— 有洞的日志比没有日志更危险。

### 3.4 shell 工具触碰的文件：归入 ignored，不阻断

`bash` / `shell` / `terminal` 类工具对文件的改动**不经 CAS 写入路径**，
系统无从知道它改了什么、改成什么样。这类记录归入 `ignoredFiles`（原因 `shell_ignored`）：
**不阻断**回退，但**如实报告"这些文件没被追踪、不会还原"**。

- 若让它阻断，只要用户跑过一次 `bash`，回退就永远不可用；
- 若静默丢弃，用户会以为工作区完整回到了那一刻，而实际上没有。

两个极端都不可接受，故设为"不阻断 + 显式报告"。

## 4. 不变量

1. 规划器**不读文件、不算哈希、不写文件**；三者均由注入的端口提供。
2. 任一文件不安全 ⇒ `operations` 为空（不产出"部分可执行"的计划）。
3. CAS 期望值**只**取自检查点记录的 after 状态，绝不取自"规划时刚读到的内容"——
   后者会让守卫退化成恒真。
4. 规划器输出与原生 `PatchOperation` 字段一一对应，不做二次翻译。
5. 记录来自持久化存储（localStorage），因此**必须逐字段校验**，非法记录判 `unsupported_record`
   而非抛异常或忽略。
6. 回退不授予任何新权限：它走的是既有审批门与既有 CAS，不改变 profile / authorityMode。

## 5. 未纳入本批（明确记录）

- **UI 接线**：`restoreCheckpoint` 目前只恢复对话。把"文件回退预览 + 确认"接进该流程
  需要产品判断（是否默认还原、如何呈现被阻断的文件、整批只确认一次还是逐文件确认），
  留待下一批。本批交付到 `previewWorkspaceFileRewind()` 为止 —— 它是可直接被 UI 调用的
  导出函数，且已覆盖完整性闸与映射。
- **落盘（apply）**：把 `planToPatchOperations()` 的结果领票并提交，需要先定审批门的产品
  形态（回退是破坏性动作，`workspace_commit_patch` 本身要求票据），故与 UI 同批处理。
- **检查点创建时的文件快照上限**：日志按会话 append-only 且封顶（条数 + 单条大小）；
  跨会话的容量治理策略待定。

## 6. 参考资料

ZCode v3.15.1（Apache-2.0，LICENSE 已核验）`apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts`
（718 行）。本模块**未复制其任何代码**——不复制文件、不逐行翻译、不沿用其命名与注释，
只研读其设计约束（逆序模拟、整次阻断、shell 忽略、不安全原因闭集）并按 b07 形态独立重写，
且**去掉了其 TS 侧 journal 补偿**（b07 原生 `workspace_patch` 已有更强的同款机制）。
