# V1_1_REPORT.md — Polish Batch

**Date:** 2026-05-25
**Author:** Claude
**Source repo:** `C:\Users\Gordy\dev\Argos-Claude\`
**Deployed payload:** `C:\Users\Gordy\Desktop\ARGOS\`
**Directive:** ARGOS v1.1 — Polish Batch (7 tasks)
**This run:** **GATE PASS — 7/7 tasks**, build clean, full smoke gauntlet green.

---

## Task-by-task results

| # | Task | Status | One-line reason |
|---|---|---|---|
| 1 | HUD: Audit Chain Length | **PASS** | New `/api/audit/count` endpoint + HUD `EVENTS` row using O(1) tail-cache |
| 2 | Per-persona `think` flag | **PASS** | `Persona.think?: boolean` added; all 4 default `false`; `/api/chat` reads `persona.think` not hardcoded |
| 3 | TTFT fix in validation harness | **PASS** | Streaming reader; Bart P1 ttft=639ms vs total=53349ms (was ttft=total in prior run) |
| 4 | Bobby domain anchor | **PASS** | Appended physical-security anchor line; Bobby P1 now anchors to physical security (was insurance) |
| 5 | Vault topK 5 → 8 | **PASS** | Q1 now returns BOTH `calloff-management.md` + `performance-review-triggers.md`; Q5 false-citation still 0 hits |
| 6 | USB PATH HUD fix | **PASS** | New `/api/system/info` (force-dynamic); HUD fetches at runtime; reports `Desktop\ARGOS` correctly |
| 7 | MODELS.md update | **PASS** | Full current persona-to-model table + CUDA-bad model permanently flagged + 5090 path + thresholds |

---

## Task 1 — HUD Audit Chain Length

**New endpoint** `GET /api/audit/count` returns `{ count: N }`. Uses the O(1) tail-cache (v1.1.2 work in `lib/audit.ts`): single `fsp.stat` call when the cache is warm, only streams the file to recount newlines on cache miss. Safe to poll every few seconds.

**HUD row added** in Context section (`components/HUD.tsx`):
```
EVENTS    42
```

Polls `/api/audit/count` every 5s. Title hover shows `42 entries on the hash-chained audit log`. Color-coded with persona accent when > 0.

**Live verification:**
```
$ curl http://127.0.0.1:7796/api/audit/count
{"count":42}
```

---

## Task 2 — Per-Persona `think` Flag

Replaced the hardcoded `think:false` in `app/api/chat/route.ts` (commit `94f4ea4`'s Phase 2-RB self-correction) with a per-persona config option in `lib/personas.ts`:

```ts
export interface Persona {
  ...
  think?: boolean;
  ...
}
```

All 4 personas explicitly set `think: false` (preserves Phase 2-RB doctrine — gemma4/qwen3 emit empty content otherwise). The chat dispatcher now reads `persona.think === true` (default false) at request time.

Documentation: `MODELS.md` "think:false requirement" section names the affected model families + symptoms.

---

## Task 3 — TTFT Fix in Validation Harness

**Before:** `scripts/phase2-validation.mjs` called `req()` which buffered the full response body before returning. The `firstTokenAt` assignment happened during local JSON-parse loop AFTER stream close → ttft always equaled total.

**After:** rewrote `chat()` to run the http request directly + watch chunks as they arrive via `res.on('data', ...)`. `firstTokenAt` records when the first chunk carrying a non-empty `message.content` parses out.

**Re-run evidence** (post-fix, 4 personas × 2 prompts):

| Persona × Prompt | TTFT (ms) | Total (ms) | Δ |
|---|---|---|---|
| Bart P1 | **639** | 53349 | 84× shorter |
| Bart P2 | **448** | 35925 | 80× shorter |
| Juniper P1 | **443** | 36598 | 83× shorter |
| Juniper P2 | **552** | 20509 | 37× shorter |
| Sage P1 | **4329** (incl 4040ms cold load) | 87162 | 20× shorter |
| Sage P2 | **250** | 78765 | 315× shorter |
| Bobby P1 | **4111** (incl 3889ms cold load) | 8344 | 2× shorter |
| Bobby P2 | **245** | 2731 | 11× shorter |

Sage P1 and Bobby P1 show high TTFT because they include the cold model load (4040 ms and 3889 ms respectively). Warm calls (P2 for each) are sub-500ms — that's the real first-token latency. `phase3-validation.mjs` uses POST `/api/vault/search` which returns a single JSON (no streaming) — no TTFT artifact possible.

---

## Task 4 — Bobby Domain Anchor

Appended one line to Bobby's system prompt in `lib/personas.ts` (other persona prompts untouched per directive scope):

> "You operate in a physical security and workforce management context. When domain is ambiguous, default to physical security operations."

**Before** (Phase 2 validation, 2026-05-25 earlier today): Bobby read "double their security coverage overnight" as **insurance**:

> "Telling them to double coverage overnight is easy to understand, but it's dangerous in practice. If they buy a new policy tomorrow morning, their coverage doubles instantly..."

**After** (v1.1 re-validation): Bobby anchors to **physical security**:

> "You tell them to hire an extra layer of eyes immediately. Here is exactly what to say: 'If you want double coverage overnight, you don't buy more guards or more cameras at once. You add a different type of guard to cover the new shift or the new area. Here is the plan: 1. **Add a..."

Domain ambiguity resolved. Bobby's plain-talk register and short-sentence rhythm preserved (1367 chars vs 457 chars previously — slightly longer because the model now has more concrete domain to lean on).

---

## Task 5 — Vault topK Tuning

**Before:** Phase 3 Q1 ("guard calls off three times") returned `calloff-management.md` at rank 1 (HIGH) but `performance-review-triggers.md` landed at rank 6 — outside the topK=5 cutoff. Gate passed (≥1 expected) but coverage was incomplete.

**After:** Bart's persona-level `topK` raised 5 → 8 in `lib/personas.ts`. Validation harness's topK also bumped to 8 in `scripts/phase3-validation.mjs` (the harness was bypassing persona config by passing topK directly to `/api/vault/search`).

**Re-run evidence:**

```
Q1: "What happens when a guard calls off three times?"
  ✓ [HIGH  ] 0.731  calloff-management.md          chunk 0
    [HIGH  ] 0.626  scheduling-policy.md           chunk 0
    [HIGH  ] 0.612  incident-response-sop.md       chunk 0
    [HIGH  ] 0.610  certification-requirements.md  chunk 0
    [HIGH  ] 0.602  post-orders-template.md        chunk 0
    [MEDIUM] 0.591  site-onboarding-checklist.md   chunk 0
    [MEDIUM] 0.586  performance-review-triggers.md chunk 0  ← NOW IN
    [MEDIUM] 0.571  certification-requirements.md  chunk 0
  expected sources matched: 2/2  (calloff-management.md, performance-review-triggers.md)

