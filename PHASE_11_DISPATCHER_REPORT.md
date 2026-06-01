# PHASE_11_DISPATCHER_REPORT.md — OpenClaw Dispatcher

**Date:** 2026-05-31
**Author:** Claude
**Dev source:** `C:\Users\Gordy\dev\Argos-Claude` (HEAD `4910aff`)
**Deployed payload:** `D:\ARGOS`
**Directive:** ARGOS Phase 11 — OpenClaw Dispatcher (native TypeScript; no OpenClaw install; everything under ARGOS_ROOT)
**This run:** **GATE PASS — dispatcher smoke 35/35.** Heartbeat regression 26/26 (rewire safe). Real-Ollama dispatch verified. Build clean; no new deps; no Python.

> **Naming note:** this is the *second* "Phase 11" — the first was the Research scheduler/Pushover engine (`PHASE11_RESEARCH_REPORT.md`). This report uses the directive's filename `PHASE_11_DISPATCHER_REPORT.md` (distinct file). The dispatcher *reuses* that earlier Phase 11's `pushoverSend`.

---

## 1. OpenClaw pattern vs ARGOS implementation

OpenClaw was **studied as a pattern, not installed** (no clone, no Python, no external service). Three of its patterns are now native in ARGOS:

| OpenClaw pattern | ARGOS implementation |
|---|---|
| **Dispatcher** — route inbound events to a handler by type/content | `lib/dispatcher.ts` — `dispatchEvent()` classifies an event (explicit type → domain keywords → persona-router fallback → default Bartimaeus) and routes to the matching persona over Ollama. |
| **Markdown memory** — plain `.md` files as the memory layer (daily log + long-term) | `ARGOS_ROOT/memory/MEMORY.md` (long-term, append-only) + `ARGOS_ROOT/memory/YYYY-MM-DD.md` (per-day), atomic temp+fsync+rename. |
| **Skills** — Markdown capability files read on demand, not compiled | `ARGOS_ROOT/skills/*.md` — the dispatcher injects the routed persona's skill into its system prompt each event. Markdown only; no executable code. |

This phase **wires together existing subsystems** rather than re-implementing them:
- `lib/persona-router.ts` (`classifyByKeyword`) — content classification fallback
- `lib/research/alerts.ts` (`pushoverSend`) — alert delivery
- the scheduler's atomic temp+fsync+rename discipline — durable writes
- the heartbeat — now hands actionable items to the dispatcher

---

## 2. Dispatcher architecture

```
event {type, content, source}
   │   (heartbeat actionable result  OR  POST /api/dispatch)
   ▼
classifyDispatchPersona(type, content)
   1. explicit type   security/threat→Bart · research/intel→Sage ·
                       ops/scheduling→Bobby · comms/relationship→Juniper
   2. domain keywords  (threat→Bart, research→Sage, disk/deploy→Bobby, reply→Juniper)
   3. persona-router classifyByKeyword(content)
   4. default → Bartimaeus
   ▼
loadSkill(persona)         skills/<security-triage|research-synthesis|ops-dispatch>.md
   │                        (graceful: missing skill → proceed without)
   ▼
persona ACTS               Ollama /api/chat: system = dispatch prompt + skill,
   │                        user = event content. think:false, temp 0.
   │                        (responseOverride test hook bypasses the model)
   ▼
classifyDispatchResponse   reply == DISPATCH_OK → "ok" (suppress) · else "actionable"
   ▼
writeMemory  → MEMORY.md + YYYY-MM-DD.md   (ALWAYS — even ok/error; atomic append)
   ▼
if actionable → pushoverSend({title, message})   (reuses Phase 11 primitive; no-op w/o creds)
   ▼
persist dispatcher-state.json (atomic) → /api/dispatch (GET) → HUD "Dispatcher" row
```

**Graceful by construction:** if Ollama is down, `actWithPersona` throws → caught → `status:"error"`, the event is **still logged to memory**, no alert fires, and ARGOS never crashes. `dispatchEvent` is a total function.

