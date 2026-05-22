# ARGOS — Defined

> The single-page definition + full phase plan from H0 to v2-deferred.
> Written 2026-05-21 at the end of Phase Z14 (88 commits on main, demo-ready PNY at F:\ARGOS).

---

## What it is

**ARGOS is a USB-native, local-first AI workstation built under hard executable doctrine.**

Each clause is doing real work.

### USB-native

The entire stack lives on a removable drive: the Next.js production build, the Node runtime, the Ollama inference engine (binary + `lib/ollama/*.dll` runtime), the model store (~13 GB), the vault index, the chat session history, the user settings, and the audit trail. Plug into any compatible host. Run. Use. Unplug.

The host machine has **zero attributable ARGOS artifacts** after eject — verified by `scripts/verify-host-clean.mjs`, which captures host filesystem state before and after a launcher run and computes the diff filtered through an OS-noise exception list.

The same drive in a different host produces the same workstation. Tested property.

### Local-first

Every network-shaped operation goes to `127.0.0.1`. Chat → loopback Ollama daemon. Vault retrieval → in-process cosine similarity over local `nomic-embed-text` embeddings. Settings → JSON file on the drive via atomic write-rename. Session history → JSON files on the drive.

There is no telemetry, no analytics, no auto-update, no CDN fetch, no remote model API.

The harness enforces this at code level:
- `verify-argos` **Rule 2** rejects network-capable packages (axios, sentry, posthog, segment, datadog, ...) in runtime dependencies
- `verify-argos` **Rule 4** rejects remote imports / remote asset references / remote fetch in source (localhost explicitly allowed)
- CI runs both on every commit to `main` and every pull request

### AI workstation

Not a chatbot. Not a wrapper around someone else's API. ARGOS is the surface where one operator does AI-assisted thinking work:

- Pick one of four personas, each a distinct system prompt + eye color + accent
- Talk to it streaming, with mid-flight stop and explicit cold-load feedback
- Drop documents into the vault (PDF, DOCX, MD, TXT — capped 50 MB per file)
- Get retrieval-grounded answers with citation pills you can click for source preview
- Toggle Truth Mode to inject hedging + citation-discipline directives into the persona prompt
- Watch the HUD live: model, mode (GPU/Metal/CPU), latency p50, TTFT, tokens/sec, vault state, retrieval status, persona, session id, uptime
- Auto-save every chat session to disk under `ARGOS_ROOT/state/sessions/`
- Load any past session, search across all of them by title or message content, bulk-export the entire archive as a single markdown file
- Switch hardware modes when the GPU is absent (cascade: CUDA → Metal → CPU)
- Eject the drive cleanly in under 3 seconds (graceful daemon shutdown via TERM→KILL or `netstat`-by-PID)

### Hard executable doctrine

The **Seven USB-Native Rules** were written before any code:

1. **Zero host persistence** — no writes outside `ARGOS_ROOT`
2. **Zero registry / system config writes** — state lives in `ARGOS_ROOT/config/`
3. **Relative paths only** — never hardcode user paths
4. **Scoped env vars** — child processes only, never modify the user shell
5. **Network-off by default** — no CDN, no analytics, no update check
6. **Graceful eject in 3 seconds** — clean daemon shutdown
7. **Single-binary mentality** — no npm install on the user machine

These are not documentation. They are enforced by `scripts/verify-argos.mjs`, a regex/AST harness that fails CI on any violation. Plus two more rules added mid-build after live failures:

- **Rule 6** — launcher daemon spawns must redirect stderr to a log file (Phase B)
- **Rule 7** — Windows `cmd /c` daemon spawns must use `< NUL` to detach stdin (Phase C)

The doctrine has caught the AI mid-mistake during the build itself — multiple times, all documented in `methodology/corrections.md`. The harness has more authority than the AI's opinion.

### The thesis

> **AI-assisted build under hard executable doctrine produces measurably different outcomes than AI-assisted build without it.**

The audit trail under `methodology/` is the evidence:

- `decisions.md` — every architectural choice with alternatives considered and rationale
- `corrections.md` — every mistake the AI made and how it was caught
- `eyes-on-h*.md`, `eyes-on-z.md` — verification at every milestone
- `threat-model-audit.md` — threat model walked claim-by-claim against actual code
- `bundle-audit.md`, `decisions.md` deferrals — what's intentionally not done
- `thesis-evidence.md` — the capstone summary

The methodology is the product as much as the running app is.

---

