# Windows Authenticode 证书：获取路径、费用与发布门

**调研日期：** 2026-08-20
**适用项目：** AI Work OS Windows x64 native helper 候选包。

## 结论摘要

Windows 公开分发的 EXE/MSI/MSIX 需要区分三件事：**构建来源证明**（GitHub/SLSA Attestation）、**代码签名**（Authenticode）和 **Windows SmartScreen 声誉**。三者互补但不可互相替代。当前 P6.6 候选包有完整的摘要/SBOM/来源边界，但尚无 Authenticode 签名，因此只能是 `unsigned-candidate`。

| 路径 | 典型公开成本 | 个人开发者可用性 | 私钥位置 | 适合场景 |
|---|---:|---|---|---|
| Microsoft Store + MSIX | 签名由 Store 处理；开发者账户另按 Store 政策 | 广泛可用 | Microsoft 发布链 | 最适合首次公开上架的 MSIX；Store 会重新签名 |
| Azure Artifact Signing | 约 US$9.99/月 | 个人目前限美国/加拿大；组织限美国、加拿大、欧盟、英国 | 云端受管 | 上述地区的站外分发或 CI/CD |
| OV Code Signing（CA） | 约 US$150–300/年为微软给出的典型范围；CA 实价随地区/期限变化 | 全球，具体取决于 CA 身份验证政策 | 合规 USB token 或 HSM | 不适用 Azure 的个人/组织，或有传统 CA 采购需要 |
| EV Code Signing | 约 US$400+/年；实际供应商价格不同 | 全球，验证要求更严格 | 合规 USB token 或 HSM | 有企业采购要求；不应只为 SmartScreen 绕过而购买 |
| 自签名 | 免费 | 仅开发/受管企业内网 | 自有测试证书 | 本机测试，不适合公开分发 |

微软当前明确指出：MSIX 通过 Microsoft Store 发布时会由 Microsoft 自动重新签名；Azure Artifact Signing 约为每月 US$9.99；OV 的典型价格约为每年 US$150–300；EV 约为每年 US$400 起，并且 EV 自 2024 年起不再提供首次下载即时绕过 SmartScreen 的效果。[1]

## 申请流程

1. **先选择分发方式。** 如果目标是 Microsoft Store 的 MSIX，优先申请免费开发者账户并走 Store 发布链；该路径无需自行购买 Authenticode 证书。若要在网站/GitHub 等站外直接发 EXE/ZIP，再选择 Azure Artifact Signing 或 OV。
2. **提交身份材料。** CA/签名服务通常要求验证个人或组织的法律身份、可验证邮箱/域名，以及可验证电话回拨；证书持有人名称会显示为软件发布者。[3]
3. **选择密钥保护方式。** 自 2023 年起，OV 私钥也必须使用合规 HSM 或硬件 token；不能再依赖普通 `.pfx` 文件。Azure 的受管签名服务不需要自备 USB token。[1] [2]
4. **签署候选工件。** 不在本地保存私钥。对 P6.6 helper 和最终分发包进行 SHA-256 Authenticode 签名与时间戳，并使用 `SignTool verify /pa` 验证信任链/签名；SignTool 成功退出码为 0。[4]
5. **绑定证据而不是自动信任。** 将签后的 SHA-256、签名者证书 thumbprint 摘要、时间戳与 GitHub Attestation 记录到 P6.5 release evidence。仍需人工审批才能把 bridge 从 `registered` 变为 `trusted`。

## 与当前项目的最小选择

当前用户尚未说明所在国家/地区、是否以个人还是组织主体申请、是否优先 Microsoft Store。因此，不建议直接购买 EV。对于个人学习项目，建议先保持 P6.6 的 unsigned candidate；若计划上架 Microsoft Store，则优先 MSIX/Store 路径；若要站外公开下载，则再按所在地判断 Azure Artifact Signing 是否可用，否则选 OV。无论路径如何，都不要提交或在聊天中传输 `.pfx`、token PIN、证书私钥或云签名凭据。

## 参考资料

[1]: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options "Code signing options for Windows app developers"
[2]: https://www.digicert.com/signing/compare-code-signing-certificates "Compare code signing certificates"
[3]: https://www.sectigo.com/ssl-certificates-tls/code-signing "Code Signing Certificates"
[4]: https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature "Use SignTool to verify a file signature"

[1] [2] [3] [4]
