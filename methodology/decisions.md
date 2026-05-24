# Architectural Decisions Log

Why specific technology choices were made. Reverse chronological. Each entry: **decision · context · alternatives considered · why this one.**

The intent is that someone joining this codebase Thursday can read this in 10 minutes and know what's been pre-decided (vs what's still open to revisit).

---

## 2026-05-24 — Phase 2-RB: persona rebinding to current Ollama store (`e4b:latest`)

**Decision:** Rebind Bartimaeus (the lone "live" persona at boot) to `e4b:latest` — the gemma4-family 7.5B Q4_K_M model currently in the local Ollama store. Bind Bobby to `gemma2-2b-local:latest` as a "selectable" (not live) fast/diagnostic persona. Mark Juniper + Sage as `not_configured` because their previously-bound models (`hf.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive` and `alfaxad/wild-gemma4:e4b`) are no longer in the local store. Add a `PersonaStatus = "live" | "selectable" | "not_configured"` type + an `isPersonaSelectable()` helper. Wire a visible-state model-swap UX: `Loading <persona>…` → `Model ready` (1500 ms autoclear) → `Failed` / `Model not configured`. Set `think: false` globally in `/api/chat` because e4b is gemma4-thinking-capable and defaults to emitting all output via `message.thinking` (zero `message.content`).

**Context:** Directive 2026-05-24 from owner. The previous persona roster (set during Phase 2 hardware-aligned) bound four models that are NOT in the current local Ollama store — the owner's Ollama installation was reset down to two models. Without rebinding, the app would 500 on every persona at boot. The directive explicitly forbids pulling new models, faking model-backed personas, or wiring unstable models. Phases 3/4/5 are untouched per the directive's negative clauses.

**Alternatives considered:**

- **Wire all four personas to one model and disambiguate via system prompts only.** Rejected: violates the directive's "don't pretend to be model-backed unless wired and validated" rule. The personality differences are real but the operator should never be confused about whether Juniper is wired to a Juniper-character model or a Bart-character one wearing a costume.
- **Default boot persona = Bobby (Phase 1.5 measured-fastest decision).** Rejected for this phase: directive explicitly says "Wire Bartimaeus to e4b:latest" and treats Bart as the primary. The Phase-1.5 "Bobby is the daily-driver primary" rule from prior memory still stands but is overridden by this directive's explicit Bart wiring.
- **Mark Juniper/Sage as `live` and bind them to `e4b:latest` too.** Rejected: their original models were chosen for distinct voice (warm-9B for Juniper, research-tuned for Sage). Binding both to a 7.5B gemma4 would erase the meaningful difference and mislead the operator about what's actually different between personas.
- **Drop Juniper + Sage from the persona registry entirely.** Rejected: removing them is destructive; the directive only asks for them to be "honest stub/not-configured." Keeping them visible (greyed out, with `intendedModel` + install instructions) preserves the intent + makes re-wiring a one-line change.
- **Default `think: true` for thinking-capable models and surface the thinking trace in the UI.** Rejected: doctrine is "personas don't expose reasoning traces unless explicitly desired." All four current personas want clean content. Future personas can opt in via a `Persona.exposeThinking` flag (filed; not built).
- **Show modelStatus persistently in the HUD (always-rendered row, even when idle).** Rejected: when nothing is happening, an empty/idle row is just clutter. The transient-row pattern (only render when `modelStatus !== "idle"`) keeps the HUD clean during steady-state usage.
- **Pre-warm the model on app startup (before any chat).** Considered. Decided: not yet — adds boot complexity and forces a 3-9s wait every launcher invocation. The current "warm on first persona-switch / first chat" pattern is already responsive (3s to first token after cold load) and matches what the operator does anyway.
- **Update launcher.bat to also re-warm on startup.** Rejected per directive ("Leave deployed payload launcher.bat in place for now").

**Implementation:**

- `lib/personas.ts` — `PersonaStatus` type, `isPersonaSelectable()`, `Persona.intendedModel` field. Bart's system prompt preserved verbatim across the rebinding (per directive's "preserve Bartimaeus doctrine"). Juniper + Sage retain their original system prompts so re-wiring is a single-line change.
- `lib/store.ts` — `ModelStatus` type. `switchPersona` is now async, drives the visible state transitions via `/api/model/warm`. AVAILABLE_MODELS trimmed to the 2 installed + validated models.
- `lib/settings.ts` — `DEFAULT_SETTINGS.defaultPersona = "bartimaeus"`, `defaultModel = "e4b:latest"`.
- `app/api/chat/route.ts` — `think: false` (Critical: e4b defaults to thinking-only output). 503 + hint when persona is `not_configured`.
- `app/api/model/warm/route.ts` — NEW. POSTs empty prompt to Ollama `/api/generate` with `keep_alive:60m` to force load + report timings.
- `components/settings/PersonaSection.tsx` — "Live" badge, "Model not configured" pill (amber), disabled radio + inline install instructions for unconfigured personas.
- `components/settings/ModelSection.tsx` — MODEL_LABELS rewritten for the two current models with validated tok/s + TTFT numbers.
- `components/HUD.tsx` — Status row visible only when `modelStatus !== "idle"`. Color-coded (amber/emerald/red).
- `components/ChatPane.tsx` — On mount, hydrate `defaultPersona` from `/api/settings` and `switchPersona` if it differs. Persistence-across-restart.
- `scripts/validate-e4b.mjs` — NEW. 10-point validation harness: cold load, warm prompts A-E, swap stress, 3-cycle repeat, fallback model, thinking-channel capture. Writes `validation-e4b.json`. Exit 0 on PASS.

**Result:**

