# Third-Party Notices

## agency-agents

This repository includes selected role-definition text derived from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents), copied from the upstream `main` branch for the AI Work OS built-in role catalog.

- Upstream repository: https://github.com/msitarzewski/agency-agents
- Upstream license: MIT License
- Upstream copyright: Copyright (c) 2025 AgentLand Contributors
- Included source files and upstream paths: recorded in `packages/knowledge-workflow/src/third-party/agency-agents/` and the built-in catalog metadata.
- Local adaptation: the original role text is made available only as explicit, non-authorizing Skill Pack candidates. It is not an installed hook, external-tool integration, executable plugin, Provider configuration, or permission grant.

```text
MIT License

Copyright (c) 2025 AgentLand Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## last30days-skill

This repository includes the complete, unmodified source snapshot of [`mvanhorn/last30days-skill`](https://github.com/mvanhorn/last30days-skill) under `third_party/last30days-skill/`.

- Upstream repository: https://github.com/mvanhorn/last30days-skill
- Pinned upstream commit: `d05389d39b2ce09a13f71b01e68562f077c766df`
- Upstream license: MIT License
- Upstream copyright: Copyright (c) 2026 Matt Van Horn
- Full unmodified license text: `third_party/last30days-skill/LICENSE`
- Local modification status: no upstream source-code modifications. AI Work OS integration code, when added, must remain outside this directory.

## last30days-skill-cn

This repository includes the complete, unmodified source snapshot of [`Jesseovo/last30days-skill-cn`](https://github.com/Jesseovo/last30days-skill-cn) under `third_party/last30days-skill-cn/`.

- Upstream repository: https://github.com/Jesseovo/last30days-skill-cn
- Pinned upstream commit: `1a8a04c3c347defbcdbb8da26d7cf1a531426b1f`
- Upstream license: MIT License, as declared by the upstream `LICENSE` file
- Upstream copyright: Copyright (c) 2026 Matt Van Horn (original last30days-skill); Copyright (c) 2026 Jesse (Chinese localization fork: last30days-skill-cn)
- Full unmodified license text: `third_party/last30days-skill-cn/LICENSE`
- Local modification status: no upstream source-code modifications. AI Work OS integration code, when added, must remain outside this directory.

The vendored paths, immutable upstream commit identifiers and source handling rules are also listed in `third_party/UPSTREAM_SOURCES.md`.

## SearXNG

This repository includes the complete, unmodified source snapshot of [`searxng/searxng`](https://github.com/searxng/searxng) in `third_party/searxng-source-9fea41204fdfa7a5cfa15b0ebd12904c520478ce.tar.gz` for the optional local metasearch backend. A Windows-executable mirror at `third_party/searxng-windows/` omits only four upstream web-server socket template filenames containing `:` because Windows Git cannot represent those filenames; they remain verbatim in the complete source archive and are not used by the embedded Python runtime.

- Upstream repository: https://github.com/searxng/searxng
- Pinned upstream commit: `9fea41204fdfa7a5cfa15b0ebd12904c520478ce`
- Upstream license: GNU Affero General Public License v3.0 (AGPL-3.0)
- Full unmodified license text: `third_party/searxng-windows/LICENSE` and `third_party/searxng-source-9fea41204fdfa7a5cfa15b0ebd12904c520478ce.tar.gz`.
- Local modification status: no upstream source-code modifications. The Windows resource mirror is a filesystem-portability projection only; AI Work OS launcher, local HTTP adapter, runtime-bundle scripts and configuration templates remain outside the upstream source mirror.
- Current distribution status: the source is present in the repository, but no AI Work OS binary has yet shipped an embedded Python runtime, SearXNG dependency payload or SearXNG process. Before any installer includes that payload, the release must include the corresponding source, full notices, exact build/dependency instructions and required license disclosures.

## AionUi interaction adaptation

AI Work OS includes `apps/workbench/src/components/workspace/use-chat-auto-scroll.ts`, an adapted chat auto-scroll interaction pattern from [`iOfficeAI/AionUi`](https://github.com/iOfficeAI/AionUi), upstream path `packages/desktop/src/renderer/hooks/chat/useAutoScroll.ts` on the upstream `main` branch.

- Upstream license: Apache License 2.0.
- Upstream copyright: Copyright 2025 AionUi (aionui.com).
- Local modification: this adaptation is rewritten for the AI Work OS virtualized React chat timeline; it uses an explicit scroll handler and immediate animation-frame updates instead of AionUi's content string dependency.
- Full Apache License 2.0 text: `third_party/aionui/LICENSE`.
