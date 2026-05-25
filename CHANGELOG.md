# Changelog

Reverse-chronological. Phase letters reference the build session's audit trail (see `methodology/eyes-on-h*.md` and `methodology/thesis-evidence.md`).

## [1.0.0] — 2026-05-24

The v1.0 lockdown. Tag pending owner approval; this entry reflects the freeze state.

Frozen at commit on `origin/main`. Acceptance checklist passes per `docs/06-V1.0-LOCKDOWN.md`. For the per-phase breakdown see the `PHASE_*_REPORT.md` files in the deployed payload root.

### Added (since the original H-phase build sprint)

**Phase 1 — Stabilization**
- Port-fallback in launchers (Ollama 11434→11435, Next.js 7799→7800)
- 10 MB log rotation with `.1`/`.2`/`.3` generations in `launcher.bat` / `.sh` / `.command`
- 7 stability gates exercised under cold/warm/swap/yank/restart scenarios
- `verify-argos` Rules 1–7 enforced at every commit + CI

**Phase 1.5 — Hardware Reality Alignment**
- Measurement harness producing operating-profile matrix per persona × model on actual RTX 3060 Ti / 8 GB VRAM
- Documented 20 B+ models as Power Mode (deferred until ≥16 GB VRAM)
- `scripts/check-model-integrity.mjs` for existence / size / sha256 verification of model blobs
- Diagnosis discipline: 3-axis (model-store integrity / arch-compat / hardware-envelope / persona-logic)

**Phase 2 — Persona Completion** (and **Phase 2-RB** rebinding)
- Four personas wired: Bartimaeus (live), Sage, Bobby, Juniper (selectable)
- Bartimaeus bound to `e4b:latest` (gemma4 7.5B Q4_K_M) per validation harness (`scripts/validate-e4b.mjs`)
- Sage shares e4b:latest (different system prompt — zero-latency swap)
- Bobby + Juniper bound to `gemma2-2b-local:latest` (stopgap for Juniper)
- `PersonaStatus` type: `live` / `selectable` / `not_configured`
- `Persona.intendedModel` field records the would-be mapping for re-pull restoration
- Persona-switch UI with visible state: Loading → Ready → Failed / Not configured (color-coded)
- `/api/model/warm` endpoint drives the loading state
- `/api/chat` returns 503 + hint for `not_configured` personas (no fake bindings)
- `think: false` set globally on Ollama chat payload (gemma4-thinking gate — without it, content comes back empty)
- Last-used persona persists across restarts via `ChatPane` hydration from `/api/settings`

**Phase 3 — Vault & Retrieval**
- Per-persona retrieval policy (`defaultEnabled` / `topK` / `minConfidence`) in `lib/personas.ts`
- 3-bucket confidence: HIGH ≥0.55 / MED ≥0.40 / LOW ≥0.25 cosine similarity
- HUD confidence breakdown row: `Last: 4 hits · 2H 1M 1L`
- Auto-ingest from `vault/dropbox/` (POST `/api/vault/auto-ingest`), archives to `.processed/` / `.errored/`
- Launcher fires auto-ingest after Next.js readiness
- Bart = medium floor + top-5; Sage = low floor + top-10; Bobby + Juniper = opt-in

**Phase 4 — Audit & Export**
- Append-only hash-chained JSONL audit log at `state/audit/chain.jsonl`
- Per-entry sha256 chained via canonical-JSON serialization (matches `JSON.stringify` `undefined`-key behavior — self-correction caught + fixed)
- Audit kinds: `session.created` / `session.updated` / `session.deleted` / `vault.ingested` / `vault.deleted` / `vault.auto-ingest` / `settings.changed` / `voice.transcribed` / `voice.spoken` / `persona.switched` (declared)
- Reserved kinds for future phases: `research.fetched` / `memory.written` / `proposal.created` / `proposal.applied` / `proposal.rejected` / `workflow.executed`
- `GET /api/receipts` chain query with `?sessionId=` / `?verify=1` / `?tail=N`
- `GET /api/chat/sessions/:id/export` returns JSON bundle with `bundleHash`
- Standalone verifier `scripts/verify-audit-chain.mjs` (no framework deps; third-party-runnable) — `npm run audit:verify`
- Smoke `scripts/smoke-audit-chain.mjs` exercises 5 tamper scenarios (clean / payload tamper / prevHash tamper / deleted entry / empty); all PASS

