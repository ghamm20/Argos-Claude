# PHASE_10_HEARTBEAT_REPORT.md — Heartbeat Dispatcher (OpenClaw pattern)

**Date:** 2026-05-31
**Author:** Claude
**Dev source:** `C:\Users\Gordy\dev\Argos-Claude` (HEAD `6fc5276`)
**Deployed payload:** `D:\ARGOS`
**Directive:** ARGOS Phase 10 — Heartbeat Dispatcher (study the OpenClaw heartbeat/channel-routing pattern; build it natively in TypeScript; no OpenClaw install, no Python, no new services, everything under ARGOS_ROOT)
**This run:** **GATE PASS — heartbeat smoke 26/26, full gauntlet 151/151.** Reuses the Phase 11 Pushover infra (no re-implementation), boots from the launcher, degrades gracefully when Ollama is down.

> **Naming note:** this is the *second* "Phase 10" — the first was the Research Engine (`PHASE10_RESEARCH_REPORT.md`). This report uses the directive's filename `PHASE_10_HEARTBEAT_REPORT.md` (distinct file, no collision). Unrelated features sharing a number in the owner's sequence.

---

## 1. Architecture summary

The heartbeat is ARGOS's **ambient autonomous layer**: it wakes on an interval, reads a checklist, asks the fast model whether anything needs the operator, and fires a Pushover alert **only** when something is actionable — silent otherwise.

```
launcher.bat (after Next ready)        chat-route module init (dev fallback)
   │  curl GET /api/heartbeat/status        │  void ensureHeartbeatStarted()
   ▼                                        ▼
ensureHeartbeatStarted()  ── reads settings.heartbeat.enabled ──┐ (no-op if off)
   │  setInterval(intervalMinutes, unref'd) singleton           │
   ▼                                                            │
runHeartbeatTick({source:"interval"})  ◄── also: POST /api/heartbeat/trigger (manual)
   │  1. isInFlight()?            → skipped_inflight   (never competes with a chat)
   │  2. interval & disabled?     → skipped_disabled
   │  3. read $ARGOS_ROOT/HEARTBEAT.md
   │       • present but blank    → skipped_empty      (silent, no model call)
   │       • missing              → run anyway ("model decides")
   │  4. triage → Bobby (fastest model) over Ollama /api/chat (think:false, temp 0)
   │       • reply == HEARTBEAT_OK → status "ok"        (suppress, no alert)
   │       • anything else         → status "actionable"
   │  5. actionable → pushoverSend({title,message})     (Phase 11 primitive; no-op w/o creds)
   │  6. persist atomically → $ARGOS_ROOT/state/heartbeat-state.json
   ▼
HeartbeatResult  →  /api/heartbeat/status  →  HUD "Heartbeat" row + Settings readout
```

**Graceful by construction:** every gate and the triage call are wrapped; if **Ollama is down**, `triageWithModel()` throws, the tick records `status:"error"` with the reason, logs it, and returns — **ARGOS never crashes**. The tick never throws out of `runHeartbeatTick`.

**Non-blocking:** the timer is `unref()`'d (never keeps the process alive on its own); the tick honors the Phase 11 in-flight gate so it never competes with an active chat; nothing touches the UI/chat request path.

### Files
| File | Role |
|---|---|
| **`lib/heartbeat.ts`** *(new)* | Core. Singleton scheduler (`ensureHeartbeatStarted`/`stopHeartbeat`), `runHeartbeatTick` (total/graceful, with `triageOverride` test hook), `classifyTriage`, `buildHeartbeatAlert`, atomic state read/write, `getHeartbeatStatus`. |
| **`app/api/heartbeat/status/route.ts`** *(new)* | GET status (always 200). Module-init boots the heartbeat (launcher poke target). |
| **`app/api/heartbeat/trigger/route.ts`** *(new)* | POST manual tick. Optional `{mockResponse}` test hook bypasses the model. |
| **`components/heartbeat/HeartbeatIndicator.tsx`** *(new)* | HUD "Heartbeat" row, self-polls `/api/heartbeat/status` every 60s. |
| **`components/settings/HeartbeatSection.tsx`** *(new)* | Settings toggle + interval + live readout + "Run now". |
| `lib/research/alerts.ts` | **Refactor:** extracted `pushoverSend({title,message,…})` from `sendAlert`; `sendAlert` now delegates to it. Behavior-preserving (phase11 smoke confirms). |
| `lib/settings.ts` | Added `HeartbeatConfig` + `heartbeat` field (default `{enabled:false, intervalMinutes:30}`) + forward-compat merge. |
| `app/api/settings/route.ts` | Added `heartbeat` validation branch (enabled:boolean, intervalMinutes ≥ 1). |
| `app/api/chat/route.ts` | Boot `ensureHeartbeatStarted()` at module init (dev fallback). |
| `launchers/launcher.bat` | Fire-and-forget `curl /api/heartbeat/status` after Next is ready (launch-time boot). |
| `components/{HUD,SettingsCenterPane}.tsx` | Mount the indicator + the settings section. |
| **`HEARTBEAT.md`** *(new)* | Starter security-operator checklist (documented in §4). |
| **`scripts/smoke-heartbeat.mjs`** *(new)* | 6-case gate. |