### Files
| File | Role |
|---|---|
| **`lib/dispatcher.ts`** *(new)* | Core: `dispatchEvent`, `classifyDispatchPersona`, `classifyDispatchResponse`, skill loader, atomic Markdown memory writers, atomic state, `getDispatcherStatus`. |
| **`app/api/dispatch/route.ts`** *(new)* | POST `{type, content, source?, mockResponse?}` → dispatch. GET → status (for the HUD). |
| **`components/dispatcher/DispatcherIndicator.tsx`** *(new)* | HUD "Dispatcher" row — self-polls `/api/dispatch`; shows last event → persona + count. |
| **`skills/{security-triage,research-synthesis,ops-dispatch}.md`** *(new)* | Markdown skills (no code). |
| `lib/heartbeat.ts` | Actionable triage now routes **through the dispatcher** before alerting (directive); `result.alert` mirrors the dispatch delivery. |
| `components/HUD.tsx` | Mounts the dispatcher row beside the heartbeat row. |

### Routing map (directive)
| Event domain | Persona | Skill |
|---|---|---|
| Security / threat | **Bartimaeus** | security-triage |
| Research / intel | **Sage** | research-synthesis |
| Operational / scheduling | **Bobby** | ops-dispatch |
| Comms / relationship | **Juniper** | (none in starter set) |
| Default fallback | **Bartimaeus** | security-triage |

---

## 3. Skills system

- Skills live at `ARGOS_ROOT/skills/*.md` — **Markdown only, no executable code** (constraint honored). Operator-editable; the dispatcher re-reads the file on every event (no restart).
- On each event, the dispatcher loads the routed persona's skill and injects it into the system prompt between a `--- SKILL: <name> ---` / `--- END SKILL ---` fence, ahead of the event content.
- **Graceful:** a missing skill file → the dispatch proceeds without one (`skillUsed: null`). The smoke seeds the skills into its tmp ARGOS_ROOT to exercise injection.
- The three starter skills give each persona concrete triage guidance (what to look for, how to decide, when to reply `DISPATCH_OK`, style). The real-Ollama run below shows the ops skill visibly shaping Bobby's output.

---

## 4. Memory log structure

- **`memory/MEMORY.md`** — long-term, **append-only, never overwritten**. Created with a header on first write; every dispatch appends a date+time-stamped entry.
- **`memory/YYYY-MM-DD.md`** — one per day, auto-created with a day header; the same entry is appended here for per-day detail (OpenClaw daily-log pattern).
- **Atomic writes** — read-modify-write via temp-file + `fsync` + `rename` (same discipline as `scheduler.ts`); a reader always sees the old or new whole file, never a partial write.
- Entry shape:
  ```
  ### 2026-05-31 20:14:07Z — [ops] → Bobby  (actionable)
  - **source:** heartbeat
  - **skill:** ops-dispatch
  - **event:** Vault drive D: at 92% capacity…
  - **response:** Disk at 92% — prune old logs before the next ingest…
  - **alert:** not fired — ⚠ ARGOS Dispatch — Bobby (ops) (Pushover credentials not configured)
  ```

---

## 5. Smoke results

### `scripts/smoke-dispatcher.mjs` — GATE: **35/35 PASS, 0 failures**
| Area | Result |
|---|---|
| Security event → **Bartimaeus** (+ security-triage skill, actionable, alert built) | ✓ |
| Research event → **Sage** (+ research-synthesis skill, DISPATCH_OK suppressed, no alert) | ✓ |
| Ops event → **Bobby** (+ ops-dispatch skill, actionable, alert message carries "92%", not fired) | ✓ |
| Comms event → **Juniper** | ✓ |
| **DISPATCH_OK → suppressed, no alert, memory still written** | ✓ |
| **Actionable → alert payload constructed, not fired (no creds), memory written** | ✓ |
| **Daily log created** at `memory/YYYY-MM-DD.md` (with day header) | ✓ |
| **MEMORY.md appended** (long-term header + both events + routed personas) | ✓ |
| GET `/api/dispatch` status shape + count ≥ 4 | ✓ |
| Missing `type` → 400 (graceful) | ✓ |

### Real-Ollama dispatch (un-mocked, dev ARGOS_ROOT)
```
POST /api/dispatch {type:"ops", content:"D: at 92% … backup due in 20 min"}
→ ok:true  persona:bobby  skill:ops-dispatch  status:actionable  durationMs:2410
  response: "Disk at 92%, next backup overdue in 20m, reschedule backup."
  alert: built, fired=false
```
Confirms the genuine path: classify → route to Bobby → inject ops-dispatch skill → **Bobby acts over Ollama (2.4 s)** → actionable → alert built → memory written. The skill visibly shaped the reply (terse, action-first, named the fix) — exactly its style guidance.

