# Architectural Decisions Log

Why specific technology choices were made. Reverse chronological. Each entry: **decision · context · alternatives considered · why this one.**

The intent is that someone joining this codebase Thursday can read this in 10 minutes and know what's been pre-decided (vs what's still open to revisit).

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
