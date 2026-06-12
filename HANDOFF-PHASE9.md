# ARGOS HANDOFF PACKET — Phase 9 (Oculus fusion), mid-phase
**Written:** 2026-06-11 · **Supersedes:** HANDOFF.md (Phase 1 era)
**Read CLAUDE.md in full before acting. This packet is state, not doctrine — CLAUDE.md wins on any conflict.**

---

## 1. WHO / WHAT / WHERE

- **Project:** ARGOS — local-first, USB-native AI workstation. Next.js 14 / TypeScript. Bart (Bartimaeus) is the boot persona.
- **Dev repo (source of truth):** `C:\Users\Gordy\dev\Argos-Claude` → GitHub `ghamm20/Argos-Claude`, branch `main`.
- **Deploy (payload):** `D:\ARGOS` — freshly re-migrated 2026-06-10, build current (v2.4.3, all Phase-9 routes present).
- **Desktop copy:** `C:\Users\Gordy\Desktop\ARGOS` — older working-dir payload; NOT the deploy target anymore. Don't confuse the two.
- **Oculus (OSINT/geospatial):** canonical = private fork `ghamm20/Oculus_Osint`; working copy `C:\AI\OCULUSBOUND\Oculus-osint-main` (verified on fork history). `D:\OCULUS` is the future Phase-10 home — only clone there if the C:\AI copy is stale/absent.
- **Ports:** ARGOS UI 7799 (Tailscale-exposed, NOT loopback-only — security matters), Ollama 11434, Oculus 3011 (canonical — the spec's 3010 was superseded; compose binds `3011:3000`).
- **Hardware:** RTX 3060 Ti 8GB = "lean" tier. POWER tier is mock-verified only (5090-day checklist in Phase 7 report).
- **Models:** Bart AND Sage → `aratan/gemma-4-E4B-q8-it-heretic:latest`. Bobby → `CyberCrew/notmythos-8b:latest`. Global defaultModel = Bart's gemma-4. Trust `MODEL_*` constants in code, not docs.

## 2. OPERATING PROTOCOL (non-negotiable)

1. **Phase-gated.** Work autonomously inside ONE phase; loop until gates pass with **demonstrated proof, never assertion**. Unverifiable = say "UNVERIFIED".
2. **STOP for owner release** ("Phase N accepted. Begin Phase N+1."). Riders/conditions arrive with acceptances — execute them in the stated order.
3. **No push without explicit approval.** Commit locally freely; push only the commits the owner names.
4. **Gate immutability (Rule 11):** never change a test/threshold mid-phase without owner approval BEFORE the change.
5. Report failures verbatim. Blockers = one-line report, don't bypass auth or improvise around them.
6. No new dependencies without flagging. NTFS paths. Seven USB-Native Rules enforced by `scripts/verify-argos.mjs` (Rule 1 = no hardcoded absolute paths in committed source — assemble from env/parts in proofs).
7. **3-axis diagnosis discipline:** never blur model-integrity / arch-compat / hardware-envelope / persona-logic. Name the axis before changing anything.
8. **Owner's parallel work — DO NOT TOUCH/REVERT:** `components/ChatPane.tsx`, `components/BartAvatar.tsx`, `components/voice/PlayButton.tsx`, `lib/voice-speech.ts`, `lib/voice-tap.ts` (commits `9a95b22`, `c7a82e8`, pushed).

## 3. GIT STATE (exact, as of this handoff)

**Dev repo `main` — ahead of origin by 5, ALL LOCAL, NO PUSH APPROVED YET:**
| Commit | Contents |
|---|---|
| `abd3a38` | Phase 9 rider: vault chunk-hash trust boundary (quarantine + heal_unverified grace) — proof 10/10 |
| `22cf7d1` | Phase 9 ARGOS side: `chat.inference` audit `origin:"oculus"` attribution; OCULUS map pane (6th workspace pillar); `proof-phase9-oculus-fusion.mjs` (9/9) |
| `8c331dc` | launcher.bat OCULUS_ROOT → C:\AI\OCULUSBOUND; map pane port → 3011; migrate now PRESERVES existing `config/settings.json` (was clobbering AUTH + default model); `proof-phase9-runtime-gates.mjs` added |
| `acd7dd5` | `tools/oculus/` (start/stop/compose) folded into SOURCE (was deploy-only → regressed every redeploy) |
| `9352ec5` | migrate fix: copies `tools/oculus` additively (migrate previously copied NO part of tools/) |

**Oculus fork (`C:\AI\OCULUSBOUND\Oculus-osint-main`) — ahead of origin by 1, LOCAL, NO PUSH:**
- `a6ef545` — `/api/assistant/chat` rewritten as thin proxy to ARGOS (zero direct Ollama); panel offline strings Ollama→ARGOS.

## 4. PHASE 9 — WHAT'S DONE (proven)

**Spec:** Oculus map-pane fusion. Oculus assistant = thin proxy to ARGOS (zero direct Oculus→Ollama, grep + runtime proof), single ARGOS-owned audit chain, Oculus keeps its geospatial DB, map pane in the Phase 6 workspace.

- **Proxy rewrite** (`a6ef545`): `src/app/api/assistant/chat/route.ts` → POSTs `{messages, personaId:"sage", model: gemma-4, useRetrieval:false}` to `ARGOS_CHAT_URL` (default `http://127.0.0.1:7799/api/chat`), header `x-oculus-origin: assistant-chat`, **no bearer = deliberate guest isolation**. Local `logs/assistant-proxy.jsonl` breadcrumb is explicitly NON-authoritative. Original API contract preserved (`{message, model, offline}`).
- **Audit attribution** (`22cf7d1`): ARGOS `lib/chat/orchestrator.ts` reads the header at handleChat entry; `chat.inference` payload gains `origin:"oculus", oculusOrigin:<header>` — only when present.
- **Map pane** (`22cf7d1` + `8c331dc`): 6th pillar in `app/workspace/page.tsx`, iframe `data-testid="oculus-map"`, src `NEXT_PUBLIC_OCULUS_URL` default `http://127.0.0.1:3011`. Storage key bumped to `argos_pillars_v2`.
- **Code-gate proof:** `scripts/proof-phase9-oculus-fusion.mjs` **9/9** — static grep (comment-stripped: no 11434/ollama/LOCAL_LLM in route code; ARGOS_CHAT_URL + x-oculus-origin present) + runtime (proxy-shaped request → spawned ARGOS → audit entry `origin:oculus`, control turn NOT attributed). Run again any time; needs Ollama up + dev built.
- **Chunk-hash rider closed** (`abd3a38`): sha256 at ingest (`vault.ingested.chunkSha256`), verified at heal, unknown chunks → `vault/index/quarantine/` + `vault.chunk_quarantined` audit, provenance-less copies → `vault.heal_unverified` grace. Proof 10/10; non-regressive (14/14 vault + 11/11 citation). CLAUDE.md rule 10a. **Owner has seen this reported.**

## 5. PHASE 9 — WHAT REMAINS (the phase does NOT close without these)

**Owner's explicit ruling: all four runtime gates must pass; code gates are necessary, not sufficient.**

Harness ready: `scripts/proof-phase9-runtime-gates.mjs` (in `8c331dc`). Gates:
- **A** — live pane query: POST real Oculus `/api/assistant/chat` → ARGOS audit gains `chat.inference origin:oculus` (verbatim printed).
- **B** — Oculus standalone serves independently (`/api/health` 200 + `/api/sensors/entities` reachable).
- **C** — map pane renders in ARGOS `/workspace` (page serves + Oculus map doc reachable for the iframe).
- **D** — entity count intact pre/post (`/api/sensors/entities.total`). Auto-resolves data source: if `no_data_loaded`, fires one `/api/sensors/refresh` live-feed pull, records baseline, **states which source was used** (owner requires this stated).

**Sequencing trap:** the harness spawns its own ARGOS on 7799 with a throwaway ARGOS_ROOT. **The owner ruled Gate A must read the CURRENT live D:\ARGOS audit chain** (`D:\ARGOS\state\audit\chain.jsonl`), so when the real deploy is running on 7799: do NOT spawn — let the proxy hit the live deploy and assert against the live chain (adapt the harness or assert manually; the live deploy's settings have a PIN, but the proxy sends no bearer → guest mode, which is the designed posture).

**Owner-side preconditions (he said he'll do these and signal):**
1. Relaunch `D:\ARGOS\launcher.bat` (must be a FRESH process to pick up the corrected OLLAMA_HOST env — see §6).
2. Gate AUTH: Settings → flip `requirePin → true` (PIN hash already on disk; one toggle; the R1(b) settings-guard allows it).
3. Start Oculus: Docker Desktop + `D:\ARGOS\tools\oculus\start.bat` (compose health-waits on 3011).

**Then:** run the gates, report with evidence, STOP for release. Also still pending: **push approval** for the 5 dev commits + 1 Oculus-fork commit (ask at phase close, push only what's named).

## 6. LIVE GOTCHAS (will bite you if unread)

- **OLLAMA_HOST tailnet leak (ROOT-CAUSED 2026-06-10):** Machine-scope env var `OLLAMA_HOST=100.82.169.101:11434` (iPad/Tailscale leftover) made the deploy resolve Ollama at the Tailscale IP → "Ollama not reachable". `lib/ollama-config.ts` reads env; launcher honors pre-set values. **Fixed via User-scope `OLLAMA_HOST=127.0.0.1:11434`** (overrides Machine, no admin). Stale Machine var still exists — removal needs an elevated shell (`[Environment]::SetEnvironmentVariable('OLLAMA_HOST',$null,'Machine')`). Any process launched BEFORE the fix still has the bad value — relaunch required.
- **Daemon lifecycle (CLAUDE.md rule 12):** Ollama has ONE owner — `launchers/ollama-supervisor.bat`. Never spawn/kill Ollama in proofs; preflight restart is backstop only.
- **num_ctx:** Ollama defaults 4096 for modelfile-silent models → truncation flakes. `lib/model-ctx.ts resolveNumCtx()` floors at 16384 only when the modelfile is silent.
- **.next pollution:** a stray `next dev` corrupts `.next`. Clean `.next` + rebuild before `check:full`; check for competing Next processes when the root route 404s. Owner's dev server on :3000 blocks the live stage (`SKIP_LIVE=1` + isolated-port proofs was the accepted workaround; owner pauses his server for clean gates).
- **cmd.exe + LF:** `.bat` files MUST be CRLF (LF-only causes goto desync / phantom behavior). `timeout` fails under `<NUL` stdin — use `ping -n`.
- **Cold model:** first gemma turn after idle can take minutes (8GB VRAM load). Warm it before timed proofs; retry per turn in live harnesses.
- **Migrate:** `node scripts/migrate-to-usb.mjs --target=D:\ARGOS --i-acknowledge-overwrite --skip-models` — now preserves `config/settings.json`, vault, `state/` (never touched), and carries `tools/oculus`. It copies the EXISTING `.next` — rebuild dev first or you ship a stale build.
- **Oculus recon:** a previous path sweep missed `C:\AI` entirely. Search it.

## 7. KEY FILES (Phase 9 surface)

| File | Why it matters |
|---|---|
| `lib/chat/orchestrator.ts` | handleChat; `x-oculus-origin` read near top; `chat.inference` audit ~line 1527 |
| `app/workspace/page.tsx` | 6 pillars; `OCULUS_MAP_URL` (3011); `argos_pillars_v2` |
| `scripts/proof-phase9-oculus-fusion.mjs` | code gates, re-runnable 9/9 |
| `scripts/proof-phase9-runtime-gates.mjs` | the four runtime gates (adapt for live-deploy audit per §5) |
| `scripts/migrate-to-usb.mjs` | settings-preserve + tools/oculus copy |
| `launchers/launcher.bat` | OCULUS_ROOT default C:\AI...; honors pre-set OLLAMA_HOST |
| `tools/oculus/start.bat` | Docker compose up, health-wait 3011 (in source AND on D: now) |
| Oculus: `src/app/api/assistant/chat/route.ts` | the thin proxy (committed `a6ef545`) |
| Oculus: `src/components/panels/OculusAnalystPanel.tsx` | panel wired to the proxy; ARGOS phrasing |

## 8. AFTER PHASE 9

- **Phase 10:** M.2 sovereignty (D: drive as the sovereign home; `D:\OCULUS` clone rides this). Not specced yet — owner releases it.
- **PHASE 10 FINDING (logged 2026-06-11, owner-directed):** The OLLAMA_HOST incident is a *class* of sovereignty violation, not a one-off. A machine-scoped env var pointing ARGOS at a tailnet IP (`100.82.169.101:11434`, Machine scope) is **host-state**: cold-boot-from-D: on another box either fails outright or silently chases a network address that isn't there. Two Phase 10 requirements follow:
  1. **Env-var host-dependency audit:** Phase 10's relative/local-only audit must enumerate every env var the deployable code reads (`OLLAMA_HOST`, `ARGOS_CHAT_URL`, `NEXT_PUBLIC_OCULUS_URL`, etc. — grep `process.env` in lib/ and launchers) and verify none can inject an off-drive or off-host dependency that survives eject. Machine/User-scope vars on the host are outside the drive and therefore outside sovereignty — the payload must not trust them blindly.
  2. **Launcher hardening (closes the bug class):** in USB-native / network-off mode, `launchers/launcher.bat` must NOT blindly honor a pre-set `OLLAMA_HOST` that resolves to a non-loopback address. Force `127.0.0.1:11434` (or warn loudly and refuse). Today it honors any pre-set value (see §6 gotcha) — that is the vulnerable behavior. Same scrutiny applies to any future host-pointing var.
  - Host cleanup status: User-scope override `127.0.0.1:11434` is in place and effective for normal launches; the stale Machine-scope value **loses to it for fresh user processes but still wins under SYSTEM / scheduled-task / service / elevated contexts**. Machine value REMOVED by owner 2026-06-11 (elevated `SetEnvironmentVariable($null,'Machine')`; verified empty at API and HKLM `Session Manager\Environment` key from two independent sessions). User-scope `127.0.0.1:11434` intentionally retained until launcher hardening lands. Hardening above is still required regardless — the next host won't be cleaned.
- **LOGGED (2026-06-11, owner-directed, do not build yet) — POST-PHASE-10 VOICE OVERHAUL PHASE:** F5-TTS local voice clone using the Phase 7-C reference audio (already on disk: `state/voice/bart-ref-f5.wav`, `bart_reference.wav`); full conversation mode = VAD mic capture + streaming STT + sentence-streamed TTS + barge-in (operator can interrupt mid-utterance); a per-stage latency budget for the whole pipeline (VAD→STT→inference→first-audio) with measured numbers, not estimates; POWER-tier-gated where the 8GB lean tier can't hold it (F5-TTS + gemma resident simultaneously will not fit 8GB — needs the tier gate from Phase 7). Note launcher voice scan currently reports whisper=missing tts=missing on D:.
- **LOGGED (2026-06-11) — SETTINGS DRIFT FINDING (evidence in audit chain + settings.json):** Cloud backend entered Jun 8 19:25 (`nousApiKey`+`perPersonaBackend` changed together; `.argos-secret-key` created same minute). Owner's Jun 11 08:00 correction (Local/DEFAULT/REDACTED) only partially landed as events (`cloudDataPolicy` 08:00:01, `inferenceBackend` ×2 08:00:24/28, **no `perPersonaBackend` event at all**) and the surviving disk state was still nous/nous×4/full — the correction never persisted; corrected by direct file edit while the server was down (evidence copy of the drifted file preserved). Phase 10 requirements: (a) `settings.changed` audit must record old→new VALUES for posture-relevant enums (today it records key names only — value-level drift is unadjudicable from the chain); (b) per owner ruling, self-heal must NORMALIZE a posture contradiction in USB-native mode — global/per-persona backend `nous` + `cloudDataPolicy:full` with no explicit standing opt-in normalizes to local/redacted WITH an audit entry (today `readSettings` self-heals retired models but never posture; `perPersonaBackend` isn't even enum-guarded — settings.ts:446); (c) investigate the Settings UI save path for the dropped `perPersonaBackend` write. Related riders found same sweep: the "nous" backend actually serves `nvidia/nemotron-3-ultra:free` (not a doctrine binding — surface in UI); `elevenlabs.bartVoiceId` on D: is the unconfirmed Cassius-attributed ID.
- **PHASE 10 FINDING (logged 2026-06-12, owner-directed) — Oculus host-Docker dependence:** Oculus runs on host-installed Docker Desktop (Postgres + Next.js via compose). That is HOST-STATE the same way the OLLAMA_HOST var was: cold-boot-from-D: on another box has no engine, and even on this box the map pane died two consecutive mornings because Docker Desktop wasn't running post-boot (durable launcher autostart landed 2026-06-12, but the dependence itself remains). Phase 10 must either accept-and-document Docker Desktop as a named host prerequisite (with the launcher autostart as the mitigation) or evaluate a non-Docker deploy (node standalone + local Postgres-lite/SQLite on D:).
- **PHASE 10 COMMITTED SCOPE (promoted 2026-06-12, owner-directed) — scope-honesty guard:** SECOND confirmed incident of a persona claiming a jailed path is an OS location (top flight: `working.txt` described as on the OS desktop; tool-result frames state the jail root). Persona prose claiming a file lives at an OS location outside the jail = misrepresentation violation (same class the integrity doctrine already polices for tool execution). Build: tool-result frames already carry the jail root — the guard must check persona prose that names filesystem locations against the actual root and flag/correct the claim. Promoted from finding to COMMITTED Phase 10 scope.
- **LOGGED (2026-06-12) — stale-data UI debt:** Jenna pillar showed yesterday's 08:09 morning brief as if current (no date/freshness label); the violations panel is undated. Any surfaced report/verdict must carry its generation timestamp and a stale indicator. Note: the next brief generated after the 2026-06-12 chain ruling should read "GREEN with noted forks" for the audit-chain line (morning-brief.ts now emits it).
- **LOGGED (2026-06-12, owner-directed, do not build yet) — POST-PHASE-10 PHASE A, governed outbox:** ONE real-filesystem allowed root outside the jail, operator-chosen (e.g. `C:\Users\Gordy\Documents\ARGOS_OUT`). write/copy at session+audit tier; delete via approval queue ONLY; personas must state the TRUE OS path when referring to outbox files (ties into the scope-honesty guard above).
- **LOGGED (2026-06-12, owner-directed, do not build yet) — POST-PHASE-10 PHASE B, make_document tool family:** server-side generation of real `.docx` / `.xlsx` / `.pdf` (no cloud dependency) into the governed outbox, with template support. Acceptance: "draft X as a Word doc" → a real .docx that opens in Word. Sequenced after Phase A (needs the outbox as its write target).
- Standing deferred: 5090-day real-hardware checklist (Phase 7); Sael voice ID still UNVERIFIED — owner must supply the confirmed ElevenLabs ID before any voice-binding change (`aGv5jHWKBy8K5xKvYeSX` is attributed to Cassius in code comments — never reuse unconfirmed).
- Memory dir (`~\.claude\projects\C--Users-Gordy-Desktop-ARGOS\memory\`) is current through this handoff — `project_argos_phase9_oculus.md` has the full Phase 9 ledger.

## 9. IMMEDIATE NEXT ACTION FOR THE NEW THREAD

Wait for the owner's signal that D:\ARGOS is relaunched (Bart answering, AUTH gated) and Oculus is live on 3011. Then run the four runtime gates **against the live D:\ARGOS audit chain**, report per gate with verbatim evidence + the entity-count data source, and STOP for Phase 9 release + push approval.
