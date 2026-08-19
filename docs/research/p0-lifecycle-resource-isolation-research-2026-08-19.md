# P0 调研：本地 Agent 生命周期、资源隔离与沙箱

**作者：Manus AI**

**日期：2026-08-19**

## 结论

P0 不应把当前 `ExtensionHostBudget` 继续表述为已生效的跨平台硬资源限制。正确的实现是定义 **资源隔离能力分级**：所有平台均实施启动期限、主动 kill/wait/reap、进程状态审计和预算请求记录；只有 host 明确检测到可用隔离后端时，才将 memory/CPU/process 限制标为 `enforced`。否则标为 `observed` 或 `unavailable` 并按默认拒绝策略阻断要求硬限制的执行。

| 平台/后端 | 建议能力 | 安全语义 |
| --- | --- | --- |
| Linux cgroup v2 | 由管理员预先委托的根目录下创建每 run leaf cgroup；配置 memory、cpu、pids，写入 PID，收集 events 后删除。 | cgroup 限制是层级收紧，子级不能突破父级限制；不在应用内提权、挂载或重新配置 controller。 |
| Windows | 后续由独立 Windows Job Object adapter 负责 CPU/memory/process limits 与关闭时回收。 | 未实现时不得假装限制已强制。 |
| macOS | 后续采用受限 container/sandbox 或可观测软预算；不将 `setrlimit` 的部分能力误称为完整 sandbox。 | 未有可靠强隔离时维持 metadata/审批阶段，不启动高风险制品。 |
| Container backend | 后续由 Rust Host 选择受审 Docker/Podman profile；默认网络无出口、根文件系统只读、删除 capabilities、无 new privileges、工作区最小只读/可写 mount。 | Gateway 与 native plugin 仍在 host 信任边界；container 不是万能安全边界。 |

OpenClaw 的公开 sandbox 文档明确区分 Gateway 与被 sandbox 的 tool execution，并展示按 agent/session scope、network、workspace access、read-only root、capability drop 分层配置。这与 AI Work OS 的“manifest 不执行、policy/approval 决定运行”模型可兼容，但不能照搬其 elevated 或 unattended 执行路径。[1]

Rust 标准库提醒 `Child` 不会在 drop 时自动 wait；长期运行的 supervisor 必须显式 kill/wait/reap 以避免僵尸进程。当前 Host 的阻塞 stdout `read_line` 应替换为能按 deadline 取消/回收的 I/O 边界；在简化的同步版本中，先将读取责任移出全局 supervisor mutex，并在 deadline 触发时终止和回收 child。[2]

Linux cgroup v2 可以层级组织进程并控制资源；控制器设置只能由已经获得父级授权的层级进一步收紧。因此 v1 首版只允许写入运行前通过 operator 显式配置的 delegated root，绝不由 AI Work OS 动态 mount、sudo 或修改系统 controller 配置。[3]

## P0 实施原则

1. **先诚实，后强化。** 所有 budget snapshot 增加 enforcement 级别；没有隔离后端即不是 enforced。
2. **先回收，后功能。** 每个超时、健康失败、关闭、Gateway 停止都必须 close stdin、kill、wait/reap 并记录最终状态。
3. **先会话隔离，后共享。** 运行身份以 extension/revision/session/run 组成；默认无网络、无 workspace、无额外挂载。
4. **先 CI，后规模化。** 生命周期和拒绝路径的测试、Clippy、架构检查必须在主分支自动运行。

## References

[1] [OpenClaw Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)

[2] [Rust `std::process::Child`](https://doc.rust-lang.org/std/process/struct.Child.html)

[3] [Linux Kernel: Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

## Windows 后端补充

Windows Job Object 可以把进程组作为一个管理单元；默认情况下子进程也归入 job，并可以在 job close 时通过 `KILL_ON_JOB_CLOSE` 终止所有关联进程。其扩展限制提供 per-process/job memory limit，CPU rate control 的 hard cap 会在调度周期内阻止线程继续运行。因此 Windows adapter 可以成为 P0 的真实资源**限制**后端，但仍不是文件系统、网络或令牌权限 sandbox，必须与 policy、workspace access 和后续 container/sandbox backend 组合。[4] [5] [6]

[4] [Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

[5] [Microsoft: JOBOBJECT_EXTENDED_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)

[6] [Microsoft: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information)
