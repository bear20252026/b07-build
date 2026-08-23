# SearXNG Windows Bundle Assessment

**Author:** Manus AI  
**Date:** 2026-08-23  
**Scope:** AI Work OS Windows desktop shell; a self-contained optional local SearXNG backend.

## Decision summary

SearXNG can be bundled with the Windows application, but it is a **separate Python web application and runtime**, not a library to add to the existing Rust HTTP client. The correct product design is an optional local search backend: the desktop shell starts a bundled SearXNG process on an ephemeral loopback-only address only after the user chooses the SearXNG search mode; the shell health-checks it, calls its local search API, and stops it on application exit.

This local process would not reintroduce the removed Provider Gateway. Provider chat remains `WebView → Tauri → Rust HTTPS/SSE → selected Provider`. The optional SearXNG process only supplies web-search results to the existing local search adapter.

## Verified upstream facts

| Topic | Verified finding | Design implication |
| --- | --- | --- |
| Upstream | `searxng/searxng` is a metasearch engine and its repository is AGPL-3.0. | Pin a commit; retain the upstream source, copyright notices and AGPL text. |
| Direct installation | Official direct installation creates a Python virtual environment, installs SearXNG dependencies, requires `server.secret_key`, and can start `python -m searx.webapp`. | A Windows bundle needs a versioned Python runtime, resolved dependencies, SearXNG source and a generated per-user settings file. |
| Container installation | Official container deployment expects Docker or Podman; the current composition exposes a core SearXNG service and may use Valkey for limiter-related functionality. | Docker is not an acceptable prerequisite for the Windows desktop installer. The direct Python-runtime mode is the applicable route. |
| Tauri distribution | Tauri 2 can bundle files as resources and can run approved external sidecar binaries. | Place SearXNG source/runtime assets in the installer; Rust owns launch, health, shutdown and output events. |
| Python on Windows | CPython provides Windows embeddable packages; the official documentation describes them as minimal runtimes suitable for embedding. | Build and test separate x64 and ARM64 payloads; do not depend on a user-wide Python installation. |

## Required distribution model

```text
AI Work OS NSIS installer
  ├─ Rust / Tauri desktop executable
  ├─ WebView UI assets
  ├─ third_party/last30days source snapshots and MIT notices
  └─ optional SearXNG payload
      ├─ pinned CPython Windows runtime
      ├─ pinned SearXNG source snapshot
      ├─ resolved Python wheels/site-packages
      ├─ SearXNG AGPL-3.0 license + upstream copyright notices
      └─ settings template and source-offer metadata

First explicit SearXNG search
  → extract/copy writable state to %LOCALAPPDATA%/AI Work OS/searxng/
  → generate a unique server.secret_key
  → bind only to 127.0.0.1 on an available local port
  → start Python SearXNG child process
  → wait for local health endpoint
  → issue local search request
  → send sources/raw content through the existing Provider request path
  → terminate process on app exit or user stop
```

The install payload must remain immutable. Cache, configuration and generated secret material must be written to the current user's application-data directory, never into the bundled resources directory.

## Reproducible Windows runtime preparation

The repository provides `tools/prepare-searxng-windows-runtime.ps1` for the Windows build machine. It fixes CPython at `3.13.13`, downloads the official x64 embeddable package, enables its local `site-packages`, bootstraps pip, installs the SearXNG pinned core requirements from `third_party/searxng-windows/requirements.txt` using prebuilt Windows wheels only, and writes `runtime-manifest.json` containing the CPython archive SHA-256 and installed package list. The generated runtime is intentionally ignored by Git but mapped as a Tauri resource at build time. The public source repository retains a verbatim fixed SearXNG source archive and a Windows-executable mirror; four upstream Linux web-server socket template filenames containing `:` remain only in the full archive because Windows Git cannot materialize them.

The first actual Windows build must run that script before `cargo tauri build`, inspect the manifest, retain third-party dependency licenses, and verify SearXNG starts against the packaged Python payload. A release cannot describe SearXNG as bundled until those Windows checks have completed.

### Windows-only compatibility shim

