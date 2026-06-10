# ARGOS — Session Handoff (paste into the new thread)

You are continuing the ARGOS/Bart phase-gated autonomous build. Everything below is self-contained.

## 0. FIRST ACTIONS (do these before anything)
1. **Read `CLAUDE.md` at the repo root IN FULL.** It is doctrine and overrides defaults. (It already exists — written 2026-06-10.)
2. This is NOT the first session after the overnight run — **Phase 0 (reconciliation audit) is already DONE.** Do not re-run it.
3. **Current standing: Phase 1 is COMPLETE and awaiting owner release.** Do not start Phase 2 until the owner says `Phase 1 accepted. Begin Phase 2.` (or gives other direction).

## 1. Project
ARGOS/Bart — local-first, USB-native AI workstation (Next.js 14 App Router, TypeScript). UI on `127.0.0.1:7799` (fallback 7800); Ollama `127.0.0.1:11434` (fallback 11435). Operator: Gordy.
- **Dev (git):** `C:\Users\Gordy\dev\Argos-Claude` → GitHub `ghamm20/Argos-Claude` (private, branch `main`).
- **Deploy payload (runs from here):** `D:\ARGOS` (the detachable M.2 — Phase 10 target). Also `C:\Users\Gordy\Desktop\ARGOS`. A deploy mirrors `.next` to 4 locations (`\.next` + `\app\.next` × both payloads).
- **Hardware:** RTX 3060 Ti / 8 GB VRAM (tier "lean"/STANDARD), 64 GB RAM, 16 cores, win32. ≥24 GB = "ample"/POWER tier (gated, dormant).

## 2. THE GOVERNING PROTOCOL (this replaced all prior ad-hoc directives)
Phase-gated autonomous build. **Work ONE phase at a time. Loop within a phase (plan→implement→run→test→fix) until every gate passes WITH DEMONSTRATED PROOF, then STOP and present a Phase Completion Report. Do NOT start the next phase. Owner releases each phase explicitly.**
Hard rules (full text in `CLAUDE.md`): NTFS-only; **no git push without explicit owner approval** (commit locally freely); no new npm deps without flagging; USB-Native Seven Rules; integrity doctrine (v2.3.8/9) and security posture must stay intact; never fabricate results — report failures verbatim; anything unverifiable is "UNVERIFIED," never "probably fine."

### Phase plan (authoritative)
- **Phase 1 — file_ops governance + useReboundModels flip. ✅ COMPLETE (awaiting release).**
- Phase 2 — chat orchestrator extraction (pure refactor of `app/api/chat/route.ts`, zero behavior change). ← recommended next.
- Phase 3 — overnight task engine. Phase 4 — Proposer. Phase 5 — Workflow engine. Phase 6 — Workspace Pillars. Phase 7 — Hardware capability gating (5090-ready). Phase 8 — Bart canon corpus (vault-loss root-cause first). Phase 9 — Oculus map-pane fusion. Phase 10 — M.2 sovereignty (= "ARGOS complete").

## 3. Git state (exact, as of handoff)
- **HEAD = `e4d1812`** (Phase 1) — local.
- **`origin/main` = `dc5ca5d`** (overnight Stage 15).
- **2 local commits NOT pushed** (push needs owner approval per Rule 2): `e4d1812` (Phase 1), `40d98cc` (a Stage-16 test fix).
- `package.json` version = **2.4.3**. Tag `v2.4.3` → `524dfc5`. (HUD "BUILD" reads package.json.)
- Working tree: `scripts/harness-evidence.jsonl` shows modified — that's ephemeral test-evidence the harness appends; ignore / don't commit it.

## 4. What exists now (built + proven)
An **overnight autonomous run** (driven by now-superseded directives) shipped 22 commits `5339bfa..dc5ca5d`, all pushed, then Phase 1 landed locally. Much of it **overlaps the phase plan** (owner ruled "overnight builds count"):
- **file_ops** (read/list/write/copy/move/delete + mkdir/copy/batch, restore points) — satisfies Phase 1.
- **Cloud-egress redaction** (vault/memory/email stripped on Nous turns) + **symlink/junction-safe path bounding** (`lib/tools/fs-guard.ts` realpath).
- **Task ledger** (`lib/tasks/`), **read-only email + 4 injection guards** (`lib/email/`, gmail.readonly, DORMANT — no token minted), **email draft-create** (drafts-only, permanent no-send ceiling).
- **GPU-agnostic layer G1–G4** (`lib/gpu/detect.ts`, `lib/models/registry.ts` tiered models, `lib/models/concurrency.ts`, `lib/power/` Power Mode + parallel-persona "council") = satisfies Phase 7 in spirit (uses lean/mid/ample tiers).
- **Integrity measurement** (`lib/integrity/stress.ts`, adversarial corpus, rolling catch-rate, baseline **83.3%**, 4 gaps tracked) — `/dashboard` progression view.
- **Verifier primitive** (`lib/verifier/`, claim→Judge→outcome, mechanical-first), **night cycle** (`lib/night/cycle.ts`, read-and-propose), **COO brief**, **fleet remote-executor** (`lib/fleet/`, deferred — Ubuntu rig not on tailnet).
- **Phase 1 itself:** re-tiered file_ops governance to the locked spec (read/list low-friction; write/copy/move/mkdir **session-gated**; delete **approval-queue-only**), created `CLAUDE.md`.

