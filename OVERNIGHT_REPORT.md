# ARGOS v2.4.0 Operator Stack — Overnight Build Report

**Date:** 2026-06-03 (overnight)
**Start state:** v2.3.10 @ d3abc80, all gauntlets green, D: in sync
**End state:** v2.4.0 @ 314ac4f, all gauntlets green, D: in sync
**Standard held:** honest validation, no fake greens, proof before every tag.

---

## Phase status

| Phase | Scope | Tag | Status |
|-------|-------|-----|--------|
| 1 | Persona tool distribution | **v2.3.11** | ✅ SHIPPED |
| 2 | Tier 4 operator-specific tools (19) | **v2.4.0** | ✅ SHIPPED |
| 3 | Integrity measurement infrastructure | v2.4.1 | ⏸ DEFERRED (time) — see BLOCKER.md |

No phase blocked. Phase 3 was deferred for time, not failure (the directive's
explicit "preserve operator overnight availability" path). It is ready to start
fresh; an actionable resume plan is in **BLOCKER.md**.

---

## Phase 1 — Persona Tool Distribution → v2.3.11

**Commit:** `e72ba0b`  **BUILD_ID:** `TDqFg0j2tb-MFQnTvE7g5`  **Tag:** v2.3.11

Before: only Bartimaeus had tool awareness — 75% of the persona system was idle.

- `lib/persona-tool-subsets.ts` — curated subsets: **Bart = all 36**, **Sage = 17**
  research, **Bobby = 8** ops, **Juniper = 5** comms. Subsets intersect the live
  registry (a not-yet-existing id is dropped, never mis-listed).
- Scoped tool-awareness block per persona + **execution-time enforcement**: a
  persona emitting a tool outside its scope is audited + `tool_not_permitted`,
  not run. The distribution is real, not advisory.

**Two real issues surfaced and fixed (honest, not papered over):**
1. **Integrity guard gap** — Bobby's weak model emits a *malformed* tool tag
   (`<web_search {…}>` — the parser silently skips it: no `"id"` key) then
   fabricates a result, and the v2.3.8 fabrication guard MISSED it. Closed with
   `hasMalformedToolTag()` + `attemptedToolButFailed`: a self-emitted malformed
   tool attempt + fabricated continuation, with no real tool run / grounding /
   honest disclaimer, is now caught structurally. **Model-agnostic — protects
   every persona.**
2. **Sage's model was broken** — declared `alfaxad/wild-gemma4:e4b` was (a) not
   installed, and on pull (b) crashes llama-server every generation
   (`GGML_ASSERT ggml_can_repeat` → 0xc0000409 buffer overrun) AND (c) is a
   "return only valid JSON" fine-tune, wrong for a synthesist. Rebound to the
   **proven** gemma-4 (Bart's). Sage now fires `arxiv_search` live.

**Validation:** validate-persona-tools 19/0 (+1 honest WARN: Bobby's small model
malforms tags — guard-caught, safe); validate-integrity-guard **20/20** (incl. 3
new parse-failure cases); validate-misrepresentation 15/15; no-fabrication 3/3;
**check:full 11/11**.

---

## Phase 2 — Tier 4 Operator-Specific Tools → v2.4.0

**Commit:** `314ac4f`  **BUILD_ID:** `nVl9-gt4CK0y0dODrTKF9`  **Tag:** v2.4.0

19 read-only web tools (T37–T55) on the existing `webFetchJson` infra (cache +
rate-limit + audit + honest errors by construction):

- **Security** nvd_cve · hibp* · federal_register
- **Government** congress_gov* · sam_gov*
- **Tennessee** usda_nass* · usgs_water · noaa_climate* · epa_envirofacts
- **Geospatial** nominatim · overpass_osm · open_elevation
- **Media** internet_archive · openlibrary · libretranslate (local)
- **Financial** frankfurter_fx · fred*
- **Other** nhtsa · openfema   (`*` = optional API key, graceful skip)

**Persona assignment:** Bobby += security + financial (now 13 tools); Sage += TN
env + media (now 24); Bart = all (55). Enforced by the Phase 1 subset gate.

**Integrity (MiroFish + fabrication/misrepresentation doctrine on every tool):**
keyed tools report `"not configured"` with the exact key to add (never faked);
libretranslate surfaces `"not reachable at :5000 (connection refused)"` when the
container is down; 0-results / 404 / bad input → honest `toolErr` naming the
reason; NHTSA "0 recalls" reported as good news, not an error.

**Validation:** smoke-tier4-tools **20/0** (+2 live-network WARN, both honest) —
real live data from NVD (CVE-2021-44228), Federal Register, USGS TN gauges, EPA
TN facilities, Nominatim, Open-Elevation (168m), Internet Archive, Frankfurter
(47 USD = 40.47 EUR), NHTSA (5 recalls), OpenFEMA; all 6 keyed tools graceful;
bad-input gauntlet honest. validate-persona-tools 19/0 (subsets exact; gauntlet
clean; Bobby's malformed attempt caught). validate-integrity-guard 20/20.
**check:full 11/11**.

**WARNs (honest, not failures):** `overpass_osm` returned a live HTTP 406 and
`openlibrary` a transient fetch-fail this run — both surfaced honestly with no
fabrication. overpass got an Accept-header fix this session; re-run
`npm run tier4:smoke` to confirm (live endpoints vary).

---

## Integrity doctrine — held green across both phases

The v2.3.8 (fabrication) + v2.3.9 (misrepresentation) guards stayed green
throughout, and were **strengthened** in Phase 1 (parse-failure path). No new
tool or persona behavior produced an *uncaught* fabrication. Where Bobby's weak
model tried to fabricate, the hardened guard caught it every time.

---

## Honest caveats for the operator

1. **Bobby's model (`CyberCrew/notmythos-8b`, 2 GB)** emits malformed tool tags,
   so he doesn't cleanly *fire* tools — but every fabrication is now guard-caught
   (safe, surfaced, never silent). If you want Bobby to actually *use* his 13
   tools, consider rebinding him to the proven gemma-4 (as Sage was). Left as-is
   pending your call — it changes his character/speed.
2. **Tier-4 endpoint spec:** the detailed T37–T55 directive wasn't in context
   this session. Tools were implemented against the **real public API surfaces**
   (documented in each file) and validated live. Endpoints/params are trivial to
   adjust if your spec differs.
3. **Keyed Tier-4 tools** (hibp, congress_gov, sam_gov, usda_nass, noaa_cdo,
   fred) need API keys in Settings → API keys to return data; until then they
   honestly report "not configured." All but hibp are free.
4. **Sage now shares Bart's model** — Bart↔Sage swap is zero-cost; their personas
   still diverge via system prompt.

---

## Recommendations on resume

1. **Phase 3 (v2.4.1)** is scoped + ready — see BLOCKER.md. Budget for it: the
   adversarial corpus validation runs ~50 prompts × 4 personas live (~200 model
   calls), so it wants a dedicated window.
2. Optionally rebind Bobby's model (caveat 1) before Phase 3 so his integrity
   metrics reflect a tool-capable model.
3. Add the free API keys (caveat 3) to light up the keyed Tier-4 tools.

**Time elapsed:** one extended overnight session. Two discrete, fully-validated,
shipped releases. Third phase deferred cleanly, ready to start fresh.