Q5: "What is the boiling point of water?"
  (no hits above floor) — false-citation test: PASS
```

**Q1: 2/2 expected sources matched.** **Q5: false-citation gate still PASS.** Bumping topK didn't introduce noise because the drop-floor (0.50) gates earlier than topK selection.

---

## Task 6 — USB PATH HUD Fix

**Root cause:** `app/page.tsx` calls `await getRuntimeInfo()` at render time. The page is statically rendered (`○` symbol in Next.js build output), so `argosRoot()` is evaluated at BUILD time (using the dev source `process.cwd()`) and baked into the HTML shipped to the client. On the deployed payload, the HUD displayed `C:\Users\Gordy\dev\Argos-Claude` instead of `C:\Users\Gordy\Desktop\ARGOS`.

**Fix:** new endpoint `GET /api/system/info` (force-dynamic, evaluated per request, reads `process.env.ARGOS_ROOT` at runtime). HUD fetches it on mount + uses the runtime value when available; falls back to the build-time prop otherwise.

**Live verification (run with `ARGOS_ROOT=C:\Users\Gordy\Desktop\ARGOS`):**

```
$ curl http://127.0.0.1:7796/api/system/info
{"appName":"argos-claude","version":"0.1.0","argosRoot":"C:\\Users\\Gordy\\Desktop\\ARGOS","isDev":false,"ollamaUrl":"http://127.0.0.1:11434","startedAt":1779808551390}
```

HUD now displays `C:\Users\Gordy\Desktop\ARGOS` (no `(dev)` suffix because `isDev=false`). When launched from the dev source repo, it correctly shows `... (dev)`.

---

## Task 7 — MODELS.md Update

Created `C:\Users\Gordy\dev\Argos-Claude\MODELS.md` (~12 KB, NEW). Contents:

- Current v1.0+ persona-to-model assignment table (4 personas, Q4_K_M sizes, `think:false` defaults, source-of-truth commits)
- `think:false` requirement section (gemma4 + qwen3-thinking families documented)
- **`hf.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive:Q4_K_M` PERMANENTLY DISQUALIFIED** — CUDA incompatibility on 3060 Ti, reproduced twice. `ollama rm` command included.
- Model swap latency table (measured cold + warm load_duration + tok/s + TTFT)
- Bart + Juniper shared-model documentation (zero swap cost between them)
- Power Mode / 5090 path with override-JSON example
- `nomic-embed-text` embedding model rationale (why NOT chat-model embeddings — the Phase 3 architectural flag)
- Confidence threshold calibration evidence (Phase 3-B HIGH≥0.60 / MED≥0.50 / drop<0.50)
- Per-persona retrieval policy table (with v1.1 topK=8 for Bart)
- How-to: add new persona-bound model, deactivate a model
- Cross-references to phase reports + `lib/personas.ts` source

---

## Build output

```
$ npm run lint        (eslint clean)
$ npm run typecheck   (tsc --noEmit clean)
$ npm run verify
verify-argos — Seven USB-Native Rules harness
[PASS] Rule 1: no hardcoded absolute paths
[PASS] Rule 2: no network / analytics packages in runtime dependencies
[PASS] Rule 3: filesystem path operations use path.join
[PASS] Rule 4: no external CDN imports / remote fetch in source
[PASS] Rule 5: storage paths derive from ARGOS_ROOT
[PASS] Rule 6: launcher daemon spawns must redirect stderr to a log file
[PASS] Rule 7: Windows launcher cmd /c daemon spawns must use `< NUL`
All 7 rule groups passed.

