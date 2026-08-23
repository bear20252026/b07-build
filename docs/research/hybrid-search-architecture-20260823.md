# Hybrid Search Architecture

**Author:** Manus AI  
**Date:** 2026-08-23  
**Status:** Architecture and integration plan; SearXNG runtime is not yet bundled in the Windows installer.

## User-visible goal

AI Work OS will provide an explicit **混合检索** mode. One submitted chat query starts the currently available backends in parallel, retains each backend's actual status, normalizes and deduplicates citations, then places retained raw result bodies and source URLs into the same third-party Provider request.

“全部搜索引擎” is implemented as an **open adapter registry**, not an untrue claim that every engine in the world is already built in. The initial fixed input set is Exa MCP, `last30days-skill`, `last30days-skill-cn`, and local SearXNG after its runtime is actually bundled. SearXNG itself provides an administrator-configurable metasearch layer: its settings can retain all defaults, enable/disable individual engines, remove engines or use a `keep_only` allowlist. This makes it the extensible engine aggregation point rather than a reason to add one bespoke adapter per external search engine.

## Initial backend registry

| Backend ID | Role | Current implementation state | Result mechanism | License/runtime |
| --- | --- | --- | --- | --- |
| `exa` | General public-web discovery and fetched readable pages | Available | Remote MCP `web_search_exa`, then native page fetch | Service/MCP endpoint; no bundled runtime |
| `last30days` | International recent-source research | Source vendored; direct-mode adapter implemented | Vendored Python CLI, source-specific report output | MIT; Python 3.12+ required by upstream |
| `last30days-cn` | Chinese-platform recent research | Source vendored; direct-mode adapter implemented | Vendored Python CLI, source-specific report output | MIT; optional Playwright/jieba enhancements |
| `searxng-local` | User-configurable local metasearch | Planned; no runtime in installer yet | Loopback `GET /search?q=…&format=json` | AGPL-3.0; pinned source, CPython and dependency/notice work required |

## Concurrent request contract

```text
User selects 混合检索 and sends one chat turn
  │
  ├─ concurrently run exa(query)
  ├─ concurrently run last30days(query)
  ├─ concurrently run last30days-cn(query)
  └─ concurrently run searxng-local(query) only after local runtime reports ready
         │
         ▼
  backend receipts: started | succeeded | unavailable | failed | timed-out
         │
         ▼
  canonical URL normalization → deterministic de-duplication → source and body budget assembly
         │
         ▼
  current Provider request + visible collapsible backend receipts and sources
```

Each adapter must return a structured receipt instead of collapsing an error into an empty result. The receipt contains the backend identifier, state, elapsed time, diagnostic text, raw body segments, normalized source URLs, title/snippet if available, and an explicit statement when the response could not be included because of the existing 1M-character Provider request budget.

## Source handling and deduplication

URLs are normalized by lowercasing scheme/host, stripping fragments and known tracking parameters, retaining meaningful query parameters, then using a stable first-backend-wins source ordering. The response UI must retain **backend attribution** even if the canonical URL is shared by multiple backends. A Provider context block must retain the source URL and backend identity next to each body segment.

Per-backend timeouts prevent an unavailable source from blocking all other results. They are an operational completion boundary, not a silent source-quality filter. The UI displays timeout/failure receipts. Context budgeting happens after source merging and must report excluded source counts; it must never silently replace raw research content with an invented summary.

## Local SearXNG contract

SearXNG supports `GET /search` and `POST /search`; requesting JSON requires `format=json` and the `json` format to be enabled under `search.formats` in `settings.yml`. Supported request parameters include `q`, `categories`, `language`, `pageno`, `time_range`, `format` and `safesearch`. A local desktop instance will bind only to `127.0.0.1`, then the Rust adapter will issue `GET /search?q=<encoded query>&format=json` and project its results into the common receipt contract.

The settings file can set `use_default_settings: true`, merge named engine changes, remove unwanted engines, or use `keep_only` to make the enabled engine set explicit. The desktop product should ship a visible settings page where the user can select available configured engine groups; it must not claim any external engine works until the locally bundled instance reports it as configured and returns a real result.

## References

1. SearXNG Search API: <https://docs.searxng.org/dev/search_api.html>
2. SearXNG `settings.yml`: <https://docs.searxng.org/admin/settings/settings.html>
3. SearXNG source and AGPL license: <https://github.com/searxng/searxng>
4. Exa MCP: <https://docs.exa.ai/reference/mcp>
5. last30days source snapshot: `third_party/UPSTREAM_SOURCES.md`