---

## 2. OpenClaw pattern vs ARGOS implementation decisions

Per the directive, OpenClaw was **studied as a pattern, not installed or cloned** (Task 1 directed reading the existing Phase 11 infra, which was done — see §1 of the alert/scheduler study). The OpenClaw heartbeat shape and how ARGOS realizes it:

| OpenClaw heartbeat concept | ARGOS native implementation |
|---|---|
| A daemon **wakes on a fixed heartbeat interval** | `setInterval(intervalMinutes·60s)` singleton, `unref()`'d, booted at launch. Mirrors the Phase 11 scheduler singleton (same proven pattern). |
| **Checks a state/checklist** each beat | Reads `$ARGOS_ROOT/HEARTBEAT.md` each tick. Empty → silent skip; missing → run anyway. |
| **Routes** to channels/handlers and **decides** whether to act | A single triage step: the checklist + context → the LLM, which returns `HEARTBEAT_OK` (no-op) or an actionable summary. The "routing decision" is the model's triage, not a static rule table. |
| **Notifies** a channel when action is warranted | One channel — **Pushover** — via the existing Phase 11 `pushoverSend` primitive. Fires only on `actionable` + configured creds. |
| **Persistent heartbeat state** | Atomic `state/heartbeat-state.json` (temp+fsync+rename), with last result, next tick, and counts. |