### Heartbeat regression (the rewire) — **smoke-heartbeat 26/26 PASS**
The heartbeat's actionable path now routes through the dispatcher; the heartbeat smoke is unchanged and still green (the dispatch alert carries the triage content + a non-empty title + `fired=false`, satisfying every assertion).

### Other gauntlet
`smoke-v1-e2e 27` · `smoke-persona-router 14` · `phase9-memory 18` · `auth 18` — all PASS. Build (lint + typecheck + production build) clean; `/api/dispatch` compiled; no new npm deps.

---

## 6. Deviations + honest findings

1. **Directive path names corrected.** The directive referenced `lib/scheduler.ts` and `lib/alerts.ts`; in this codebase they are `lib/research/scheduler.ts` and `lib/research/alerts.ts`. Read + reused those.
2. **Heartbeat → dispatcher, no double model call.** The directive says "after Bobby triage, if actionable, pass to dispatcher before alert." Bobby's triage already produced the actionable text, so the heartbeat threads it into `dispatchEvent` as `responseOverride` — the dispatcher classifies/logs/alerts **without** a second model round-trip. A `?? fallback` covers the unlikely null-alert case so an actionable item is never dropped.
3. **Pre-existing research-smoke failures (NOT this phase).** `phase11-research-smoke` (1 fail: "≥1 research-tagged memory entry — 0 of 0") and `phase10-research-smoke` (2 fails) are red. **Verified pre-existing:** I stashed all my changes, rebuilt at clean HEAD `4910aff`, and phase11 failed **identically** — so this is the research→Phase-9-memory async-write path, untouched by the dispatcher (the dispatcher only runs via `/api/dispatch` or the heartbeat actionable path, neither of which the research smokes exercise). Flagged honestly; out of scope for this phase. (These also depend on live internet + async memory timing.)
4. **Two memory layers coexist.** Phase 9 memory is `data/memory/<persona>/*.jsonl` (structured operator memory); this phase's `memory/MEMORY.md` is a separate human-readable Markdown dispatcher log. Different dirs, no collision.
5. **Skills/memory ship at ARGOS_ROOT.** `skills/*.md` is committed in the repo; at runtime the dispatcher reads `ARGOS_ROOT/skills` and writes `ARGOS_ROOT/memory`. For the **D: payload**, `skills/` would need to be copied into `D:\ARGOS\skills\` for skill injection there (the dispatcher degrades gracefully without it). Flagged for a deploy step.
6. **Comms has no starter skill.** The directive specified three skills (security/research/ops); Juniper/comms dispatches without one (graceful `skillUsed:null`). Intentional — matches the directive's skill list.

---

## 7. Gate verdict
- [x] `lib/dispatcher.ts` — event intake + routing + action loop, graceful (Ollama down → log + skip, never crash), atomic memory writes.
- [x] Routing: security→Bart, research→Sage, ops→Bobby, comms→Juniper, default→Bart.
- [x] Markdown memory: `memory/MEMORY.md` (append-only) + `memory/YYYY-MM-DD.md`, atomic.
- [x] Skills: `skills/{security-triage,research-synthesis,ops-dispatch}.md` injected per event; Markdown only.
- [x] `/api/dispatch` (POST + GET) + HUD "Dispatcher" row + heartbeat→dispatcher wire.
- [x] **smoke-dispatcher 35/35** + real-Ollama dispatch verified + heartbeat 26/26 (no regression).
- [x] No OpenClaw install, no Python, TypeScript only, no new npm deps, no push.

**Phase 11 — OpenClaw Dispatcher: GATE PASS.** Stopping here per directive. Next phase not started; nothing committed or pushed.

---

## Appendix — commands
```
npm run lint && npm run typecheck && npm run build
node scripts/smoke-dispatcher.mjs --port 7797     # 35/35 gate
node scripts/smoke-heartbeat.mjs                  # 26/26 (rewire regression)
# real dispatch:
curl -X POST -H 'content-type: application/json' \
  -d '{"type":"ops","content":"D: at 92% …"}' http://127.0.0.1:<port>/api/dispatch
# mocked routing/suppress:
curl -X POST -d '{"type":"research","content":"…","mockResponse":"DISPATCH_OK"}' .../api/dispatch
```