## What ARGOS is NOT

| Not | Why it matters |
|---|---|
| A chatbot wrapper around a cloud LLM | All inference local, Rule 5 + Rule 2 enforce it |
| A desktop app with an installer | No host install footprint, Rule 1 enforces it |
| A browser extension | Standalone Next.js production server |
| A multi-tenant SaaS | Single-operator, no auth — loopback is the trust boundary |
| A "private mode" of someone else's product | Built top-to-bottom against doctrine |
| A research playground | Shippable v1, on GitHub, CI green |
| Memory in the v2 sense | Memory page literally explains why basic chat history ≠ semantic recall |
| Voice / Vision / Tools | Stub-honest pages declare not-implemented and link to scope-lock |

---

## Full phase plan — start to ship

### H — Doctrine + Build (Day 0–1)

| Phase | Subject |
|---|---|
| **H0** | Write `docs/00-DOCTRINE.md`, `01-SEVEN-RULES.md`, `02-SCOPE-LOCK.md`, `03-METHODOLOGY.md`, `04-THREAT-MODEL.md`. Doctrine-first. No code yet. |
| **H1** | Scaffold Next.js 14 + TypeScript + Tailwind v3 + shadcn primitives + Zustand store. Three-pane layout. Animated eye. Persona store. `scripts/verify-argos.mjs` Seven Rules harness. ESLint + tsconfig strict. |
| **H2** | Chat streaming via `/api/chat` Ollama proxy. NDJSON streaming. ChatPane with Cmd/Ctrl+Enter. Eye color bound to persona. Streaming cursor. |
| **H3** | Vault pipeline. PDF (pdf-parse) / DOCX (mammoth) / MD / TXT extract → chunk → embed via nomic-embed-text → cosine retrieval. `scripts/smoke-vault.mjs`. |
| **H4** | Retrieval injection into chat system prompt. Citation parsing + pill UI. Source preview drawer. Truth Mode toggle + prompt enrichment. `scripts/smoke-retrieval.mjs`. |
| **H5** | Settings page. Hardware detection cascade (nvidia-smi → wmic → CIM → lspci). Model swap. Persona default. Settings persistence. HUD polish: mode + reason live, uptime, network status. |
| **H6** | Stub-honest secondary surfaces. Vision / Voice / Memory / Tools UI present, labeled "v2", with explicit not-implemented disclaimers linking to scope-lock. Workspace switcher honest UI. `scripts/audit-stub-honesty.mjs`. |
| **H7** | Cross-platform launchers — `launcher.bat` (Windows), `.command` (macOS), `.sh` (Linux). USB layout doc. `scripts/smoke-launcher.mjs`. Removed out-of-scope `/api/about` in favor of inline server props via `lib/runtime-info.ts`. |
| **H8** | USB migration. `scripts/migrate-to-usb.mjs` copies production payload to removable media. `scripts/verify-host-clean.mjs` confirms zero attributable host writes during launcher run. First PNY-resident demo. |

### H8.5 — Incidents + Recovery + Doctrine Sharpening

Three real incidents handled in the audit trail:

1. **Drive-letter reassignment** wrote 13 GB to the wrong drive (D: was reassigned between sessions). Self-detected via post-write `Get-Volume` check. Course-corrected to F:. Filed `--expect-label` pre-flight v2 hardening.
2. **NTFS corruption from yank-during-write** on the PNY. Recovered via reformat + re-migrate. Filed transactional staged-write recommendation.
3. **Ollama daemon silent-fail** from PNY. Root cause turned out to be `cmd /c` inheriting piped stdin under non-interactive parents. Fixed with single `< NUL` token.

All three corrections, recoveries, and prevention measures live in `methodology/corrections.md`.

### A–N — First Autonomous Hardening Block