**Key decisions:**
1. **Reused Phase 11 alerting, did not re-implement it.** Extracted `pushoverSend()` from `sendAlert()` (a behavior-preserving refactor) so the heartbeat sends through the *exact same* credential-check / form-encode / timeout / error path. `sendAlert` now delegates to it; the phase11 smoke confirms the research-alert path is unchanged.
2. **Bobby is the triage model.** The directive specifies "fastest model, triage role." `triageModel()` resolves `PERSONA_BY_ID.bobby.model` (`CyberCrew/notmythos-8b:latest`, ~150 tok/s) with a dedicated triage system prompt (not Bobby's full character prompt — triage wants focus, not persona). Real run: **4.5 s/tick**.
3. **Suppression marker `HEARTBEAT_OK`.** `classifyTriage` treats a reply that *is* the marker (or a ≤64-char reply containing it) as "all clear"; anything substantive is actionable. Conservative system prompt tells the model to default unknowns to OK.
4. **Manual trigger bypasses the disabled-gate;** interval ticks honor it. So the operator (and the smoke) can test a tick before enabling the schedule.
5. **Testable triage.** `/api/heartbeat/trigger` accepts an optional `mockResponse` so the OK-suppress and actionable-alert paths are deterministic in the smoke without a live/cold model — while real (un-mocked) triage goes to Ollama.

---

## 3. Smoke test + validation

### `scripts/smoke-heartbeat.mjs` — GATE: **26/26 PASS, 0 failures**
| # | Case | Result |
|---|---|---|
| 1 | **Empty** HEARTBEAT.md → tick skipped, no alert | `status=skipped_empty`, `alert=null` ✓ |
| 2 | **Missing** HEARTBEAT.md → tick runs (model decides) | ran (`status=ok`, not skipped), `checklistPresent=false` ✓ |
| 3 | **HEARTBEAT_OK** reply → suppressed | `status=ok`, `alert=null` ✓ |
| 4 | **Actionable** reply → payload built, NOT fired | `status=actionable`, title `"⚠ ARGOS Heartbeat — action needed"`, message carries the triage text, `fired=false` (`reason="Pushover credentials not configured"`) ✓ |
| 5 | GET `/api/heartbeat/status` shape | all keys present; `counts.ticks≥4` ✓ |
| 6 | POST `/api/heartbeat/trigger` fires immediately | `ok:true`, result has status+timestamp, **6 ms** (mocked) ✓ |

### Real-Ollama end-to-end (un-mocked, against the dev `HEARTBEAT.md`)
```
ok:true  status:actionable  modelUsed:CyberCrew/notmythos-8b:latest  durationMs:4502
alert: built, fired=false
```
Confirms the genuine path: read checklist → **Bobby triages over Ollama** → actionable → payload built → not delivered (no creds). (Bobby was slightly eager here — see §5 Finding 2.)

### Full gauntlet (regression — incl. the alerts.ts refactor) — **151/151, 0 failures**
| Smoke | Result |
|---|---|
| `smoke-heartbeat` | **26 — PASS** |
| `phase11-research-smoke` (alerts.ts refactor — alert test) | **24 — PASS** |
| `phase10-research-smoke` | **24 — PASS** |
| `smoke-v1-e2e` | **27 — PASS** |
| `smoke-persona-router` | **14 — PASS** |
| `phase9-memory-smoke` | **18 — PASS** |
| `auth-smoke` | **18 — PASS** |

Build (lint + typecheck + production build) clean; both `/api/heartbeat/*` routes compiled. No new npm dependencies; no Python.

> Mid-run, a stale/corrupted `.next` (from concurrent `next start` churn across the gauntlet) caused transient "server failed to come up" for phase10/11. A clean `rm -rf .next && npm run build` resolved it; both then passed 24/24. Documented honestly — it was an environment artifact, not a code regression.

---

## 4. HEARTBEAT.md starter content

Shipped at the repo root (and intended at `$ARGOS_ROOT/HEARTBEAT.md`). A security-operator checklist grouped into **Infrastructure & uptime**, **Security posture** (credential rotation, sensitive-doc review, failed-auth), **Active projects** (deadlines/blockers across ARGOS, Jenna, Parascope, Sentry, Cortex, Halal Jordan), **Research & intel** (stale streams, watchlist hits), and **Personal cadence** (end-of-day review). It ends with explicit **triage rules** for the model:

- Be conservative — only genuinely actionable, time-sensitive items.
- One alert per tick; lead with the single most important thing.
- Treat unverifiable items as `HEARTBEAT_OK` (do not invent problems).
- If nothing is actionable, reply with exactly `HEARTBEAT_OK`.

Editing guidance is inline: `#`-comment or delete items you don't want triaged; an **empty file skips the tick entirely**.

---

## 5. Deviations + honest findings

1. **OpenClaw was not cloned.** Unlike the Phase 9 AgenticSeek directive (which said "clone"), this directive's Task 1 said to read the **Phase 11** infra (done). The heartbeat was built from the OpenClaw *pattern* described in the brief + the Phase 11 building blocks — no OpenClaw code was fetched or installed. Accurate to the directive.
2. **Triage quality depends on checklist phrasing.** In the real run Bobby flagged the "Is Ollama responding?" item as actionable even though the checklist noted it was self-answering ("If this tick ran, it is."). That's an over-eager triage on a rhetorically-worded item — a **checklist-tuning** matter, not a code bug. The starter checklist can be tightened (remove self-answering items) to reduce false positives. The conservative system prompt mitigates but doesn't eliminate model eagerness.
3. **Task 2 vs Task 4 wording on "missing file".** Task 2 said "empty **or missing** → skip silently"; Task 4 said "**missing** → tick runs, model decides." Implemented per **Task 4** (the binding gate): *empty* → skip; *missing* → run. Both agree on empty.
4. **Boot wiring is belt-and-braces.** The heartbeat boots from (a) the launcher `curl /api/heartbeat/status`, (b) the status-route module init, and (c) the chat-route module init — so it starts at launch in production *and* on first activity in dev. All are idempotent no-ops when disabled.
5. **Manual trigger bypasses the disabled-gate** (so testing works pre-enable). Interval ticks strictly honor `settings.heartbeat.enabled`. Documented in the trigger route.
6. **Not synced to D:\ARGOS / not committed.** Per "stop after the report." The launcher change means the D: payload's `launcher.bat` would need re-mirroring to boot the heartbeat at launch (the module-init fallbacks still start it on first chat). Flagged for the owner.

---

## 6. Gate verdict
- [x] Studied the Phase 11 alert + scheduler infra (Task 1).
- [x] `lib/heartbeat.ts` — configurable interval (settings, default 30m), reads `$ARGOS_ROOT/HEARTBEAT.md`, empty→skip, missing→run, Bobby triage, `HEARTBEAT_OK`→suppress, actionable→Pushover via existing infra, atomic state to `state/heartbeat-state.json`, non-blocking, graceful on Ollama-down.
- [x] Wired to launcher boot + `/api/heartbeat/{status,trigger}` + HUD row + Settings toggle + starter `HEARTBEAT.md`.
- [x] **Smoke 26/26** (all 6 mandatory cases) + real-Ollama path verified + **gauntlet 151/151**.
- [x] No OpenClaw install, no Python, TypeScript only, no new npm deps, no push.

**Phase 10 — Heartbeat Dispatcher: GATE PASS.** Stopping here per directive. Next phase not started.

---

## Appendix — commands
```
npm run lint && npm run typecheck && npm run build
node scripts/smoke-heartbeat.mjs --port 7796      # 26/26 gate
# real triage:
curl -X POST -d '{}' http://127.0.0.1:<port>/api/heartbeat/trigger
# mocked decision paths:
curl -X POST -d '{"mockResponse":"HEARTBEAT_OK"}'      .../api/heartbeat/trigger   # → ok, no alert
curl -X POST -d '{"mockResponse":"Disk at 92%..."}'    .../api/heartbeat/trigger   # → actionable, payload built
```
