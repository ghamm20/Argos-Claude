# BLOCKER.md — Web Capability build deviations & notes (2026-06-02)

None of the items below blocked the build — all tiers shipped green. They are
recorded here per the directive's "flag deviations / no new deps without
flagging" rule, and as honest operator notes.

## Dependencies

- **Cheerio NOT installed.** Tier 3's `firecrawl_alt` was specified as possibly
  needing Cheerio for HTML parsing. It does **not** — it reuses the existing
  regex HTML utilities in `lib/tools/util.ts` (`stripHtml`, `extractTitle`,
  `extractMetadata`, `extractLinks`, `extractImages`) which already power
  `web_crawl`. No new npm dependency was added in this entire build. This keeps
  the USB-native zero-extra-dep posture and avoids a parser dependency.
  Verify-argos Rule 2 would not have flagged cheerio (it's not network/analytics),
  but avoiding it is the cleaner call. If richer parsing is ever needed,
  `npm i cheerio` is the drop-in.

## Environment / external-service notes

- **SearXNG JSON API is disabled (HTTP 403).** The local SearXNG at
  `127.0.0.1:8080` returns 403 on `format=json` (SearXNG ships with JSON output
  off by default). `searxng_search` and `chain_search_to_read` therefore use the
  DuckDuckGo HTML fallback automatically. To enable native SearXNG JSON, add to
  the instance `settings.yml`:
  ```yaml
  search:
    formats:
      - html
      - json
  ```
  then restart the SearXNG container. The tools will switch to it with no code
  change.

- **Papers With Code API serves HTML, not JSON.** `https://paperswithcode.com/api/v1/`
  currently returns an HTML page (the public API appears deprecated/guarded).
  `papers_with_code` degrades gracefully and logs the failure to the web audit;
  it does not throw. Use `arxiv_search` + `openalex_search` for paper discovery
  in the meantime.

- **RSSHub container installed.** `diygod/rsshub:latest` was pulled and run
  (`-p 1200:1200 --restart unless-stopped`); it is reachable at
  `127.0.0.1:1200`. `rsshub_feed` reads routes from it.

## Pre-existing (not introduced by this build)

- **smoke-retrieval intermittent teardown.** On Windows, `smoke-retrieval` can
  exit non-zero on a libuv `UV_HANDLE_CLOSING` teardown race even when all
  content assertions pass (documented in the smoke's own header; tracked
  separately). Re-running `check:full` clears it. Observed once during this
  build; the re-run passed 11/11.
