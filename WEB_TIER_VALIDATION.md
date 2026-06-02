# WEB_TIER_VALIDATION.md — ARGOS v2.3.0 Web Capability

**Date:** 2026-06-02
**Build:** v2.3.0 (web capability — 35 tools, self-hosted search, chain read, knowledge APIs)
**Method:** each query run LIVE through the real tool via `/api/tools/execute`
against a throwaway `ARGOS_ROOT` (no operator state touched). Honest results —
including the ones that degraded.

---

## Summary

| Tier | Tools | Smoke | Result |
|------|-------|-------|--------|
| 0 — Infra | http-client, cache, rate-limiter, audit, secrets, API keys | `smoke-web-infra` 12/12 | PASS |
| 1 — Keyless knowledge | Wikipedia, Wikidata, arXiv, OpenAlex, Papers With Code, HuggingFace, Crossref, PubMed, GDELT | `smoke-tier1-tools` 12/12 (live) | PASS |
| 2 — Self-hosted + GitHub | SearXNG, GitHub, Stack Exchange, SEC EDGAR | `smoke-tier2-tools` 8/8 (live) | PASS |
| 3 — Ingestion + chain | Jina Reader, RSSHub, firecrawl-alt, chain_search_to_read | `smoke-tier3-tools` 9/9 (live) | PASS |

**35 tools registered, 21 web tools.** `verify-argos` 7/7 (Rule 4 — no inline
remote fetch — stays green; every external call routes through `lib/web`).
`check:full` 11/11 at each tier.

---

## The 5 directive validation queries (LIVE)

### 1. "Who is the CEO of Levi Strauss?" → `chain_search_to_read`
- **engine** duckduckgo (SearXNG JSON disabled → fallback) · **5 hits ranked** ·
  **read 3 pages** · **15,006 chars aggregated**.
- The headline fix works: the tool SEARCHED **and READ** three full pages
  (not snippets) and returned aggregated body text for the model to answer from.
- Honest note: DDG's top organic result for this exact phrasing was an Owler
  aggregator page rather than a clean CEO bio. The mechanism is sound; for
  person-of-a-company queries, routing also suggests `sec_edgar` + `wikipedia_search`
  which give a cleaner direct answer. Bart, given the 15k-char aggregate, has the
  material to answer; a tighter top result would come from native SearXNG JSON
  (currently 403 — see BLOCKER.md).

### 2. "Latest arXiv papers on local LLM fine-tuning" → `arxiv_search` (date sort)
Returned 5 papers, all dated 2026-06-01 (newest-first), e.g.:
- *From Layers to Submodules: Rethinking Granularity in Replacement-Based LLM Compression* — arxiv.org/abs/2606.02559
- *Mitigating Perceptual Judgment Bias in Multimodal LLM-as-a-Judge…* — arxiv.org/abs/2606.02578
- **Verdict:** real, fresh, date-sorted. Honest note: with `sortByDate:true` the
  date sort dominates relevance, so the set is "newest papers loosely matching the
  terms" — a few are off-topic. For precision, pass `category:"cs.CL"` or
  `sortByDate:false` (relevance). Both paths work; the directive asked for a date
  filter and got one.

### 3. "Current events in Florida today" → `gdelt_events`
- **GDELT returned HTTP 429 (rate-limited)** at validation time. The tool degraded
  gracefully — returned an honest error, logged it to the web audit, did not crash.
- Alternative path (`searxng_search` category=news, or chain) is available and was
  green in the tier smokes. GDELT's public endpoint throttles aggressively; the
  1h cache + rate bucket mitigate repeat calls.

### 4. "Top React state management libraries on GitHub" → `github_search`
Real, excellent, **keyless (authed=false, 60/hr)**:
- `pmndrs/zustand` ★58,155 — Bear necessities for state management in React
- `TanStack/query` ★49,549 — Powerful asynchronous state management
- `react-hook-form/react-hook-form` ★44,743
- `mobxjs/mobx` ★28,193 · `pmndrs/jotai` ★21,181
- **Verdict:** perfect. Adding the operator's PAT in Settings → API Keys lifts the
  rate to 5000/hr.

### 5. "Photosynthesis mechanism" → `wikipedia_search`
- **title:** Photosynthesis (en.wikipedia.org/wiki/Photosynthesis)
- **summary:** "Photosynthesis is a system of biological processes by which
  photopigment-bearing autotrophic organisms, such as most plants, algae and
  cyanobacteria, convert light energy — typically from sunlight — into the chemical
  energy necessary to fuel their metabolism…"
- **Verdict:** perfect — clean summary + full article text returned.

---

## What I personally tested (and how)

- **Infra (TIER 0):** retry/backoff against a deliberately flaky local server
  (500,500,200 → recovered in 3 attempts); cache hit + TTL expiry; token-bucket
  denial with `waitMs`; audit append/query. `smoke-web-infra` 12/12.
- **All 17 web source tools:** executed live through the governance executor with
  real queries (smokes tier 1/2/3); confirmed each returns real structured data
  OR degrades honestly. Audit logged every call (e.g. tier 1: 14 calls / 9 sources).
- **Cache reuse:** Wikipedia + GitHub README second calls returned `fromCache:true`.
- **Operator kill switch:** disabled `jina_reader` → next call blocked server-side
  with "disabled by operator"; re-enabled → works. Enforced in `webFetch`, not just UI.
- **Concurrency bug, found + fixed live:** `chain_search_to_read`'s parallel reads
  exposed a rate-limiter/cache atomic-write race (fixed per-PID temp filename →
  ENOENT on rename under concurrency). Fixed with unique temp suffixes; re-ran green.

## Known limitations (honest)

1. **SearXNG JSON disabled (403)** — general search falls back to DuckDuckGo. Enable
   `formats: [html, json]` in SearXNG `settings.yml` for native aggregated search.
2. **Papers With Code API serves HTML, not JSON** — `papers_with_code` degrades
   gracefully; use arXiv + OpenAlex meanwhile.
3. **GDELT throttles (429)** under repeat use — cache + rate bucket help; news can
   also route through SearXNG.
4. No new npm dependency was added (cheerio avoided — see BLOCKER.md).
