# ARGOS Self-Evolving Loop Suite — All-Night Build Report

**Date:** 2026-06-02
**Operator:** Gordy
**Builder:** Bart (Claude Opus 4.8, 1M context)
**Dev source:** `C:\Users\Gordy\dev\Argos-Claude` · **Payload:** `D:\ARGOS`
**Doctrine:** No pre-approval gates. Bart proposes → tests → applies → logs.
Backup before every write. Auto-rollback on test failure. Honest failures only.
`detectGaming()` is real. The benchmark is ground truth.

---

## Status: ALL TIERS SHIPPED ✅

| Tier | Commit | Smoke | check:full | D: synced |
|------|--------|-------|-----------|-----------|
| Original 20-loop suite | `c00b2fd` | smoke-loops 30/30 | 11/11 | ✅ |
| **Tier 0 — Infrastructure** | `970e036` | smoke-loops-infra 21/21 | 11/11 | ✅ |
| **Tier 1 — Operational loops** | `d42da1f` | smoke-loops-tier1 17/17 | 11/11 | ✅ |
| **Tier 2 — Advanced reasoning** | `8189c1b` | smoke-loops-tier2 15/15 | 11/11 | ✅ |
| **Tier 3 — Self-improvement** | `7878ba9` | smoke-loops-tier3 17/17 | 11/11 | ✅ |
| **Tier 4 — API / UI / brief** | `511a8b6` | smoke-loops-ui 14/14 | 11/11 | ✅ |
| **Final — verify + report** | this commit | full battery 114/114 | 11/11 | ✅ |

**No BLOCKER.md files were written.** Every tier passed its gate before the next began.

Full loop-smoke battery (clean state between each): **114 checks, 0 failures**
— smoke-loops 30 · infra 21 · tier1 17 · tier2 15 · tier3 17 · ui 14.

---

## Benchmark baseline (ground truth)

Established by a live run of the 35-task harness against **Bobby**
(`CyberCrew/notmythos-8b:latest`):

| Category | Pass | Score |
|----------|------|-------|
| reasoning | 9/10 | 0.90 |
| retrieval | 10/10 | 1.00 |
| tool_chain | 5/5 | 1.00 |
| character | 5/5 | 1.00 |
| quality | 5/5 | 1.00 |
| **Overall** | **34/35** | **0.971** |

The single miss is `reason-5` — the bat-and-ball problem (correct: 5¢; model
answered 85¢), a well-known cognitive-bias trap. It is left *failing on purpose*:
a benchmark that scores 100% on its own model is not ground truth, it is a
rubber stamp. The harness must be able to say "no."

Saved to `state/loops/benchmarks/baseline.json`. Every future loop that claims an
improvement is checked against this number; if any **category** drops >10%, the
benchmark loop auto-rolls-back the most recent applied patch and pages the
operator.

---

## `detectGaming()` — the real heuristics

Not a stub. A loop result is flagged as gaming (→ verdict `halt`, operator
paged, proposals never applied) when **any** of these fire:

1. **Score outside [0,1]** — a broken or inflated self-report.
2. **Benchmark divergence (core):** claims improvement while the ground-truth
   benchmark dropped.
3. **No evidence:** claims improvement with an empty evidence array.
4. **Self-contradictory evidence:** benchmark-kind evidence that itself shows a
   drop while improvement is claimed.
5. **Implausible jump:** a self-reported score far above baseline with no
   benchmark backing.
6. **Perfect-with-no-proof:** a claimed score of 1.0 with no benchmark evidence.
7. **Fabricated references:** evidence citing a benchmark/trace id that does not
   exist (validated against the real known-refs set).
8. **No-op win:** claims improvement, proposes no change, and shows no
   ground-truth delta.
9. **Spec divergence:** the score climbed while the output stopped satisfying its
   declared spec ("looks better, isn't").
10. **Criteria mutation:** the evaluation criteria changed between runs while
    improvement is claimed (moving the goalposts).
11. **Shortcut pattern:** the same output signature repeated across recent runs
    (one canned answer regardless of input — textbook reward hacking).

Heuristics 9–11 use cross-run context the orchestrator builds from each loop's
trace history. Verified end-to-end by the smokes (criteria-mutation, shortcut,
and spec-divergence each force a `halt`).

---

## Backup / restore — verified

- **Backup before every write:** `lib/loops/backup.ts` snapshots every target
  file into `ARGOS_ROOT/restore/loops/<timestamp>/` with a manifest **before**
  the autonomous apply writes. No backup → no write.