- `npm run lint` clean · `npm run typecheck` clean · `npm run verify` 7/7 PASS · `npm run build` clean
- e4b cold load 3.15 s · warm TTFT 305–412 ms · 19–21 tok/s · VRAM 4950/8192 MB
- 5/5 directive prompts coherent + on-character (Bart's strategist tone preserved)
- 3-cycle swap stress stable, no garbage tokens
- Live `/api/chat` round-trip with `think:false` returns 553 chars of on-character content for the previously-empty prompt D
- `npm run voice:smoke` 23/23 PASS — no Phase 5 regression
- Acceptance criteria 14/14 PASS per directive

**Self-correction noted:**

First validation pass had `think` defaulted to ON. Prompt D ("push back on this claim") returned 637 tokens at 21 tok/s with empty `message.content` — all output went to `message.thinking` (gemma4's reasoning channel). Harness flagged as `degenerate: empty`. Investigated; confirmed it was the thinking channel, not a model failure. Fixed in both the harness AND `/api/chat` route so production traffic gets clean content. This is a model-capability surface we hadn't faced before — any future thinking-capable model (gemma3+, qwen3+, o-style) will need the same gate. Filed as a doctrine pattern.

**Out of scope (filed for later):**

- `Persona.exposeThinking` flag for personas that genuinely want reasoning-trace visibility
- Rebinding Sage to `e4b:latest` (acceptable to operator) — held as `not_configured` per "no faking" rule, awaits owner approval
- Rebinding Juniper to `gemma2-2b-local:latest` (would lose warm-9B character) — same gate
- Re-pulling `nomic-embed-text` to restore Phase 3 vault retrieval — operator's one-command fix; documented in PHASE_2_REPORT.md owner-action items
- Power Mode / 5090 deferred mapping recorded in PHASE_2_MODEL_VALIDATION.md

---

## 2026-05-24 — Phase 5: voice I/O scaffold (Whisper STT + Kokoro TTS)

**Decision:** Ship the **scaffold** for voice in/out — API routes, UI buttons, audit-chain wiring, launcher presence-check, smoke test, operator documentation — with the binaries and models **operator-supplied** (not bundled in the repo). When the binaries are absent the UI silently hides the mic + play buttons and the audit chain logs nothing; nothing in the chat surface changes. When the operator installs per `docs/VOICE.md`, voice lights up without code edits.

Three new API routes: `GET /api/voice/status` (capability snapshot), `POST /api/voice/stt` (audio/wav → text), `POST /api/voice/tts` (text → audio/wav). Two new audit kinds: `voice.transcribed` and `voice.spoken`. Two new UI components: `MicButton` on the composer, `PlayButton` on each completed assistant message. Browser-side audio capture done with `MediaRecorder` + `OfflineAudioContext` for resample-to-16kHz-mono-PCM WAV — no ffmpeg / no native audio dep.

**Context:** v1.0 plan Phase 5 ("Voice — Kokoro TTS + Whisper STT"). Voice is foundational for the long-running operator UX (drive-time / hands-busy / accessibility) and the Tier 7 (Workflow) future, but the actual neural model binaries are large platform-specific blobs that violate the "no new deps without owner approval + USB-native non-negotiable" working rules if bundled silently. The scaffold-first stance respects both: shipping the wiring is real progress, and the install step is the operator's explicit consent for the binaries.

**Alternatives considered:**

- **Bundle whisper.cpp + Kokoro binaries + GGML/ONNX model files in the repo.** Rejected: 100–300 MB platform-specific blobs; "no new deps without owner approval" rule; bloats the repo + payload mirror by a multiple. Documented install path is one command per binary.
- **Python whisper / faster-whisper.** Rejected: requires Python runtime + pip ecosystem (CUDA/cuDNN drama) — fights the single-binary doctrine. whisper.cpp is the right call: one C++ binary, GGML quantized models, CPU-only viable.
- **OpenAI Whisper API.** Rejected: violates Rule 2 (no remote service deps) + Rule 5 (no remote fetch). v1.0 is local-only.
- **Cloud TTS (ElevenLabs, Azure, etc).** Same rejection — local-only.
- **Coqui XTTS / Piper / Bark for TTS.** Considered. Kokoro picked for size (82M params vs 200M+) + speed (real-time CPU on modest hardware) + permissive license. Piper is a viable v1.1 swap if Kokoros forks become flaky.
- **Server-side ffmpeg to convert browser webm/opus → WAV.** Rejected: adds ffmpeg as a hard binary dep + an extra subprocess per STT call. Browser-side `OfflineAudioContext` does decode + resample + mono-mix natively in every modern browser; no dep needed.
- **MediaRecorder → stream to server, decode/resample server-side via libraries.** Same rejection — wants a node-side audio library (e.g. wavefile / fluent-ffmpeg). Browser-side is cleaner.
- **WAV via AudioWorklet vs OfflineAudioContext.** AudioWorklet is more flexible (real-time monitoring, VAD hooks) but heavier (separate worker file + message channel). OfflineAudioContext fits the "record then encode then send" model perfectly and is one file. Worklet can come if/when we add real-time partial transcripts.
- **stdin/stdout streaming with whisper-cli + kokoros.** Rejected: both binaries support file-in/file-out reliably across forks; stdin/stdout flag set varies. Disk-temp via `state/voice/cache/` is Rule-5 compliant and one short `await fsp.writeFile` away.
- **Tap-to-record vs hold-to-record on the mic button.** Tap-to-record chosen — on a laptop trackpad, hold is awkward; tap lets the operator pause to compose without losing the buffer. 60s safety cap auto-stops if the operator walks away.
- **Block chat while STT/TTS in flight.** Rejected: voice is best-effort + auxiliary. The composer mic + per-message play button operate independently of the chat stream. A failed STT shows an error icon on the mic for 3.5s then resets; the operator can keep typing.
- **One global audio player vs per-button audio elements.** Per-button + module-level "currently playing" registry chosen. Starting a new playback aborts any in-flight fetch + pauses any playing audio. Simpler than a global player context.
- **Always-render buttons (always visible, error on click if voice off).** Rejected: violates the "no surprise UI" doctrine. The capability probe is one `fs.exists()` so cheap; hiding the buttons when unavailable matches the same pattern as the ToolsDock (foundation tools show "pending" rather than fake-online).
- **Mandatory voice presence-check in launcher (refuse to boot if missing).** Rejected: voice is optional. Launcher prints status (`whisper STT missing | kokoro TTS missing`) and continues; ARGOS works fine without it.

**Implementation:**

- `lib/voice.ts` — `voiceToolsDir()` / `whisperDir()` / `kokoroDir()` / `voiceCacheDir()` (all under `ARGOS_ROOT`), `whisperBinary()` / `kokoroBinary()` cross-platform probes, `whisperModel()` / `kokoroModel()` / `kokoroVoices()` async file probes, `detectVoiceCapability()` snapshot with structured `reason` for the UI, `spawnVoice(bin, args, opts)` with 60s default timeout, `transcribeWav(wav, opts)` + `synthesizeText(text, opts)` end-to-end pipelines.
- `lib/voice-client.ts` — `startVoiceRecorder()` → handle with `stop()` returning 16 kHz mono PCM WAV `ArrayBuffer`, `convertToWav16k(input)` decode+resample+mono+encode, `transcribeBlob(wav, opts)` + `synthesizeToBlob(text, opts)` wrappers around the routes.
- `lib/audit.ts` — added `voice.transcribed` and `voice.spoken` to `AuditKind` union.
- `app/api/voice/status/route.ts` — GET capability probe; always 200 (so UI can read `available` safely).
- `app/api/voice/stt/route.ts` — POST audio/wav → JSON. 503 capability gate, 413 size gate (25 MB), 500 on spawn failure. Best-effort `voice.transcribed` audit append on success.
- `app/api/voice/tts/route.ts` — POST JSON → audio/wav. 503 capability gate, 400 empty/oversized text gate (4000 char cap), 500 on spawn failure. Best-effort `voice.spoken` audit append.
- `components/voice/MicButton.tsx` — capability-gated mic on composer. Idle / recording (red pulsing) / transcribing (spinning) / error (red mic-off) visual states. 60s max recording auto-stop.
- `components/voice/PlayButton.tsx` — capability-gated per-message TTS. Module-level "currently playing" registry preempts older playbacks. Idle / loading (spinner) / playing (pause icon) / error (alert) states.
- `components/ChatPane.tsx` — imports both, threads `currentSessionId` for audit scoping, MicButton in composer pre-Send/Stop area, PlayButton inline with persona name label on completed assistant messages.
- `launchers/launcher.bat/.sh/.command` — read-only presence-check after the existing auto-ingest block. Logs `[voice] whisper STT ready|missing | kokoro TTS ready|missing`. Never blocks boot.
- `docs/VOICE.md` — architecture + install guide + API reference + failure-mode table. Operator's single-stop install reference.
- `scripts/smoke-voice.mjs` — two layers: A (scaffold; always runs) verifies routes exist, status returns valid snapshot, 503 paths return `hint`, audit kinds declared, Rule-5 compliance via source-grep; B (roundtrip; only if binaries installed) actually exercises STT + TTS + audit chain.
- `package.json` — `voice:smoke` + `voice:smoke-offline` script aliases.

**Result:**

- `npm run lint` clean
- `npm run typecheck` clean
- `npm run verify` 7/7 PASS (no new launcher / path / dep violations)
- `npm run build` clean — three new Dynamic routes registered: `/api/voice/status`, `/api/voice/stt`, `/api/voice/tts`
- `npm run voice:smoke-offline` 12/12 PASS (scaffold-only)
- `npm run voice:smoke` against a live server with no binaries installed: 23/23 PASS, 5 skipped (binary-dependent paths correctly skipped)

**Self-correction noted during build:**

The first smoke pass used Node's built-in `fetch()` (undici). On Windows Node 24, undici's keepalive socket pool occasionally raises a libuv `UV_HANDLE_CLOSING` assertion AFTER `process.exit()` — the smoke prints PASS but exits with code 9. Switched the smoke's HTTP transport to `node:http` with `keepAlive: false` + explicit `agent.destroy()` — clean exit 0 on PASS. The functional smoke result was always correct; the bug was a node-internal teardown issue, not a smoke logic error. Logged as a node-on-Windows quirk worth knowing for any future smoke scripts.

**Out of scope (filed for later):**

- Voice activity detection / real-time partial transcripts (would want AudioWorklet + streaming whisper; v1.1+)
- Multi-language UI (whisper handles language hint already; UI doesn't expose it)
- Voice settings panel (operator can edit `kokoro` voice via API; no settings UI yet)
- Voice receipts as a UI affordance (audit entries are queryable via `/api/receipts?sessionId=` but no dedicated voice-history UI)
- Real-time interruption ("hey ARGOS, stop") — wake-word infrastructure is its own Phase

---

## 2026-05-24 — Phase 4: hash-chained audit + tamper-evident session export

**Decision:** Ship the foundation Tier 11 of the autonomy ladder will write to: append-only JSONL chain at `$ARGOS_ROOT/state/audit/chain.jsonl`, each entry hash-linked to its predecessor; a `GET /api/receipts` query endpoint; a `GET /api/chat/sessions/:id/export` JSON bundle; a standalone verifier (`scripts/verify-audit-chain.mjs` + `npm run audit:verify`) that walks the chain and detects tampering without needing the framework runtime.

**Context:** v1.0 plan Phase 4 + master plan Tier 11 ("Audit — log every action with hash chain"). Existing event surfaces (sessions, vault, settings) wire audit-append calls; later phases (research / memory / proposer / workflow) add their own `appendAudit()` calls without touching the chain machinery. The existing markdown export (Phase Z1) covers human-readable sharing; the new JSON bundle covers tamper-evident archival.

**Alternatives considered:**

- **SQLite database for the chain.** Rejected: violates the single-binary doctrine — SQLite is fine library-wise but adds a binary dep we don't currently ship; JSONL is good enough at v1.0 scale (100MB at 100k entries) and stays inspectable with `tail`/`cat`.
- **Merkle tree instead of linear hash chain.** Rejected: trees enable O(log n) inclusion proofs; we don't need that at v1.0 scale. Linear chain is dead simple to verify by hand.
- **sha3 / blake2 / blake3 for the hash.** Rejected: sha256 is Node stdlib, universally understood by third-party auditors; no point exotic.
- **Make audit-append mandatory (block underlying write if audit fails).** Rejected: audit is the receipt, settings/sessions/vault is the authoritative state. If the chain can't be written (disk full, permission revoked), the user still wants their settings saved; the missing audit entry shows up as an `index` gap which the verifier flags.
- **Embed audit-write inside the atomic-rename of session/settings.** Rejected: same reason — coupling the two writes means audit failure can break the primary write. Best-effort decoupling is correct.
- **Skip the bundle's `bundleHash` — rely only on the per-entry chain hashes.** Rejected: the bundle includes the session payload (messages, retrieval), which isn't directly in the chain. The bundleHash gives a single-shot tamper check covering the whole archived snapshot.
- **Bundle as markdown (extend chat-export.ts).** Rejected: markdown can't carry binary-friendly tamper evidence cleanly. JSON is the right format for tamper-evidence; the existing markdown export stays as the human-readable variant.

**Implementation:**

- `lib/audit.ts` — `appendAudit(kind, payload, opts)`, `readChain()`, `readSessionEntries(sessionId)`, `verifyChain()`, `canonicalJson()`, `computeEntryHash()`. The `canonicalJson` implementation matches `JSON.stringify` semantics around `undefined` (omits the key) so write-time hashes round-trip through file persistence — caught and fixed during smoke development.
- `lib/sessions.ts` — `writeSession` + `deleteSession` append `session.created` / `session.updated` / `session.deleted` entries with session-id scoping. First-write detection uses `messages.length <= 2` heuristic (user + first assistant reply).
- `lib/vault/store.ts` — `ingest` + `deleteDocument` append `vault.ingested` / `vault.deleted` entries.
- `lib/settings.ts` — `writeSettings` appends `settings.changed` entry.
- `app/api/receipts/route.ts` — GET handler. Supports `?sessionId=ID`, `?verify=1`, `?tail=N`.
- `app/api/chat/sessions/[id]/export/route.ts` — GET handler. Returns bundle with `bundleHash` = sha256 of canonical-JSON of bundle minus bundleHash. Serves with `Content-Disposition: attachment` so browser downloads.
- `scripts/verify-audit-chain.mjs` — standalone Node script, no framework deps. Verifies a chain file directly + optionally a bundle. Exit 0 = PASS, 1 = tamper detected. `npm run audit:verify` alias.
- `scripts/smoke-audit-chain.mjs` — 5 test scenarios (clean chain, payload tamper, prevHash tamper, deleted entry, empty chain). All PASS.
- `docs/AUDIT.md` — new operator-facing doc.

**Notable bug caught + fixed during smoke build:** initial `canonicalJson` left `undefined` keys as `"undefined"` while `JSON.stringify` drops them — write-time hash differed from read-time recompute, all chain entries failed verify. Fixed both `lib/audit.ts` and `scripts/verify-audit-chain.mjs` to filter undefined-valued keys. Smoke now PASS on all 5 scenarios. Self-correction documented in this entry as a methodology artifact (canonicalization is easy to get subtly wrong).

**Why this one:** Tier 11 is foundational — every later autonomy tier (research, proposer, workflow, apply) writes to the same chain. Building it now gates v1.0 ship and unlocks v2.0 work cleanly. The format is third-party-auditable: an outside party with the chain file and 100 lines of sha256+canonical-JSON can re-verify without ARGOS source.

**Scope note:** No new dependencies. No changes to chat route or HUD (audit is invisible to operator workflow). The atomic write-rename pattern on session/settings is preserved; audit-append is a strictly additive "after the success" call.

---

## 2026-05-24 — Phase 3: per-persona retrieval + confidence labels + auto-ingest

**Decision:** Three related changes to the vault subsystem:

1. **Retrieval hits gain a `confidence: "high" | "medium" | "low"` bucket** derived from cosine score. Thresholds: 0.55 / 0.40 / 0.25. Hits below 0.25 are filtered out before reaching the chat route or HUD.

2. **Each persona declares a `retrieval` policy** in `lib/personas.ts`:
   - Bart: `defaultEnabled=true, topK=5, minConfidence="medium"` (verification posture)
   - Sage: `defaultEnabled=true, topK=10, minConfidence="low"` (research posture)
   - Bobby: `defaultEnabled=false, topK=3, minConfidence="low"` (opt-in)
   - Juniper: `defaultEnabled=false, topK=3, minConfidence="low"` (opt-in)

   Request body's `useRetrieval` / `topK` still wins when set — operator override always honored.

3. **New `POST /api/vault/auto-ingest`** scans `$ARGOS_ROOT/vault/dropbox/`, ingests every supported file (`.txt/.md/.pdf/.docx`), archives originals to `dropbox/.processed/<ts>__<filename>`. Errored files land in `dropbox/.errored/`. Launcher calls it after `[4/4] ARGOS ready`. Operator workflow becomes: drop file → relaunch → indexed.

**Context:** Phase 3 v1.0 plan items (`PHASE_PLAN_NOTES.md` § Phase 3 + `methodology/argos-defined.md` Phase 3). The vault already had: ingest pipeline, /api/vault/upload route, cosine retrieval, citation tail, HUD retrieval row. What was missing: confidence labels, per-persona behavior, dropbox auto-ingest, scaling docs.

**Alternatives considered:**

- **Score thresholds at 0.65 / 0.50 / 0.35 (stricter).** Rejected after testing — nomic-embed-text rarely scores above 0.65 even for strong topical matches. Would have classified almost everything as "low." 0.55 / 0.40 / 0.25 better matches the observed distribution.
- **Per-persona behavior as request-time middleware vs persona-level config.** Rejected: the persona owns its identity, including how it uses context. Config-on-persona is the natural home. Middleware would scatter the policy.
- **Auto-ingest as Node script (`scripts/auto-ingest-dropbox.mjs`).** Rejected: would require shipping `scripts/` in the deployed payload, breaking the existing migration which only ships `.next/`. API route is cleaner — already in the Next.js build, called via curl after launcher ready.
- **Auto-ingest on file-system watch (always-on).** Rejected: ARGOS doesn't run a watcher process; the launcher is the lifecycle boundary. Per-launch ingest is the right cadence for a single-operator personal tool.
- **Confidence as a separate analytical layer NOT exposed in HUD.** Rejected: operator wants to know whether the model is citing strong or weak matches at a glance. HUD breakdown ("Last: 4 hits · 2H 1M 1L") makes this visible without scrolling.

**Implementation:**

- `lib/vault/types.ts` — `Confidence` type, `CONFIDENCE_THRESHOLDS`, `scoreToConfidence()`, `confidence` field on `RetrievalHit`.
- `lib/vault/store.ts` — `retrieve(query, topK, opts)` adds `opts.minConfidence`. Hits filtered cheaply before allocation.
- `lib/personas.ts` — `PersonaRetrieval` interface, per-persona config inline alongside `model` field.
- `app/api/chat/route.ts` — uses `persona.retrieval` for defaults; honors body overrides; passes `minConfidence` to `retrieve()`; includes `confidence` in retrieval-tail.
- `lib/store.ts` — `CitedHit.confidence` field (optional for back-compat with persisted sessions).
- `components/HUD.tsx` — retrieval row gains confidence breakdown `"NH NM NL"`.
- `app/api/vault/auto-ingest/route.ts` — new POST + GET handlers; idempotent; archives.
- `launchers/launcher.{bat,sh,command}` — post-ready curl call to auto-ingest, logged to launcher.log, fire-and-forget (failure doesn't block ARGOS startup).
- `docs/RETRIEVAL.md` — new doc covering architecture, thresholds, per-persona policy, scaling ceiling (~1000 docs / ~50k chunks before vector-DB upgrade).
- Seed corpus shipped via `vault/dropbox/` on deployed payloads (Doctrine, Seven Rules, Scope Lock, Operations, ARGOS-defined — 5 docs, ~29 KB). First-launch auto-ingest indexes them.

**Why this one:** Three changes that compound. Per-persona policy makes operator's "which persona answers" choice also a "how much sourcing" choice — natural. Confidence labels let operator see at a glance whether the model is citing strong matches; visible upstream when shifting from research to plain-talk. Auto-ingest closes the bulk-seeding gap that previously required manual UI uploads one-at-a-time.

**Scope note:** No new dependencies. No new Ollama calls (still just `embedText` via the existing `/api/embeddings`). The vault index format is unchanged — existing persisted chunks remain readable. Back-compat with persisted ChatMessage.retrievalHits arrays that lack `confidence` (the field is optional in lib/store.ts:CitedHit).

---

## 2026-05-23 — Phase 2 hardware-aligned: Bart → llama 8B, Bobby = primary default

**Decision:** Three persona-defaults changes, all driven by Phase 1.5's measured operating envelope on the actual RTX 3060 Ti / 8 GB VRAM rig:

1. **Bartimaeus rebinds from `huihui_ai/gpt-oss-abliterated:20b` to `llama3.1:8b-instruct-q4_K_M`** for the active v1.0 runtime. The 20B remains in `AVAILABLE_MODELS` for Power Mode opt-in queries; it does not power the default Bart persona on 8 GB hardware.
2. **`DEFAULT_MODEL` (`lib/store.ts`) becomes Bobby's model** (`Jarcgon/gemma-4-abliterated:e2b-v2`). Bobby measured 31 tok/s + stable across 5-cycle swap stress — the rig's fastest stable persona.
3. **`currentPersonaId` initial state becomes `"bobby"`**, making Bobby the first-launch landing persona.

**Context:** The v1.0 plan locked the four persona-model bindings as "intentional choices — do not swap without owner approval." Phase 1.5 (`PHASE_1_5_HARDWARE_REALITY_ALIGNMENT.md`) measured those bindings against the actual 8 GB VRAM and found Bart's 20B model operates at 8 tok/s with 39% GPU offload — slow but stable (Task B confirmed the "degraded calls 2-4" reading was a classifier artifact). Owner explicitly approved the rebind in the Phase 1.5 directive, with Bobby specifically locked as "primary default LLM per measurement data."

**Alternatives considered:**
- Keep 20B for Bart, accept the latency. Rejected: 25-300s per-prompt wall on chat surface defeats interactive UX.
- Move 20B to a CPU-only path. Rejected: Phase 1.5 § 5 measured CPU-fallback at 7.7 tok/s — essentially same speed as partial-GPU. No upside; same latency cap.
- Drop the 20B from `AVAILABLE_MODELS` entirely. Rejected: removes Power Mode option. Keep it; just don't bind it to a default persona.
- Default to Bart on first launch with 20B model. Rejected by Phase 1.5 + Bobby-default directive: Bobby's responsiveness is the better landing experience; Bart available one click away.
- Default to Sage. Rejected: Sage emits JSON-wrapped output by default (Phase 1.5 § 2 finding) — not ideal for a first-launch greeting.

**Implementation:**
- `lib/personas.ts`: Bart's `model` field changes to `llama3.1:8b-instruct-q4_K_M`. Inline comment cross-references the Phase 1.5 evidence and the Power Mode reservation.
- `lib/store.ts`: `DEFAULT_MODEL` constant + `currentPersonaId` initial state both change. Comments cross-reference the Bobby-default memory entry and Phase 1.5 report.
- `AVAILABLE_MODELS` unchanged — still includes the 20B, the HauhauCS Qwen3.5, the gemma4 pair, llama 8B, qwen 3B. Persona binding is per-persona; the model registry stays full.
- `lib/hardware.ts` unchanged — its ≥16 GB tier still recommends the 20B (correct for a 24+ GB rig); the 6-15 GB tier still recommends llama 8B (now coincidentally = Bart's new binding). Hardware recommendation is independent of persona bindings.
- Juniper persona definition NOT touched (owner re-pulling the model in parallel; the persona binding string is still valid, just the blob is being refreshed).

**Why this one:** Plan + measurement align. The 20B binding was a paper choice; the 8 GB VRAM is the real constraint. Bobby-default surfaces the rig's strongest stable performer first; Bart available without losing the strategic-persona option. 5090 / Power Mode branch is the future home for the 20B-as-Bart restoration.

**Scope note:** This is a planned-then-measured rebind, not a doctrine drift. The owner-approval requirement on "model integrity" was honored: owner explicitly locked the changes after Phase 1.5 measurement evidence. Recorded here so the decision is visible to any future Claude session reading the log.

---

## 2026-05-22 — Port fallback + log rotation in launchers (Phase 1 of v1.0)

**Decision:** All three launchers (`launcher.bat`, `launcher.sh`, `launcher.command`) gain (a) port pre-flight with fallback (Ollama 11434→11435, Next.js 7799→7800) and (b) pre-spawn log rotation at 10 MB with 3 generations (`.1`, `.2`, `.3`).

**Context:** The v1.0 finish-line plan added two stabilization gates that the launcher as previously written would fail: "port collision graceful fallback" and "logs do not grow unbounded." The original `launchers/README.md` filed port auto-fallback as a v2 concern ("clients would need a way to learn the chosen port, which adds a discovery layer we have not designed yet"). That deferral assumed a port-discovery API for external clients; in practice the only client is the operator's browser, the launcher already controls the URL it opens, and the chosen port is echoed in the splash. The discovery layer is not needed — passing the port through to `start "" http://127.0.0.1:%NEXT_PORT%` covers it.

Log rotation had no prior decision recorded. The ops runbook (`docs/05-OPERATIONS.md`) documented "Delete files between sessions if they grow unwieldy — the launcher recreates them" as the manual posture. For a personal tool this was acceptable but fragile (the owner has to remember). 10 MB × 4 generations = 40 MB max per log file class — tight enough to bound USB pressure, loose enough to capture useful history for diagnostics.

**Alternatives considered:**
- **Keep port collision as exit-with-error.** Rejected: directly conflicts with Phase 1 gate. The "discovery layer" worry was overblown for a loopback single-operator tool.
- **Fall back further (11434→11435→11436…).** Rejected: two slots is enough to handle the common "ARGOS is already running and I double-clicked the launcher" case. Three+ slots would mask a real conflict.
- **Use a port range and pick the first free.** Rejected: less predictable, harder to debug.
- **Log rotation by date instead of size.** Rejected: a noisy day produces a multi-GB log before rotation; size-cap is the right cap.
- **Log rotation via `logrotate` / Windows Task Scheduler.** Rejected: violates Rule 1 (host artifacts) and Rule 7 (no host install).
- **Truncate logs instead of rotating.** Rejected: loses the prior session's diagnostic context.
- **Rotate post-shutdown instead of pre-spawn.** Rejected: a crashed launcher would skip rotation entirely; pre-spawn is robust.

**Implementation:**
- `launchers/launcher.bat`: `:PORT_IN_USE` subroutine using `netstat -ano | findstr ":<port> " | findstr LISTENING`. `:ROTATE_LOG` subroutine using `%%~zI` for file size and `move /Y` for ring rotation. Main flow does port pre-flight before binary lookup; log rotation between log-path declaration and splash.
- `launchers/launcher.sh` + `launcher.command`: `port_in_use()` using bash `/dev/tcp/127.0.0.1/$1` (works in bash 2.04+ on macOS 3.2 and Linux). `rotate_log()` using `wc -c` for size. Identical structure to the .bat.
- Splash gains a `Ports  Ollama X  Next.js Y` line so operator can see what was picked.
- Caller-set `OLLAMA_HOST` is honored verbatim (Phase K invariant preserved): the launcher parses the port out for its own curl-poll and skips Ollama-side fallback in that case.
- `scripts/smoke-launcher.mjs` updated to accept both old and new shapes of the `OLLAMA_HOST`-respect and netstat-cleanup patterns. All 7 verify-argos rules continue to pass.

**Why this one:** Both gates are real stability concerns at the operator-facing layer, not contrived. Implementing them inside the launcher keeps the change scoped — no app-layer changes, no new dependencies, no schema migrations. The two-slot fallback handles the realistic collision case (double-launch) without trying to be cleverer than that. The rotation policy uses standard shell-level primitives that don't require new packages, matching Rule 7.

**Scope note:** This is a scope expansion past the original `launchers/README.md` deferral. Calling it out explicitly: the change is contained to the three launcher scripts + README + a smoke regex update + this entry. No source-tree changes, no API changes, no UI changes, no dependencies added. CI green via `npm run verify` (7/7) + `node scripts/smoke-launcher.mjs` (PASS).

---

## 2026-05-21 — Server-side chat-session persistence in v1 (Phase Z9)

**Decision:** Ship basic chat-history persistence in v1. Sessions auto-save to `ARGOS_ROOT/state/sessions/<id>.json` after each assistant turn. Memory page remains a v2 stub (it documents *semantic* memory, which is a different concept).

**Context:** The Z phases identified that operators losing chat on refresh is a real UX cost. The original decisions.md entry "Chat history is in-memory only (Zustand) — intentional per scope-lock" was deferred to v2 explicitly. But the scope-lock CUT list mentions "State engine, ambient modes" — that's about higher-level state machines, not basic transcript persistence. So basic session persistence is in-bounds for v1.

**Alternatives considered:**
- **localStorage in the browser.** Rejected: violates Rule #1 (host writes). The browser's localStorage lives at `%LOCALAPPDATA%\...\Local Storage\leveldb\` which is exactly the "host artifact" the doctrine forbids.
- **Memory page becomes the history viewer.** Rejected: the existing Memory stub makes a strong doctrine point about NOT shipping a "Memory" page that secretly dumps chat history. Diluting that doctrine point would weaken the stub-honesty argument.
- **Sessions as separate workspace concept.** Rejected: workspace is v2 per scope-lock. Sessions belong inside the existing chat surface.

**Implementation:**
- `lib/sessions.ts` — atomic write-rename + fsync (same pattern as `lib/settings.ts` after Phase W). 5 MB per-session cap. 200-session list cap. Strict shape validation on read.
- `/api/chat/sessions` (GET list, POST upsert), `/api/chat/sessions/[id]` (GET full, DELETE).
- `lib/store.ts` — `currentSessionId` + `loadSession()`.
- `components/SessionList.tsx` — dropdown panel triggered by History icon next to Export/Clear in chat header.
- ChatPane auto-saves session after each assistant turn completes (fire-and-forget; save failure must not block chat).
- `scripts/smoke-sessions.mjs` — 26/26 PASS covering create/read/list/update/delete/idempotency/validation.

**Why this one:** Basic transcript persistence is genuinely useful for v1 demo (load past chat, show "the AI remembers" without having to re-explain context) and respects every existing doctrine constraint. Memory page stays distinct as the v2 semantic-memory surface.

**Scope note:** This is a scope expansion past the original decisions.md entry that listed chat history as v2-deferred. Calling it out explicitly: the change is contained (3 new files + 1 new route group, 100 lines of TS, 200 lines of UI), it's tested with a 26-case smoke, and it doesn't open the door to "Memory" semantics (separate doctrine point preserved).

---

## 2026-05-20 — `OLLAMA_HOST` env-driven base URL (Phase K refactor)

**Decision:** `lib/ollama-config.ts` centralizes the Ollama base URL with `OLLAMA_HOST` env override. The launcher sets `OLLAMA_HOST=127.0.0.1:11434` explicitly so the daemon and the app stay in sync.

**Context:** Phase K needed to spawn an alt-port launcher (11436) for non-disruptive cold-start measurement. The hardcoded `OLLAMA_BASE = "http://127.0.0.1:11434"` in three files prevented this.

**Alternatives:**
- Add a CLI flag to launcher.bat that maps to OLLAMA_HOST. Rejected: implicit-via-env is cleaner; the daemon already uses OLLAMA_HOST natively.
- Use a config file that both daemon and app read. Rejected: adds a coupling point that doesn't pay for itself at v1 scope.
- Hardcode `127.0.0.1:11434` and accept the test limitation. Rejected: Phase K was the highest-value test of the autonomous block.

**Why this one:** ollama daemon already reads `OLLAMA_HOST`. Matching that convention costs nothing and unlocks alt-port testing + remote-Ollama scenarios for free.

---

## 2026-05-20 — `< NUL` for cmd /c daemon spawns (Phase C / Phase K)

**Decision:** Launcher.bat appends `< NUL` to its cmd /c daemon spawn lines: `cmd /c """%BIN%"" args < NUL 1>>""%LOG%"" 2>&1`.

**Context:** Under non-interactive parents (TaskCreate, CI, headless test wrappers), the cmd /c wrapper inherits a piped stdin and exits with "ERROR: Input redirection is not supported" before the daemon starts. Phase E proved a single `< NUL` token fixes this.

**Alternatives:**
- Skip the cmd /c wrapper, use plain `start /MIN "%OLLAMA_BIN%" serve >>...`. Rejected: stdout/stderr redirection at the start level doesn't work the same way; redirecting requires cmd-context which is what `cmd /c` provides.
- Detect the failure mode and retry. Rejected: silent retry hides the root cause.
- Use PowerShell from launcher.bat. Rejected: adds a PS dependency, ARGOS targets minimal Windows surface.

**Why this one:** Single-token defensive fix at the wrapper layer, with `verify-argos` Rule 7 to prevent regression.

---

## 2026-05-19 — Inline server props for build-info (H7.0b)

**Decision:** Removed `app/api/about/route.ts`. Added `lib/runtime-info.ts` with `getRuntimeInfo()` server function. Each server page calls `getRuntimeInfo()` and passes the result as props.

**Context:** `/api/about` was created in H5 to centralize build-info reads for HUD and AboutSection. The end-of-H6 scope harness flagged it as an out-of-scope API route — scope-lock covers chat/vault/hardware/settings, not about.

**Alternatives:**
- Keep `/api/about` and add it to scope. Rejected: scope expansion should be intentional.
- Read package.json inline in every consumer. Rejected: duplication.

**Why this one:** Server-component props are cheaper than an API round-trip AND stay inside the existing scope envelope. The change is invisible to the user.

---

## 2026-05-19 — Robocopy over Node fs.copyFile for model migration (H8.5)

**Decision:** Models migration uses `robocopy /MIR /MT:8` (Windows-native, multi-threaded, idempotent).

**Context:** During H8, the migrate-to-usb.mjs script's transitive-deps loop crashed silently. Recovered with robocopy fill-in. Discovered robocopy is ~100× faster than Node's `fsp.copyFile` for thousands of small files (model blobs).

**Alternatives:**
- Use Node's `fs.cp` (recursive). Rejected: ~100× slower for this workload.
- Use `xcopy`. Rejected: no `/MIR` equivalent, less robust.
- Shell out to robocopy from inside migrate-to-usb.mjs. Filed for v2.

**Why this one:** Robocopy is shipped with Windows since Vista, handles long paths natively, supports retry/wait on locked files, and parallelizes via /MT. For thousands of small files (~17 blobs at 100+ MB each), the difference is measurable: 82 MB/s sustained vs 1-2 MB/s.

---

## 2026-05-19 — Copy entire Ollama install dir, not just ollama.exe (H8.5)

**Decision:** `migrate-to-usb.mjs` mirrors the full `%LOCALAPPDATA%\Programs\Ollama\` tree (including `lib/ollama/*.dll`) to `bin/`, not just `ollama.exe`.

**Context:** Initial migration copied only the 40 MB `ollama.exe` binary. The daemon failed silently on PNY cold-start. Investigation showed `serve` needs the `lib/ollama/` runtime: GGML, CUDA, BLAS, per-CPU-variant DLLs (~1.4 GB total).

**Alternatives:**
- Document that ARGOS requires a host-installed Ollama. Rejected: violates Rule #1 (zero host install).
- Stub the lib/ DLLs and use the host's. Rejected: only works on machines with Ollama installed.
- Statically link Ollama. Rejected: would require a custom Ollama build, far out of scope.

**Why this one:** Ollama is the only non-single-binary third-party dependency. Migration must account for the full vendor install tree, not just the executable. Cost: +1.4 GB on the USB. Acceptable.

---

## 2026-05-19 — Keep user-asset files untracked, don't gitignore (H7.0a)

**Decision:** `ARGOS/` (empty dir) and `argos imagery.png` at repo root stay untracked. They're not added to .gitignore.

**Context:** End-of-H6 scope harness flagged 2 dirty files. Investigation: both are user-supplied reference material dropped at repo root before doctrine was written.

**Alternatives:**
- Add to .gitignore. Rejected: feels sneaky; hides their existence.
- Commit them. Rejected: they're not source.
- Delete them. Rejected: not authorized to delete operator material.

**Why this one:** Visible-but-untracked is the most honest posture. The harness still flags them — that's the correct signal. The doctrine entry in `methodology/corrections.md` explains why they're there.

---

## 2026-05-18 — Tailwind v3 + shadcn HSL CSS variables (H4.1)

**Decision:** shadcn-style theme tokens via `tailwind.config.ts` + HSL CSS variables. Tailwind v3 (not v4).

**Context:** shadcn was originally implemented for Tailwind v3. Tailwind v4 introduced significant API changes that broke shadcn primitives in our scaffold.

**Alternatives:**
- Tailwind v4 + custom shadcn rebuild. Rejected: rebuild surface too large for v1.
- Drop shadcn, use Radix primitives directly. Rejected: shadcn's wrapping API is genuinely useful for the variant patterns.

**Why this one:** Tailwind v3 is the established, well-supported path for shadcn. v4 is the future but not the present.

---

## 2026-05-18 — `nomic-embed-text` for vault embeddings (H3.STEP1)

**Decision:** Vault embedding model is `nomic-embed-text` (137M params, F16, 274 MB).

**Context:** Need a local embedding model that runs on CPU-only target hardware in <1s per chunk.

**Alternatives:**
- `all-MiniLM-L6-v2` (sentence-transformers). Rejected: not available via Ollama, would need a separate runtime.
- `bge-large-en`. Rejected: too slow on CPU.
- `text-embedding-ada-002` (OpenAI). Rejected: cloud call, violates Rule #5.

**Why this one:** Ollama supports it natively. 274 MB fits the USB-payload budget. Quality is solid for English doctrinal text (verified via Phase Q ranking benchmark: 5/5 top-K-5 PASS).

---

## 2026-05-18 — Three default models (qwen2.5:3b, llama3.1:8b, nomic-embed) (H5)

**Decision:** Ship with three models on the USB:
- `nomic-embed-text` (274 MB) — embeddings
- `qwen2.5:3b-instruct-q4_K_M` (1.9 GB) — fast chat
- `llama3.1:8b-instruct-q4_K_M` (4.9 GB) — default chat

Total models size on PNY: 12.73 GB (the additional 5.7 GB is incidentally-present non-default models on the host).

**Alternatives:**
- Single model. Rejected: 8B at full quality is too slow on weak hardware; 3B is too dumb for citation-heavy retrieval.
- Five+ models. Rejected: USB budget pressure; users can `ollama pull` more themselves.

**Why this one:** Three covers the (fast/quality, chat/embed) matrix without bloat.

---

## 2026-05-18 — Cosine retrieval in-memory, no vector DB (H3.STEP3)

**Decision:** Vault retrieval is plain in-memory cosine similarity over a flat array of `{ text, embedding[], filename, chunkIndex }`. No SQLite, no Faiss, no Pinecone.

**Context:** v1 scope is single-user, single-machine, <10k chunks.

**Alternatives:**
- SQLite + sqlite-vec. Rejected: extra binary, more migration complexity for marginal speed.
- Faiss. Rejected: native dep, fights single-binary mentality.
- LanceDB / Chroma. Rejected: heavier than the use case warrants.

**Why this one:** A 5000-chunk × 768-dim cosine scan is ~3ms in V8. Not worth optimizing for v1. Filed for v2 if/when chunks exceed ~50k.

---

## 2026-05-17 — Next.js 14 App Router + TypeScript + Server Components

**Decision:** Next.js 14 App Router with React Server Components for build-info reads, client components for interactive surfaces (chat input, vault upload).

**Context:** Need server-side npm-buildable, single-process, port-binding-only-on-loopback. Need streaming for chat. Need the production build to ship in `.next/`.

**Alternatives:**
- Vite + Express. Rejected: more wiring to get streaming + SSR.
- Tauri (Rust shell + web view). Rejected: needs Rust toolchain on dev machine; we want one stack.
- Electron. Rejected: 200MB+ runtime per platform, fights single-binary intent.

**Why this one:** Next.js 14 + `next start` is the smallest production-quality web app you can ship without writing custom infra. Server components handle the build-info read without an API round-trip.

---

## 2026-05-17 — Doctrine-first development (Day 0)

**Decision:** Write `docs/00-DOCTRINE.md`, `01-SEVEN-RULES.md`, `02-SCOPE-LOCK.md` BEFORE writing any code. Verify-argos enforces the Seven Rules executably.

**Context:** The thesis the operator is testing is "AI-assisted build with hard architectural rails performs differently than free-form AI-assisted build." This requires the rails to exist BEFORE any code is written.

**Alternatives:**
- Build code first, write doctrine to match. Rejected: defeats the thesis.
- Skip executable enforcement. Rejected: doctrine without enforcement drifts.

**Why this one:** It's the entire point of the project's methodology. Filed in `methodology/03-METHODOLOGY.md`.

---

## Decisions explicitly deferred to v2

These were considered and intentionally pushed:

- **Encryption at rest** — drive theft / physical access. Listed in threat-model.
- **Signed weights + audit log** — model/vault tampering. Listed in threat-model.
- **SBOM / dependency pinning** — supply chain. Listed in threat-model.
- **Prompt injection from vault docs** — week 4-5 per threat-model.
- **Vector DB upgrade** (Faiss/SQLite-vec) — only when chunk count > ~50k.
- **Chat history persistence** — intentional per scope-lock (in-memory only for v1).
- **Multi-user / per-user namespaces** — explicitly out of v1 scope.
- **Transactional staged-write in migration** — filed for v3 review. Per-file vs per-payload staging trades off recovery cost.
- **Walk package-lock.json for true production dep graph** — migration script uses a top-level heuristic. v2 should walk the lockfile.

If you're in this codebase Thursday and want to make a decision that touches one of these, check the threat-model entry first — there may be context that affects the right path.
