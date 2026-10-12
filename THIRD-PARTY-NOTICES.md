# Third-Party Notices

本仓库直接移植（vendored）了以下第三方源码。除下列声明外，其余代码为本仓库原创。

## ZCode（Apache License 2.0）

- 来源仓库：https://github.com/bear20252026/ZCode （`main` 分支）
- 许可证：Apache License 2.0（全文见上游仓库 `LICENSE`；本仓库未随附副本，使用时请遵循上游许可条款）
- 移植文件与上游出处：

| 本仓库文件 | 上游出处 | 相对上游的差异 |
| --- | --- | --- |
| `packages/agent-runtime/src/code-editing/patch-parser.ts` | `apps/zcode-cli/packages/core/src/tool/patch-parser.ts` | 仅引号风格与注释本地化，解析语义不变 |
| `packages/agent-runtime/src/code-editing/patch-apply.ts` | `apps/zcode-cli/packages/core/src/tool/patch-apply.ts` | 新增：CRLF 与末尾换行保留、匹配严格度（strict）外显 |
| `packages/agent-runtime/src/code-editing/patch-policy.ts`（部分逻辑） | 上游 apply_patch 工具的路径处理思路 | 本仓库新写的第一期策略层：仅更新已存在文件、路径逃逸拒绝、重复目标拒绝 |

移植文件头部均带有出处注释。对上游代码的修改遵循 Apache-2.0 的再分发条款（保留许可与版权声明、标注修改）。