- **Auto-rollback on test failure:** `lib/loops/apply.ts` runs backup → write →
  test (command / in-process fn / none) → keep if green, restore byte-for-byte
  if red. Outcomes logged to `state/loops/patches/{APPLIED,FAILED}/`.
- **Verified:** the infra + tier2 + tier3 smokes prove keep-on-green,
  rollback-on-red (byte-for-byte restore confirmed), governance refusal,
  out-of-boundary refusal, and the manual backup-browser restore route.

---

## The all-night doctrine, as built

- **No pending patches.** Non-governance code/config changes apply autonomously
  behind backup + test. The only thing that "waits" is a **governance** change —
  refused outright unless `ARGOS_RSI_ALLOW_GOVERNANCE=1`.
- **Governance is sacred.** `lib/loops/rsi-gate.ts` refuses any write to the
  executor / approvals / restore / audit / eval-gate / rsi-gate / auth /
  verify-argos / launchers — and anything outside `ARGOS_ROOT` — unless the
  special flag is set. Verified across infra, tier2, tier3 smokes.
- **Kill switches:** `ARGOS_LOOPS_APPLY=0` disables all autonomous writes;
  `ARGOS_LOOPS_AUTORUN=0` keeps the scheduler dormant.

---

## Loops live vs deferred

**All 20 loops are live.** Scheduled windows (fired from the heartbeat tick,
idempotent per day):

| Loop | When |
|------|------|
| Trace Analysis (4) | nightly 2 AM |
| Codebase Rewrite (3) | Saturday 2 AM (analysis report; targeted apply on demand) |
| Memory Consolidation (11) | Sunday 3 AM |
| RSI Propose (1) | Sunday 4 AM |
| Benchmark (19) | Sunday 5 AM (weekly baseline) |
| Self-Training (13) | Sunday 6 AM (weekly dataset) |
| Red/Blue Team (18) | Friday 11 PM |

Command loops: `/refine` (8), `/debate` (10), `/simulate` (15).
On-demand: every loop via `/api/loops/evolve`; red/blue via `/api/loops/redteam`.

**Honest scope notes (deferred, by design — not blocked):**

- **Self-Training (13) does not fine-tune locally.** There is no training
  toolchain on the rig and no new deps were taken. It genuinely *assembles and
  writes* a Modelfile/Alpaca-compatible dataset (`data/training/<date>.jsonl`)
  for a future off-rig fine-tune, and says so plainly.
- **Codebase Rewrite (3) does not pick-and-rewrite files unattended.** The 2 AM
  run writes a patch-proposal report; autonomous apply is scoped to an explicit
  operator/loop target (a wrong target at 2 AM can still typecheck). Targeted
  applies are real: backup → write → typecheck → keep/rollback.
- **Self-Refine → doc_generate auto-apply** was left out to avoid coupling the
  governed tools layer to the loop layer. `/refine` is fully live.

---

## What changed where (file map)

- **Core:** `lib/loops/{types,eval-gate,trace-store,benchmark,benchmark-baseline,
  loop,rsi-gate,orchestrator,scheduler,scheduler-hook,registry,backup,apply,
  lessons,questions,brief}.ts`
- **Loops:** `lib/loops/impl/{reflective,memory,optimize,agents,training,rsi}.ts`
- **API:** `app/api/loops/{status,traces,evolve,debate,simulate,refine,benchmark,
  feedback,approve-patch,evaluate,apply,rollback,redteam,patches,questions}/route.ts`
- **UI:** `app/loops/page.tsx`, `components/HUD.tsx` (LOOPS + Loop-patches rows),
  `components/LeftRail.tsx` (nav)
- **Integration:** `lib/heartbeat.ts` (pumps scheduled loops),
  `lib/morning-brief.ts` (loops addendum), `app/api/chat/route.ts` (boot)
- **Smokes:** `scripts/smoke-loops{,-infra,-tier1,-tier2,-tier3,-ui}.mjs`

No new npm dependencies were added at any tier. All 7 USB-Native rules pass.

---

## Verification log (Final)

- `npm run check:full` → **11/11** (lint, typecheck, build, verify-argos,
  audit-stub-honesty, audit-production-deps, smoke-launcher, smoke-h2,
  smoke-settings, smoke-vault, smoke-retrieval).
- Full loop-smoke battery → **114/114**.
- One real reflexion cycle against live data → outcome `accepted`, real lesson
  produced ("retry with exponential backoff for slow domains…"), real append-only
  trace written to `state/loops/reflexion-traces.jsonl`. Not a mock.
- Benchmark baseline established at **0.971** and saved.

The system improves itself, proves it against ground truth, backs up before it
writes, rolls back when it's wrong, refuses to touch its own governance, and
tells you in the morning what it did. As designed.