| Phase | Subject |
|---|---|
| **A** | `migrate-to-usb.mjs --expect-label` + `--expect-drivetype` pre-flight (Get-Volume gate); post-migration ollama smoke |
| **B** | `launcher.bat` ollama daemon spawn captures stderr to `logs/ollama.log` |
| **C** | Root-cause discovery: ollama silent-fail was `cmd /c` inheriting non-interactive parent stdin. Fix: `< NUL` stdin detach. PNY ollama daemon verified working: **105ms port bind** via PowerShell `Start-Process` |
| **D** | `verify-argos` Rule 6 (launcher stderr capture) + Rule 7 (cmd /c stdin detach), self-tested via injection |
| **E** | E2E `< NUL` verification through real `.bat` invocation under non-interactive cmd-from-PowerShell — daemon ready in **1.08s** |
| **F** | Full smoke battery PASS; fixed smoke-settings regression (was still hitting removed `/api/about`) |
| **G** | `npm run check:full` orchestrator (static + live-server smoke battery) |
| **H** | `scripts/push-to-github.ps1` — PS5.1-compatible one-shot post-auth |
| **I** | TODO / FIXME / `console.log` / `@ts-ignore` / `any` / empty-catch sweep — **zero findings** across production code |
| **J** | `.github/workflows/ci.yml` — lint + typecheck + build + 7-rule verify + audits on every push/PR |
| **K** | **Real launcher.bat e2e cold-start measurement**: **9.5s** spawn → first chat token (alt-port harness, host tray daemon undisturbed) |
| **L** | `scripts/smoke-all-models.mjs` — nomic-embed (941ms), qwen 3b (150 tok/s), llama 8b (84 tok/s on RTX 3060 Ti) — all PASS |
| **M** | Top-level `README.md` (replaced H1 stub) |
| **N** | `tsconfig.json` +5 strict flags (`noFallthroughCasesInSwitch`, `noImplicitOverride`, `forceConsistentCasingInFileNames`, `noUnusedLocals`, `noUnusedParameters`) — zero new errors |

### O–Y — Second Autonomous Hardening Block (8-hour overnight)

| Phase | Subject |
|---|---|
| **O** | API input-validation hardening — `MAX_MESSAGES`/`MAX_CONTENT_LENGTH` on chat, `MAX_QUERY_LENGTH` on vault search, `MAX_FILE_BYTES=50MB` on upload, `MAX_DOCID_LENGTH` on delete, strict typeof checks on settings. 26 negative-test cases PASS |
| **P** | Threat-model walkthrough — `methodology/threat-model-audit.md`. All 4 "addressed" claims verified in code. 4 new minor gaps surfaced |
| **Q** | `scripts/smoke-vault-ranking.mjs` — known-answer retrieval quality benchmark, 5/5 PASS in top-K=5 |
| **R** | `docs/05-OPERATIONS.md` operator runbook (daily flow + config + vault + migration + failure modes + demo pre-flight) |
| **S** | `methodology/decisions.md` — architectural decisions log (12 entries + 9 explicit v2 deferrals) |
| **T** | Extended `smoke-launcher.mjs` with Phase B/C/K structural checks (41 checks across 3 platforms) |
| **U** | `scripts/smoke-vault-stress.mjs` — 19-doc corpus stress (2.5s ingest, p50 127ms, 4/4 retrieval probes PASS) |
| **V** | `methodology/bundle-audit.md` — `/` chat = 157 KB first-load (below Lighthouse warn threshold) |
| **W** | `lib/settings.ts` atomic write-rename + fsync (closes Gap A from Phase P) |
| **X** | Per-route API reference at `docs/api/` — 530 lines across 5 files |
| **Y** | `methodology/eyes-on-h8.md` Phase O–Y log + tag `h8.5-autonomous-hardening-complete` |
| **Capstone** | `methodology/thesis-evidence.md` — single-page summary tying audit trail back to thesis |

### Z — Demo-Quality + Sessions Era

