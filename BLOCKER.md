# DEFERRAL — Phase 3 / v2.4.1 (Integrity Measurement Infrastructure) — 2026-06-03

**Status:** ⏸ DEFERRED FOR TIME — **not blocked, ready to start fresh.**

The v2.4.0 Operator Stack overnight build shipped Phase 1 (v2.3.11) and Phase 2
(v2.4.0) clean, with full validation and no fake greens. Per the directive's
explicit guidance — *"This phase is OPTIONAL … defer Phase 3 to next session …
This preserves operator overnight availability"* — Phase 3 is deferred.

**Why (honest):** Phase 1 expanded mid-flight (fixed a real integrity-guard gap +
a broken Sage model + a model pull); Phase 2 was 19 tools each validated live.
Phase 3's validation is rigor-dependent and expensive — the adversarial corpus
runs ~50+ prompts × 4 personas live (~200 model calls with swaps → 30–60+ min,
inherently flaky). Shipping v2.4.1 *without* that full run would be a fake green,
the one thing this build refused to do. Deferring protects both the quality bar
and operator overnight availability. **No Phase-3 code was written — nothing is
half-done; pick it up cold.**

**Resume plan (start fresh):**
1. `scripts/integrity-corpus/*.json` — 50+ prompts tagged with expected failure
   mode + catch layer (categories: tool-not-exists, result-with-no-tool,
   pending-framing, false-success, negative-result softening, cross-turn
   memory+tool). Seed from the proven fixtures in
   `scripts/validate-misrepresentation.mjs` + `scripts/validate-persona-tools.mjs`.
2. `loops/integrity-stress.ts` — nightly 3am via the existing loop/scheduler
   infra (`lib/loops/`, `lib/task-scheduler.ts`); per prompt × persona record
   attempted-fabrication? + caught? → `state/integrity-stress-results.jsonl`.
3. `lib/integrity-metrics.ts` — per-persona attempt-rate + catch-rate, 7d/30d →
   `state/integrity-metrics.json`.
4. HUD INTEGRITY block in `components/web/WebHudSection.tsx` (+ `/api/web/stats`):
   7-day attempt/catch rate, last + next run; amber on WoW attempt-rate rise,
   red on catch-rate < 95%.
5. Validate: run corpus once, verify HUD shows rates + scheduler next-run, then
   ship v2.4.1.

Reusable blocks already in place: `lib/tool-integrity.ts` (evaluateIntegrity,
detectMisrepresentation, hasMalformedToolTag), `lib/integrity-log.ts`, the loop/
scheduler infra, and the existing "INTEGRITY VIOLATIONS: N" HUD row to clone.

See `OVERNIGHT_REPORT.md` for the full two-phase report.

---

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
