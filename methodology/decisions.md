# Architectural Decisions Log

Why specific technology choices were made. Reverse chronological. Each entry: **decision · context · alternatives considered · why this one.**

The intent is that someone joining this codebase Thursday can read this in 10 minutes and know what's been pre-decided (vs what's still open to revisit).

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