## 5. OPEN DECISIONS / things the owner still owes (surface these, don't guess)
1. **Push approval** — 2 local commits (`e4d1812`, `40d98cc`) are unpushed. Origin is 2 behind. Owner decides when to push.
2. **Phase 1 release** — awaiting `Phase 1 accepted. Begin Phase 2.`
3. **Rule 8 divergence (real debt):** `/api/tools/execute` + `/api/tools/approve` have NO `requireValidSession` gate (removed v2.4.1 to fix a bootstrap deadlock; no client sends a token). Phase 1's "session-gated" write is enforced via the **operator-only chat path**, not the raw tool endpoint — which is reachable un-sessioned on loopback. Documented in CLAUDE.md Rule 8. Needs an owner decision (re-add a working gate vs accept loopback-only).
4. **Rule 6 already resolved:** owner ruled "correct the rule" — bindings stay on the working `aratan/gemma-4-E4B-q8-it-heretic` for Bart+Sage. `wild-gemma4:e4b` (Sage's old "final" binding) **CRASHES llama-server** (`GGML_ASSERT`/`0xc0000409`); `Orchestrator` is retired. Do NOT restore either without an explicit owner override.
5. **Email is DORMANT** — `gmail.readonly` only, no token minted. All email features built + proven against a SYNTHETIC fixture mailbox; live steps audit `email_gate_deferred`. Owner runs `node scripts/gmail-auth.mjs` someday to go live; then run the live read + live adversarial gate.
6. Integrity catch-rate 83.3% — 4 named guard-coverage gaps tracked as follow-up.

## 6. Build / verify commands (exact)
```powershell
cd C:\Users\Gordy\dev\Argos-Claude
npm run typecheck                       # fast
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue; npm run build   # clean build (REQUIRED before any `next start` smoke/proof)
npm run check:full                      # 11 gates (lint,typecheck,build,verify-argos,2 audits,smoke-launcher,smoke-h2,smoke-settings,smoke-vault,smoke-retrieval). Its LIVE stage runs `next dev` which CLOBBERS .next → rebuild after.
node scripts/auth-smoke.mjs             # needs a prod build present (next start). 18/18 normally; the chronic 1 fail = operator-chat-1-char MODEL-content flake (not auth).
node scripts/tool-call-harness.mjs --verify-production   # gate is `production-executable === 3/3` (strict-clean is wrapper variance)
node scripts/proof-phase1.mjs           # Phase 1 gate proof (10/10)
```
**Phase-specific proofs** live as `scripts/proof-*.mjs` (fileops-agentic, night-cycle, verifier, fleet, email-guards, email-draft, coo-brief, gpu-detect, tiered-models, concurrency, power-mode). Each spawns its own throwaway server.

## 7. GOTCHAS (will bite you)
1. **OLLAMA MUST BE RUNNING** for any proof that needs a model (fileops, fleet, email-guards). It crashed/stopped overnight; symptom = proofs fail with `backend=null`. Fix: `Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden`. Verify: `curl 127.0.0.1:11434/api/tags`.
2. `next dev` (check:full live stage) **clobbers `.next`** to dev state — always clean-rebuild before a `next start` proof.
3. **proof scripts use `git grep` / committed state** — a proof's own search-pattern string can self-match once committed (fixed in `proof-email-draft.mjs`; scope greps to `lib/`+`app/`).
4. Persona model truth = `MODEL_*` constants in `lib/personas.ts`, NOT prose/doctrine tables (those have been wrong before). Bart+Sage = gemma-4-heretic; Juniper = Qwen3.5-9b; Bobby = notmythos-8b.
5. Tool turns route to **hermes3:8b** (the dedicated tool-emission model) via the vision-style seam when `isExplicitToolRequest`; lean tier gives them a **lean tool-frame** (Stage 12) so the heavy persona prompt doesn't drown emission.
6. Audit chain = `state/audit/chain.jsonl` (hash-linked; `node scripts/verify-audit-chain.mjs`). Tool audit = `state/tool-audit.jsonl`.
7. Commit trailer used this build: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## 8. Key files
- `app/api/chat/route.ts` — the big one (~1700 lines): persona/tier model resolution, tool-turn routing + lean frame, cloud-egress redaction, integrity guards, `chat.inference` audit. **Phase 2 extracts this.**
- `lib/tools/file-ops.ts` (governance tiers, APPROVAL_OPS={delete}), `lib/tools/executor.ts`, `lib/tools/registry.ts`, `lib/tools/fs-guard.ts` (realpath bounding).
- `lib/personas.ts` (MODEL_*), `lib/settings.ts` (RETIRED_DEFAULT_MODELS, perRoleTierOverride, cloudDataPolicy, gmail, fleet), `lib/auth.ts` (requireValidSession).
- `lib/gpu/detect.ts`, `lib/models/registry.ts`+`concurrency.ts`, `lib/power/`, `lib/integrity/stress.ts`, `lib/verifier/`, `lib/night/cycle.ts`, `lib/email/`, `lib/fleet/`.
- `CLAUDE.md` (doctrine), `scripts/proof-*.mjs`, `scripts/check-full.mjs`.

## 9. Kickoff line for the new thread
> Read CLAUDE.md in full. Phase 0 reconciliation is already done; Phase 1 is complete and committed locally (`e4d1812`), awaiting release. Do not start Phase 2 or push to GitHub until I say so. Confirm you've loaded context and state the one thing you need from me (Phase 1 acceptance, push approval, or the Rule 8 decision).