**Phase 5 — Voice (scaffold)**
- `lib/voice.ts` server orchestration (whisper.cpp + kokoros spawn pipelines with timeouts + cleanup)
- `lib/voice-client.ts` browser MediaRecorder → OfflineAudioContext decode + resample → 16 kHz mono PCM WAV (no ffmpeg dep)
- `GET /api/voice/status` capability snapshot
- `POST /api/voice/stt` audio/wav → text (503 capability-gated, 413 size-gated, audit-logged)
- `POST /api/voice/tts` text → audio/wav (with `x-voice-*` metadata headers, audit-logged)
- `MicButton` (composer) and `PlayButton` (per-message) — capability-gated; auto-hide when binaries absent
- Module-level "currently playing" registry — new playback preempts previous
- Launcher voice presence probe on all three launchers (read-only stat, never blocks boot)
- `scripts/smoke-voice.mjs` 2-layer smoke (scaffold always + roundtrip when binaries installed)
- `docs/VOICE.md` operator install + architecture + failure modes

**Phase 6 — Documentation & v1.0 Lockdown**
- `docs/06-V1.0-LOCKDOWN.md` — frozen manifest, deferral table, acceptance checklist
- `OPERATOR_QUICKSTART.md` — single-page "what do I do first"
- `docs/02-SCOPE-LOCK.md` — refreshed CURRENT section with v1.0 truth; original Friday-v1 preserved as historical
- README reflects 4 personas + Phases 3-5 surfaces + new doc cross-references
- `PHASE_6_REPORT.md` in deployed payload root

### Other notable changes since [Unreleased]
- Standalone `/api/model/warm` endpoint
- `/api/vault/auto-ingest` endpoint + launcher fire
- Tools dock (`components/panels/ToolsDock.tsx`) polls `/api/tools/status` every 15 s; reads `tools/registry.json`
- `methodology/decisions.md` — 6 new phase entries (Phase 1 → Phase 6, 2-RB)

### Verification status at v1.0 freeze
- `npm run lint` clean
- `npm run typecheck` clean
- `npm run verify` — Seven Rules **7/7 PASS**
- `npm run build` clean — all routes (chat, sessions, vault, receipts, voice, tools, hardware, settings, model/warm) registered
- `npm run audit:verify` PASS
- `npm run voice:smoke-offline` 12/12 PASS (scaffold integrity)
- `scripts/validate-e4b.mjs` PASS (5/5 prompts coherent, 3-cycle swap stress stable, no garbage)
- Both deployed payloads (Desktop NTFS + H: FAT32) carry the same `.next` build

### Known v1.0 limits (not bugs; documented in `docs/06-V1.0-LOCKDOWN.md`)
- Voice binaries operator-supplied (not bundled)
- H: drive FAT32 limits multi-GB models (Desktop NTFS is the full payload)
- Juniper on stopgap gemma2-2b model (intended Qwen3.5-9B held pending Ollama upstream `qwen35` support)
- Sage shares Bart's e4b model (different system prompt provides differentiation)
- Audit append is O(n) — fine to ~100k entries; v1.1 caches tail hash

---

## [Unreleased]