At pinned SearXNG commit `9fea41204fdfa7a5cfa15b0ebd12904c520478ce`, `searx/valkeydb.py` unconditionally imports the Unix standard-library `pwd` module, even though the configured local runtime disables Valkey. Windows CPython has no such module. The runtime preparation script therefore writes a separate `Lib/site-packages/pwd.py` compatibility shim after copying SearXNG into site-packages. It is not a modification to vendored SearXNG source; it only supplies `getpwuid` if optional Valkey connection error logging is reached. The generated runtime manifest names the shim explicitly.

The Windows runtime script also pins `tzdata==2026.3`. SearXNG can return local JSON results without it, but Windows lacks the system zoneinfo database expected by some SearXNG/Babel code paths; the explicit package removes those background import failures from the self-contained runtime.

## User-facing search choices

| Mode | When it runs | Source of results | Network path |
| --- | --- | --- | --- |
| Exa | User enables ordinary “联网检索” and selects Exa/default. | Exa MCP, then readable source pages. | Desktop Rust shell → Exa MCP / public pages. |
| SearXNG local | User selects “本地 SearXNG” and sends a query. | User's bundled local SearXNG configuration and its enabled public engines. | Desktop Rust shell → local loopback SearXNG → public search engines. |
| 近 30 天研究 | User explicitly selects English or Chinese research mode. | Vendored last30days tool output, sources and diagnostics. | Desktop Rust shell → controlled local runner → selected public/API sources. |

No mode should launch merely because the desktop application opens. A visible status item must distinguish `未启动`, `启动中`, `就绪`, `诊断失败`, `搜索中`, `已停止` and show the selected backend and returned sources.

## AGPL-3.0 compliance work required before binary distribution

The upstream license requires preservation of notices and license text. If a modified AGPL-covered work is conveyed in object code, the corresponding source must be made available under the license terms. AGPL also includes network-interaction source-offer obligations for modified covered works. This assessment is an engineering record, not legal advice; before distributing the binary, the repository owner should obtain a license review for the exact packaging and process-boundary arrangement.

The present AI Work OS self-authored code is MIT-licensed in `LICENSE.md`. Declaring the project open source does not by itself remove AGPL conditions. If SearXNG is included in the released installer, the project must at least preserve SearXNG's AGPL source and notices and fulfill the corresponding-source obligations for the distributed SearXNG payload and its modifications. Whether the independently launched SearXNG process and the Tauri application are a single combined work or an aggregate is a licensing question that should be reviewed before setting the final project-wide license. The conservative open-source release path is to publish the complete repository, the exact SearXNG payload build scripts, all modifications and a clear per-component license map.

The project must complete all of the following before shipping an installer containing SearXNG:

1. Vendor SearXNG at a fixed commit, including `LICENSE`, `AUTHORS.rst`, source and all required build/install scripts.
2. Produce a complete, reproducible source repository for the shipped payload, including the exact Python runtime and Python dependency locks/licenses.
3. Add a visible in-app “Open-source notices” item that identifies SearXNG, its AGPL-3.0 license, the shipped source commit, local modifications and a source download location.
4. Include the full AGPL-3.0 text and all required notices in both the repository and installer output.
5. Publish every local modification to SearXNG and the exact scripts used to create the embedded payload; retain installation information needed to rebuild or replace the component.
6. Audit every Python dependency and Windows runtime component; an AGPL source tree alone is not a complete binary distribution manifest.

## Explicit exclusions for the first implementation

The first SearXNG desktop implementation should not expose the local instance to LAN/WAN interfaces, should not use Docker, should not rely on a user-installed Python, and should not auto-configure credentials, browser cookies or bypass engine restrictions. The feature is a user-triggered local search backend, not an unrestricted browser automation service.

## Sources

1. SearXNG source and license: <https://github.com/searxng/searxng>
2. SearXNG direct installation: <https://docs.searxng.org/admin/installation-searxng.html>
3. SearXNG container installation: <https://docs.searxng.org/admin/installation-docker.html>
4. Tauri 2 external sidecars: <https://v2.tauri.app/develop/sidecar/>
5. Tauri 2 resources: <https://v2.tauri.app/develop/resources/>
6. CPython on Windows: <https://docs.python.org/3/using/windows.html>
