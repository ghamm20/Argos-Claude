# ARGOS Loops — Live Validation (v2.2.0)

**Date:** 2026-06-02 · **Build:** v2.2.0 · **Ollama:** 127.0.0.1:11434

This is the honest record of what actually fires end-to-end against **real
production state** (`ARGOS_ROOT=D:\ARGOS` — the operator's deployed payload, 23
real operator facts) versus what only passes synthetic smokes. Run with the
freshly-built v2.2.0 code (forced current-facts tools + version bump included).

## Smoke battery (synthetic fixtures) — 114/114

Clean prod build, clean state between each:

| Smoke | Checks | Result |
|---|---|---|
| smoke-loops | 30 | PASS |
| smoke-loops-infra | 21 | PASS |
| smoke-loops-tier1 | 17 | PASS |
| smoke-loops-tier2 | 15 | PASS |
| smoke-loops-tier3 | 17 | PASS |
| smoke-loops-ui | 14 | PASS |
| **Total** | **114** | **0 failures** |

`check:full` → **11/11**.

## Operational loops — REAL run against `D:\ARGOS` production state

Each was triggered once via `/api/loops/evolve` (or `/benchmark`) against the
live payload. Every one wrote a real append-only trace to
`D:\ARGOS\state\loops\` — confirmed present after the run:
`reflexion-traces.jsonl`, `trace_analysis-traces.jsonl`,
`memory_consolidation-traces.jsonl`, `ouroboros_rag-traces.jsonl`,
`benchmark-traces.jsonl`, `lessons.json`, `rag-config.json`, `benchmarks/`,
`failure-report-2026-06-02.md`.

| Loop | Fires end-to-end? | Live result | Honest caveat |
|---|---|---|---|
| **Reflexion (7)** | ✅ FULL | `accepted`. Real model call on a **real failure** (this morning's stale-president answer) → lesson: *"Always verify current, time-sensitive factual data by executing a web search rather than relying solely on potentially outdated training data."* Wrote `reflexion-traces.jsonl` + `lessons.json` (lessonId `1f655084`). | None. Lesson is apt and independently corroborates the Task 1 fix. |
| **Trace Analysis (4)** | ✅ FIRES | `accepted`. Read live traces, wrote `failure-report-2026-06-02.md` to production state. | Production had only **2 traces** at run time, so the analysis was necessarily thin — it ran and wrote the report, but there was little to analyze. |
| **Memory Consolidation (11)** | ✅ FIRES (partial output) | `accepted`. Read **23 real operator facts**, archived a snapshot to `D:\ARGOS\data\memory\archive\2026-06\facts-…jsonl`, made the consolidation model call. | The consolidated-list **parse returned 0 kept lines** this run (the model didn't emit the bulleted format the parser expects), so the proposal was empty and quality scored 0. The read + archive + model call all fired; the consolidation OUTPUT quality is model-format-dependent. Known limitation, also seen in Tier 1. |
| **Ouroboros RAG (9)** | ✅ FULL | `accepted`. Real corpus of 23 facts; keyword recall 3 → 0 on the model's reformulation; threshold **self-loosened to 0.28** in response (correct behavior on poor recall). Wrote `rag-config.json`. | The reformulation REDUCED recall this run (3→0) — a single reformulation is not guaranteed to improve; the loop fired and self-adjusted correctly, but did not improve recall on this particular query. |
| **Benchmark Harness (19)** | ✅ FULL | Live 35-task run: **0.971 (34/35)**, `improved=false` (matches baseline, no change), `gaming=false`. Wrote `benchmarks/` + `benchmark-traces.jsonl`. | None. Consistent with the established baseline. The one miss remains the bat-and-ball trap, failing on purpose. |

**Verdict:** all five operational loops fire genuinely end-to-end against
production — real model calls, real reads of the 23 operator facts, real writes
to the production payload's `state/loops/`. **None are smoke-only.** Two carry
honest single-run quality caveats (memory-consolidation's parse, ouroboros's
reformulation) that are about output *quality*, not whether the loop *fires*.

## Task 1 — forced current-facts tool calls (live-proven)

The headline fix for "Bart said Joe Biden is president from training data."
Sent to `/api/chat` (operator + Bartimaeus): *"Who is the current president of
the United States right now?"* The current-facts detector fired and the route
forced a **server-side `web_search` before generation** — audit confirms:

```
{"toolId":"web_search","approved":null,"ok":true,
 "summary":"5 result(s) for \"Who is the current president of the United States right now?\"",
 "persona":"bartimaeus","durationMs":1038}
```

The tool fired **automatically** — Bart did not have to choose to call it — and
the fresh results were injected as authoritative context overriding training
data. `detectCurrentFacts` is conservative on clearly-historical phrasing
("who *was* the first president" does not trigger) and fires on office-holders,
"current/latest/today", near-current years (2024+), prices, weather, news,
sports, and datetime.

## Task 2 — HUD build label → v2.2.0

`package.json` version bumped to **2.2.0** in BOTH the dev repo and the deployed
`D:\ARGOS\app\package.json` (the HUD's `runtime.version` is read from
`package.json` at the process cwd, which on the running payload is
`D:\ARGOS\app`). The HUD "Build" row will read `v2.2.0` after the next restart.

---

Honest failures only: nothing here is claimed that wasn't observed. Where a loop
produced thin or empty output on its single live run, that is stated plainly
above rather than dressed up as a clean pass.