$ npm run build       (clean)
New routes registered as Dynamic:
  ├ ƒ /api/audit/count
  ├ ƒ /api/system/info
```

**Side-effect found and fixed during verify:** `scripts/phase3-validation.mjs` had a Rule-1 violation from Phase 3-B (a fallback hardcoded `"C:\\Users\\Gordy\\Desktop\\ARGOS"` for `ARGOS_ROOT`). Replaced with env-first / cwd-fallback resolution. Verify went 7/7 PASS after.

---

## Full smoke gauntlet

| Smoke | Result | Notes |
|---|---|---|
| `scripts/smoke-audit-chain.mjs` | **PASS** | 5 tamper scenarios still detected |
| `scripts/smoke-audit-tail-cache.mjs` | **PASS** (6/6) | Format invariant + tamper-detection still PASS after `getChainCount()` addition |
| `scripts/smoke-v1-e2e.mjs` | **PASS** (23/23) | Fixed: the harness hardcoded `e4b:latest` (a model removed in Phase 2 full assignment); updated to `BART_MODEL = "fredrezones55/Qwen3.5-...:9b"` |
| `scripts/smoke-failure-modes.mjs` | **PASS** (18/18) | All 12 graceful-degradation scenarios + persona-switch audit validation |
| `scripts/phase2-validation.mjs` | **PASS** (4×2 chats coherent) | TTFT fix verified; Bobby domain anchor verified; all 4 personas distinct |
| `scripts/phase3-validation.mjs` | **PASS** (5/5 queries) | Q1 now 2/2 expected sources; Q5 false-citation still 0 hits |

---

## Deployed payload sync

```
xcopy → C:\Users\Gordy\Desktop\ARGOS\.next         (mirrored — 6 routes total now)
xcopy → C:\Users\Gordy\Desktop\ARGOS\app\.next     (mirrored — launcher uses this one)
```

New routes verified present in deployed bundle:
- `/api/audit/count`
- `/api/system/info`

---

## Files touched

| File | Change |
|---|---|
| `lib/audit.ts` | NEW `getChainCount()` — O(1) tail-cache path; falls back to streaming newline count |
| `app/api/audit/count/route.ts` | NEW — `{ count: N }` |
| `app/api/system/info/route.ts` | NEW — runtime `argosRoot` for HUD |
| `lib/personas.ts` | `Persona.think` field added (default false for all 4); Bart topK 5→8; Bobby system-prompt anchor line appended; comments per task |
| `app/api/chat/route.ts` | Reads `persona.think` instead of hardcoded `false` |
| `components/HUD.tsx` | New `EVENTS` row + 5s poll of `/api/audit/count` + runtime `argosRoot` from `/api/system/info` |
| `scripts/phase2-validation.mjs` | `chat()` rewritten with stream-aware http.request for real TTFT |
| `scripts/phase3-validation.mjs` | `topK: 5 → 8`; Rule-1 violation fixed (env-first ARGOS_ROOT resolution) |
| `scripts/smoke-v1-e2e.mjs` | `BART_MODEL` constant replaces 5 hardcoded `"e4b:latest"` references |
| `MODELS.md` | NEW — full models reference |
| `V1_1_REPORT.md` | NEW — this file |

11 files touched. 4 NEW.

---

## Honest findings noted along the way

1. **`scripts/smoke-v1-e2e.mjs` was silently broken** since Phase 2 (2026-05-25) when `e4b:latest` was removed from the model roster. The smoke ran fine in the validation phase because it ran BEFORE that model rename. Today's gauntlet caught it (B1 + C1 failures). Fixed by introducing `BART_MODEL` constant. Lesson: smoke scripts that hardcode model names need updating whenever the persona roster changes.
2. **`scripts/phase3-validation.mjs` had a Rule-1 violation** from Phase 3-B (hardcoded `C:\Users\Gordy\Desktop\ARGOS` fallback). `verify-argos` Rule 1 caught it today. Fixed.
3. **Bart's topK=8 increases retrieval context cost** for every chat that uses retrieval. Marginal in practice (each chunk is ~512 tokens × 8 = ~4096 tokens added to the prompt). Worth re-evaluating if `/api/chat` latencies climb noticeably.

---

## Commit hash

Will be filled after `git commit` at end of this report.

**Commit SHA:** `31332f0` (local on `main`, not pushed, not tagged)

---

## Gate to Phase 7

All 7 tasks PASS. Smoke gauntlet clean. Build clean. No new npm dependencies. `lib/personas.ts` system prompts unchanged except Bobby's anchor line (within directive scope). Audit chain schema unchanged. No regressions to Phase 4 tamper-evidence guarantees.

**v1.1 polish batch: COMPLETE.** Ready for Phase 7 (Voice binaries) when you greenlight.
