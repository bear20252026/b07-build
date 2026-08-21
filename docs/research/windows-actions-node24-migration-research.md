# Windows 来源证明：Node 20 → Node 24 Action 运行时迁移调研

**日期：** 2026-08-21
**作者：** Manus AI

## 结论

GitHub Actions 日志中的“Node.js 20 is deprecated… forced to run on Node.js 24”是 **Action 自身 JavaScript 运行时** 的平台迁移提示，并不表示项目构建命令使用了 Node 20，也不表示 Windows Setup.exe 候选构建失败。本项目 `windows-desktop-shell-provenance.yml` 已通过 `actions/setup-node@v4` 显式为项目命令配置 **Node 24**；提示来源是 `checkout@v4`、`setup-node@v4`、`upload-artifact@v4` 这类旧主版本 Action 的内部 Node 20 runtime。

GitHub 官方公告指出：Node 20 在 2026 年 4 月 EOL；自 2026 年 6 月 16 日，runner 默认采用 Node 24，Node 20 会在 2026 年秋季从 runner 移除。官方面向 Action 用户的建议是把工作流更新为“运行在 Node 24 的最新 Action 版本”。[1]

当前官方 README 说明 `actions/checkout@v5` 已升级 Node 24 runtime，且 checkout v7 为最新示例；`actions/setup-node@v5` 已升级 Node 24，v7 是当前最新示例；`actions/upload-artifact` README 的当前示例为 v7。[2] [3] [4]

## 兼容策略

| 项目 | 当前 | 最小更新建议 | 原因 |
| --- | --- | --- | --- |
| 项目命令 Node | `setup-node@v4` + `node-version: 24` | 保持 Node 24。 | 已与 runner 默认迁移目标一致。 |
| checkout | `actions/checkout@v4` | 升级到当前官方维护的 Node 24 runtime 主版本，并保留 `contents: read` 最小权限。 | 消除 v4 的内部 Node 20 运行时提示。 |
| setup-node | `actions/setup-node@v4` | 升级到 Node 24 runtime 主版本，保持 `node-version: 24`、npm cache 与 lockfile 语义。 | 项目 Node 与 Action 内部 runtime 一致。 |
| upload-artifact | `actions/upload-artifact@v4` | 升级到当前官方 Node 24 runtime 主版本；保持隐藏文件默认不上传和 `if-no-files-found: error`。 | 维持不可变安装器候选交付，不放宽 artifact 范围。 |

不要设置 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true`：它只是临时继续 Node 20 的不安全退出开关，与长期 Windows 发布链维护目标相反。

## References

[1]: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/ "GitHub：Deprecation of Node 20 on GitHub Actions runners"
[2]: https://github.com/actions/checkout "actions/checkout README"
[3]: https://github.com/actions/setup-node "actions/setup-node README"
[4]: https://github.com/actions/upload-artifact "actions/upload-artifact README"