| Phase | Subject |
|---|---|
| **Z1** | Chat export to markdown + clear-chat button. `lib/chat-export.ts` pure functions, 27-case smoke. Browser blob download, no host writes |
| **Z2** | "thinking…" indicator during cold model load (the 5–10s window where the assistant bubble was previously silent) |
| **Z3** | Stop streaming button + AbortController wiring. Operator-initiated abort is a clean stop, not an error. Transcript shows `_[stopped by operator]_` |
| **Z4** | `npm run warm` — pre-load chat + embed models so first user chat is sub-second instead of 8s cold |
| **Z5** | Keyboard shortcuts (`Esc` stop, `Cmd/Ctrl+K` clear, `Cmd/Ctrl+E` export) with input-guard so other inputs don't fire them |
| **Z6** | `methodology/eyes-on-z.md` audit doc matching the H-phase convention |
| **Z7** | `npm run demo-check` — 6-stage pre-demo sanity in <1s. Caught its own Rule-1 violation on first run (hardcoded `F:\ARGOS\bin\ollama.exe`) — fixed to read `ARGOS_ROOT` |
| **Z8** | `npm run demo-prep` — chain wrapper that runs demo-check + prints demo URL |
| **Z9** | **Server-side chat session persistence**. `lib/sessions.ts` atomic write-rename + fsync. 5 MB per-session cap. `/api/chat/sessions{,/[id]}` routes. Store wiring (`currentSessionId` + `loadSession`). ChatPane auto-saves after each assistant turn. 26-case smoke. Scope expansion logged in `decisions.md` |
| **Z10** | History panel UI in chat header. `SessionList.tsx` dropdown with click-to-load + hover-revealed trash + "current" pill. Memory page **deliberately unchanged** (preserves v2 semantic-memory doctrine point) |
| **Z11** | HUD "Session" row — shows `saved · <8-char id>` in persona accent color, or `unsaved (auto-saves on assistant reply)`, or `—` for empty |
| **Z12** | `eyes-on-z.md` extended; tag `z-phases-complete` pushed |
| **Z13** | Cross-session text search. `searchSessions()` over titles + non-system message content with ellipsized snippet + `matchedIn` badge. UI: debounced search input in History panel. +11 smoke cases (37/37 total) |
| **Z14** | Bulk session export. `bundleToMarkdown()` + `bundleFilename()`. UI: Download icon in History panel header. Single markdown archive with TOC + anchor links + per-session blocks. +9 smoke cases (36/36 total) |
| **PNY refresh** | Today's payload migrated to `F:\ARGOS` via robocopy. BUILD_ID `mGr10BctBCiuj-CA5V8mk` matches dev. Demo-ready |

---

## v2 — Explicitly Deferred

In `methodology/decisions.md` and `docs/04-THREAT-MODEL.md`:

| v2 Surface | Why deferred |
|---|---|
| **Vision** — image input → multi-modal model | Multi-modal model addition + image upload UI; out of v1 scope-lock |
| **Voice** — speech in (Whisper) / out (TTS) | Real audio APIs; operator's literal next ask |
| **Memory** — semantic recall, cross-conversation, user-modeling | Needs Core Brain orchestrator. v1 chat history is transcript storage, not memory. The Memory page makes this distinction explicit |
| **Tools** — function calling | Tool schema + execution sandbox |
| **Multi-workspace** — Research / Strategy / Theology / Writing / Survival / Coding | v1 is Operator-only; switcher UI shows v2 labels honestly |
| **Encryption at rest** | Drive-theft / physical access threat — week 12–13 per threat-model |
| **Signed weights + audit log** | Model / vault tampering threat — week 12–13 |
| **Prompt-injection defense** | Truth Mode partially mitigates; structural defense in week 4–5 |
| **SBOM + dep pinning** | Supply-chain threat — week 2–3 |
| **Vector DB upgrade** (Faiss / SQLite-vec) | Only needed past ~50k chunks; current in-memory cosine is ~3ms |
| **Embedding-based session search** | v1 ships substring match; embeddings adjacent to Memory doctrine |
| **Transactional staged-write in migration** | Filed in `corrections.md`; needs OS-level cache discipline (robocopy /B or BypassWriteCache) |
| **macOS / Linux launcher real-hw verification** | No Mac/Linux box on dev machine; `smoke-launcher.mjs` covers structural |

---

## State of the artifact

```
HEAD:       eca1245  Phase Z13+Z14: cross-session search + bulk export
Commits:    ~90 on main
Tags:       h8-final-pny-payload-verified
            h8.5-autonomous-hardening-complete
            z-phases-complete
GitHub:     https://github.com/ghamm20/Argos-Claude  (private)
CI:         green on every push to main
PNY:        F:\ARGOS  18.47 GB  BUILD_ID mGr10BctBCiuj-CA5V8mk ✓ matches dev HEAD
Smokes:     verify-argos (7 rules), check, check:full, smoke-launcher,
            smoke-launcher-e2e, smoke-all-models, smoke-input-validation,
            smoke-chat-export, smoke-sessions, smoke-vault, smoke-vault-stress,
            smoke-vault-ranking, smoke-h2, smoke-retrieval, smoke-settings,
            audit-stub-honesty, audit-production-deps, verify-host-clean,
            demo-check
Doctrine:   7/7 verify-argos rules PASS  (CI gate)
```

---

*ARGOS is a thesis demonstration as much as a product. The audit trail under `methodology/` is the evidence. The Seven Rules in `docs/01-SEVEN-RULES.md` are the constraint regime. `scripts/verify-argos.mjs` is the enforcement mechanism. The running app is the proof that this is producible.*
