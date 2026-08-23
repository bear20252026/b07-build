# Third-Party Source Lock

This directory contains complete, vendored source snapshots retained for reproducible desktop integration. The source trees below were copied without source-code modifications. Their original license files remain inside each source tree and must travel with any source or binary distribution that includes the corresponding component.

| Directory | Upstream | Pinned commit | License | Included upstream license | Local status |
| --- | --- | --- | --- | --- | --- |
| `last30days-skill/` | <https://github.com/mvanhorn/last30days-skill> | `d05389d39b2ce09a13f71b01e68562f077c766df` | MIT | `last30days-skill/LICENSE` | Complete unmodified source snapshot; no hooks, installers, setup wizards, or research commands have been executed by AI Work OS. |
| `last30days-skill-cn/` | <https://github.com/Jesseovo/last30days-skill-cn> | `1a8a04c3c347defbcdbb8da26d7cf1a531426b1f` | MIT (declared in upstream `LICENSE`) | `last30days-skill-cn/LICENSE` | Complete unmodified source snapshot; no hooks, installers, setup wizards, browser automation, or research commands have been executed by AI Work OS. |
| `searxng-source-9fea41204fdfa7a5cfa15b0ebd12904c520478ce.tar.gz` | <https://github.com/searxng/searxng> | `9fea41204fdfa7a5cfa15b0ebd12904c520478ce` | AGPL-3.0 | `searxng/LICENSE` inside the complete source archive | Complete unmodified source snapshot archived without repacking individual files; retained because four upstream template filenames use `:` and cannot be checked out by Windows Git. |
| `searxng-windows/` | Portable resource mirror of the pinned SearXNG source | `9fea41204fdfa7a5cfa15b0ebd12904c520478ce` | AGPL-3.0 | `searxng-windows/LICENSE` | Complete executable source/resource mirror except four upstream web-server socket template filenames containing `:`. Those templates are unrelated to the Windows embedded Python runtime and remain verbatim in the complete source archive. |

## Attribution

`last30days-skill` is copyrighted by Matt Van Horn. `last30days-skill-cn` identifies itself as a Chinese-localized fork and retains copyright notices for both Matt Van Horn and Jesse. `searxng` is copyrighted by the SearXNG contributors and is licensed under AGPL-3.0. The original SearXNG source is preserved verbatim inside its fixed archive; its Windows resource mirror retains the executable source and license while omitting only four Linux/HTTPD socket template filenames that cannot exist on Windows. This lock document is project metadata and does not replace upstream license terms.

## Update policy

An update must use a new fixed upstream commit, retain the upstream `LICENSE` and copyright notices, update this table and `THIRD_PARTY_NOTICES.md`, and record any local source modification in a separate patch note. Do not overwrite a vendored snapshot in place without recording the old and new commits.