### Added
- **Keyboard shortcuts** in chat surface — `Esc` to stop streaming, `Cmd/Ctrl+K` to clear chat, `Cmd/Ctrl+E` to export as markdown. Guards against keystrokes from other inputs so drafts and confirmations aren't lost. (Phase Z5)
- **`npm run warm`** — `scripts/warm-ollama.mjs` pre-loads llama3.1:8b + nomic-embed-text into VRAM/RAM after launcher boot so the first user-visible chat is sub-second instead of ~8s cold. Reads `OLLAMA_HOST` env (Rule-#5 compliant, defaults to 127.0.0.1:11434). (Phase Z4)
- **Stop streaming button** — red Stop button replaces Send while `isStreaming`. Aborts in-flight fetch via `AbortController`; treated as a clean stop, not an error. Transcript shows `_[stopped by operator]_`. (Phase Z3)
- **"thinking…"** pre-first-token indicator. During the cold-load window (5–10s on first chat or after model swap), the assistant bubble shows a pulsing dot + italic "thinking…" instead of a blank caret. (Phase Z2)
- **Chat export to markdown** — Download icon button (top-right of chat scroller). Saves session as `argos-chat-YYYYMMDD-HHMM-{persona-slug}.md` via browser blob URL. Includes header, message blocks, citation footnotes per assistant turn. (Phase Z1)
- **Clear chat button** — Trash icon next to Export, with `window.confirm` guard. Disabled mid-stream. (Phase Z1)
- **`methodology/thesis-evidence.md`** — single-page capstone summary tying the audit trail back to the project's thesis. (Capstone)
- **Per-route API reference** under `docs/api/` — 530 lines covering chat, hardware, settings, vault routes with field tables and error matrices. (Phase X)
- **`docs/05-OPERATIONS.md`** — operator runbook covering daily flow, configuration, vault recipes, migration, failure modes, demo day pre-flight. (Phase R)
- **`methodology/decisions.md`** — architectural decisions log: 12 entries with alternatives + rationale, 9 explicit v2 deferrals. (Phase S)
- **`methodology/threat-model-audit.md`** — code walkthrough verifying every "addressed" claim in `docs/04-THREAT-MODEL.md`. (Phase P)
- **`methodology/bundle-audit.md`** — production bundle size table; chat home is 157 kB first-load JS, below Lighthouse warning threshold. (Phase V)
- **`scripts/smoke-vault-stress.mjs`** — multi-doc corpus stress (19 docs / 76 chunks / 2.5s ingest, p50=127ms). (Phase U)
- **`scripts/smoke-vault-ranking.mjs`** — retrieval quality benchmark with known-answer queries. (Phase Q)
- **`scripts/smoke-all-models.mjs`** — load + respond test for all 3 shipped models. (Phase L)
- **`scripts/smoke-input-validation.mjs`** — 26 negative-test cases against API routes (chat / settings / vault). (Phase O)
- **`scripts/smoke-launcher-e2e.mjs`** — real launcher.bat cold-start measurement via alt-port test wrapper. Measured: 9.5s spawn → first chat token (cold). (Phase K)
- **`scripts/check-full.mjs`** — single-command orchestrator for full static + live verification. (Phase G)
- **`scripts/push-to-github.ps1`** — PS5.1-compatible one-shot post-`gh auth login` repo create + push + tag push. (Phase H)
- **`.github/workflows/ci.yml`** — runs lint + typecheck + build + verify-argos (7 rules) + audits on every PR + push to main. (Phase J)
- **`lib/ollama-config.ts`** — env-driven Ollama base URL with `OLLAMA_HOST` override. Used by chat route, runtime-info, and vault embed. Enables alt-port testing and remote-Ollama scenarios. (Phase K refactor)
- **`lib/chat-export.ts`** — pure functions for serializing chat to markdown. 27 smoke tests in `scripts/smoke-chat-export.mjs`. (Phase Z1)
- **verify-argos Rule 6 + Rule 7** — launcher daemon spawns must redirect stderr to log; Windows `cmd /c` daemon spawns must use `< NUL`. Self-tested via injection. (Phase D)
- **5 default models** verified working in `scripts/smoke-all-models.mjs`: nomic-embed-text (768 dims, 941ms), qwen2.5:3b (150 tok/s), llama3.1:8b (84 tok/s on RTX 3060 Ti). (Phase L)
- **`migrate-to-usb.mjs --expect-label`** — Windows-only Get-Volume pre-flight check refuses to write to a drive that doesn't match expected label/DriveType. (Phase A)
- **`migrate-to-usb.mjs --skip-smoke` + post-migration ollama smoke test** — invokes `<target>/bin/ollama.exe --version` after copy to catch missing `lib/` runtime. (Phase A)

### Changed
- **`lib/settings.ts`** atomic write — `writeSettings` now uses temp-write + fsync + atomic rename instead of plain `writeFile`. Crash-safe against process kill or USB yank mid-write. (Phase W)
- **API route input validation hardened** — `MAX_MESSAGES`/`MAX_CONTENT_LENGTH` on chat, `MAX_QUERY_LENGTH` on vault search, `MAX_FILE_BYTES` on vault upload (returns 413), `MAX_DOCID_LENGTH` on vault delete, strict typeof checks on settings. 26 negative-test cases now PASS. (Phase O)
- **`launcher.bat`** ollama daemon spawn now captures stderr to `logs/ollama.log` and detaches stdin with `< NUL`, fixing the "Input redirection is not supported" cmd /c failure under non-interactive parents. Phase E verified end-to-end. (Phase B + Phase C)
- **`launcher.{bat,command,sh}`** respect caller-provided `OLLAMA_HOST` and `OLLAMA_MODELS` env vars instead of unconditionally overriding. Enables alt-port testing and remote-models scenarios. (Phase K refactor)
- **`tsconfig.json`** — `strict: true` was already on; added `noFallthroughCasesInSwitch`, `noImplicitOverride`, `forceConsistentCasingInFileNames`, `noUnusedLocals`, `noUnusedParameters`. Zero new errors triggered. (Phase N)
- **`migrate-to-usb.mjs`** copies the entire `%LOCALAPPDATA%\Programs\Ollama\` tree (incl. `lib/ollama/*.dll`) rather than just `ollama.exe`. Ollama's `serve` requires GGML/CUDA/CPU-variant DLLs that the bare binary doesn't ship. (H8.5)
- **`README.md`** — replaced the H1 stub with a real project README covering quick-start, doctrine, verification toolbelt, and migration. (Phase M)

### Fixed
- **smoke-settings regression** — H7 removed `/api/about` but the smoke still tested it. Now tests the inline server-props pipeline by checking the package version appears in server-rendered `/settings` HTML. Surfaced by the new `npm run check:full`. (Phase F)
- **`migrate-to-usb.mjs` silent crash in transitive-deps loop** — each top-level dir is now wrapped in try/catch so a single failure surfaces in a warning summary instead of terminating the script. (H8)
- **`verify-host-clean` exception list** — widened to filter NVIDIA, OneDrive, Google DriveFS, Claude desktop, Microsoft Teams, Notepad TabState, ContentDeliveryManager, WebExperience, Crashpad noise. Also now matches both relative AND full path so `/Temp\\claude\\/` patterns work. (H8)
- **smoke-launcher-e2e Node spawn** — Windows-specific: detached `spawn` with `windowsHide: true` doesn't actually start `.bat` files (no console for cmd builtins). PowerShell `Start-Process` with full bat path is the only reliable invocation method under non-interactive Node parents. (Phase K)

### Verification
- **All 7 verify-argos rules** PASS on every commit
- **All 26 input-validation negative tests** PASS
- **All 5 vault ranking probes** PASS in top-K=5
- **All 19 stress-corpus docs** ingest cleanly (4/4 retrieval probes PASS)
- **Threat-model "addressed" claims** verified 4/4 in code
- **Zero tech-debt findings** across `app/`, `components/`, `lib/` (no TODOs, no `any`, no `console.log`, no empty catches)
- **CI green** on every push to `main`

---

## Initial build (H1–H8 + capstone)

The original 14+ hour sprint that brought ARGOS from doctrine to v1-shippable. Hour-by-hour eyes-on docs in `methodology/eyes-on-h*.md`.

### H1 — Scaffold
Next.js 14 + TypeScript + Tailwind v3 + shadcn primitives. Three-pane layout. Zustand store. Doctrine docs locked.

### H2 — Chat streaming
`/api/chat` Ollama proxy with NDJSON streaming. ChatPane with Cmd/Ctrl+Enter. Eye component with persona-bound color. Streaming cursor.

### H3 — Vault pipeline
PDF/DOCX/MD/TXT ingest. nomic-embed-text embeddings. In-memory cosine retrieval. `scripts/smoke-vault.mjs`.

### H4 — Retrieval + citations + truth mode
Vault retrieval injected into chat system prompt. Citation pill UI with `[N]` parsing. Source preview drawer. Truth Mode toggle.

### H5 — Settings + hardware detection
`/settings` route. Hardware detection cascade (nvidia-smi → wmic → CIM → lspci). Model swap. Persona default. Settings persistence to `ARGOS_ROOT/config/settings.json`.

### H6 — Stub-honest secondary surfaces
Vision, Voice, Memory, Tools — UI present, labeled "v2", with explicit not-implemented disclaimers. `scripts/audit-stub-honesty.mjs` to keep stubs honest.

### H7 — Cross-platform launcher
`launcher.bat` (Windows), `launcher.command` (macOS), `launcher.sh` (Linux). Removed out-of-scope `/api/about` in favor of inline server props via `lib/runtime-info.ts`.

### H8 — USB migration
`scripts/migrate-to-usb.mjs` copies the production payload to removable media. `scripts/verify-host-clean.mjs` confirms zero attributable host writes during launcher run. PNY drive verified working.

### H8.5 — Hardening block (Phases A–N + capstone)
- Migration script `--expect-label` pre-flight (Phase A)
- Launcher stderr capture (Phase B)
- Cold-start root cause: cmd /c `< NUL` stdin fix (Phase C)
- verify-argos Rules 6+7 (Phase D)
- End-to-end launcher verification (Phase E)
- Full smoke battery (Phase F)
- `npm run check:full` orchestrator (Phase G)
- `scripts/push-to-github.ps1` (Phase H)
- Tech-debt audit: 0 findings (Phase I)
- CI workflow (Phase J)
- **Real launcher cold-start: 9.5s** (Phase K)
- All-3-models smoke (Phase L)
- README rewrite (Phase M)
- tsconfig +5 strict flags (Phase N)
- API input-validation hardening (Phase O)
- Threat-model code audit (Phase P)
- Vault retrieval quality benchmark (Phase Q)
- Operations runbook (Phase R)
- Architectural decisions log (Phase S)
- Launcher static-audit extension (Phase T)
- Multi-doc vault stress test (Phase U)
- Bundle size audit (Phase V)
- Settings atomic write (Phase W)
- Per-route API reference docs (Phase X)
- Eyes-on Phase O–Y summary (Phase Y)
- Capstone thesis-evidence doc

### Tags
- `h8-final-pny-payload-verified` (commit 91e8d27) — H8 final, before the autonomous hardening block
- `h8.5-autonomous-hardening-complete` (commit 447e84b) — All Phases A–Y + capstone landed

---

*The full audit trail lives under `methodology/`. The thesis claim is in `methodology/thesis-evidence.md`.*
