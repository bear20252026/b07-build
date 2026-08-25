$root = 'D:\maanuse\AI-Work-OS-local-build'
$delivery = 'D:\maanuse\AI-Work-OS-Installer\local-build'
$source = Join-Path $root 'apps\desktop-shell\src-tauri\target\release\bundle\nsis\NOVA_0.1.17_x64-setup.exe'
$target = Join-Path $delivery 'NOVA_0.1.17_x64-setup.exe'

if (-not (Test-Path $source)) { throw "Installer missing: $source" }
New-Item -ItemType Directory -Path $delivery -Force | Out-Null
Copy-Item -Path $source -Destination $target -Force

$item = Get-Item $target
$hash = (Get-FileHash -Path $target -Algorithm SHA256).Hash
$signature = (Get-AuthenticodeSignature -FilePath $target).Status.ToString()
$manifest = [ordered]@{
  product = 'NOVA'
  version = '0.1.17'
  installer = $item.Name
  sourceCommit = 'generated-by-github-actions'
  sourceCommitFull = 'generated-by-github-actions'
  bytes = $item.Length
  sha256 = $hash
  signature = $signature
  gatewayIncluded = $false
  searxngBundled = $true
  searxng = [ordered]@{
    upstreamCommit = '9fea41204fdfa7a5cfa15b0ebd12904c520478ce'
    license = 'AGPL-3.0'
    sourceArchive = 'third_party/searxng-source-9fea41204fdfa7a5cfa15b0ebd12904c520478ce.tar.gz'
    embeddedPython = '3.13.13'
    windowsTimezoneData = 'tzdata==2026.3'
    bindAddress = '127.0.0.1'
    verifiedLocalJsonSearch = $true
  }
  changes = @(
    'Apple white-gray-blue / black-gray-blue homepage without a white outer frame, with the chat surface contained in one desktop screen',
    'Homepage sends through the direct Provider HTTPS/SSE conversation path, presents errors instead of failing silently, and never falls back to the retired Gateway chain',
    'Saved Provider accounts locally rebuild the Tauri native in-memory session on desktop startup without an automatic network probe or message request',
    'Projects are created and restored locally without the retired Gateway or loopback dependency',
    'The left directory supports project-scoped conversations: create, switch, rename, delete and continue local chat history after reopening',
    'Each same-conversation turn sends the ordered local user/assistant history to the selected direct Provider; actual SSE reasoning remains collapsed and never fabricated',
    'Explicit per-turn web search uses the independent Exa MCP path instead of requiring a MiMo plugin, with visible search activity, raw readable page content in the provider context, and clickable returned sources',
    'The research selector provides Exa web search, local SearXNG, international last30days, Chinese last30days, and explicit hybrid mode; hybrid mode runs Exa, local SearXNG and both last30days sources in parallel, retains per-backend receipts, deduplicates normalized URLs and passes raw results to the selected Provider',
    'SearXNG 9fea41204fdfa7a5cfa15b0ebd12904c520478ce is bundled with its AGPL-3.0 notice, full source archive, Windows-portable source mirror, embedded CPython 3.13.13, fixed dependencies and tzdata 2026.3; the local service starts only when selected and binds only to 127.0.0.1',
    'The embedded local SearXNG runtime was verified on this Windows machine through a loopback JSON request and stopped after verification; search engines may independently rate-limit, suspend or return no result',
    'Provider probe, model listing and actual streamed chat use the same direct HTTPS client with a 15-second connection timeout and a 20-minute request allowance; upstream SSE error frames are returned as redacted provider-sse-error diagnostics instead of being silently treated as success',
    'After a Provider account is reconfigured, the home page follows its new default model only when the prior default is still selected; an explicit manual model selection remains intact',
    'Web research requests accept up to 100 sources across Exa, local SearXNG and last30days backends; Exa page extraction runs with up to eight concurrent fetches while the combined readable-page context remains bounded to 1 MB',
    'Windows local SearXNG and last30days subprocesses are created without a console window and report their progress only inside the application',
    'The desktop layout fixes the left project and settings sidebar while the chat timeline scrolls independently; recent 60 messages render first and users can load earlier history without deleting the persisted conversation',
    'Streaming UI refreshes are throttled to roughly 50 milliseconds and mathematical TeX uses lazy-loaded KaTeX rendering for $...$, $$...$$, \\(...\\) and \\[...\\] with plain-text fallback for incomplete formula input',
    'Windows desktop startup no longer renders a blank page: the current chat-home App entry imports the React useRef hook it invokes, and related React 19 ref initialization and desktop Companion direct-stream request contracts now pass production type checks',
    'Windows-compatible task delivery maps colon-bearing logical delivery IDs to reversible safe physical filename segments, while retaining original delivery IDs in receipts and hash validation',
    'The Windows root test command uses a Node-native cross-platform test discovery entrypoint; Gateway shutdown now waits for its listener and SQLite resources before temporary directory cleanup',
    'Text and code attachments are passed as file body context; PDF, Open XML office files and ZIP archives are extracted locally into readable model context with visible status',
    'PNG, JPEG, WebP and GIF attachments are sent as OpenAI-compatible or Anthropic-compatible multimodal content blocks instead of filename-only descriptors',
    'Very long chat input is retained as a virtual TXT context record and remains available in later turns under the 1M-character request budget',
    'The terminal window executes user-submitted commands under the current Windows user, streams output and supports cancellation; high-impact commands require one final explicit confirmation',
    'Release metadata, Tauri bundle metadata, desktop package version and installer filename use semantic version 0.1.17 and a pre-build consistency check rejects mismatches',
    'AionUi Apache-2.0 chat auto-scroll interaction is adapted with preserved notices: the central timeline scrolls independently, follows streaming only near the bottom and never pulls readers away from history',
    'The ordinary chat entry is code-split from legacy task, settings and inspector pages; the initial Workbench entry is kept below the 500 KB performance budget',
    'Hybrid search requests and deduplicates up to 100 sources; raw search bodies are provided only to the current Provider request instead of being persisted or rendered into the chat timeline',
    'Selected workspaces can contain a visible AI_WORK_OS_MEMORY.md file that owners edit in the app and that is injected as bounded project context for later direct Provider turns',
    'The GitHub collaboration inspector stores a user-entered personal access token only in local app storage, previews local Git changes, exposes an explicit fixed git diff --check test summary, and requires an explicit in-app confirmation before commit and push',
    'Owners can explicitly read and edit AI_WORK_OS_MEMORY.md, preview an append-only memory proposal, and write it only after a visible approval checkbox',
    'Context budget, checkpoints, branches and safe Markdown/JSON export are local transparent inspector tools; exports exclude hidden Provider context and activity details',
    'The direct Provider usage ledger stores a bounded local projection of diagnostic metadata, latency, first-token time, visible output characters and error category without storing Base URLs, keys, chat content, images, vendor token counts or billing data',
    'Halo Search, the event-driven real-progress Inspector, a resizable controlled artifact rail and explicit assistant Markdown saving remain local user-driven surfaces and do not replace direct Provider HTTPS/SSE chat',
    'The Windows native desktop pet is default-off and explicitly shown: its transparent borderless always-on-top window can hide independently without hiding the workbench, chat, search, artifacts or Provider configuration',
    'NOVA replaces the previous application display name across the Windows window, tray, installer, Workbench and local diagnostics while keeping the stable app identifier and existing user data locations',
    'The Workbench provides official starter directories for current direct Provider models, including Kimi and DeepSeek V4 Flash, without replacing user-entered Base URLs, model identifiers, protocol choices or native HTTPS/SSE direct chat',
    'Right-side project history groups only receipt-backed task runs and explicitly saved assistant Markdown replies; selected Markdown files can be exported one at a time through a native Save As dialog without exposing destination paths, general file access, automatic writes or Provider context injection'
  )
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $delivery 'build-manifest.json') -Encoding utf8
Write-Output "INSTALLER=$target"
Write-Output "BYTES=$($item.Length)"
Write-Output "SHA256=$hash"
Write-Output "SIGNATURE=$signature"
Write-Output "SOURCE_COMMIT=$($manifest.sourceCommit)"
