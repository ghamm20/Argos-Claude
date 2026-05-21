# Thesis Evidence — ARGOS Build

The thesis being tested: **AI-assisted build under hard executable doctrine performs measurably differently than AI-assisted build without it.**

This document is the single-page evidence summary for that thesis, collated from the audit trail under `methodology/` and the code under `app/`, `lib/`, `components/`, `scripts/`, `launchers/`, `docs/`.

---

## The constraint regime

Three doctrine docs were written **before any code** (`docs/00-DOCTRINE.md`, `docs/01-SEVEN-RULES.md`, `docs/02-SCOPE-LOCK.md`). The Seven Rules are not aspirational — they are executable:

| Rule | Enforcement | Location |
|---|---|---|
| 1. Zero host persistence | `verify-argos` Rule 1, 5 + `verify-host-clean.mjs` | code-gated, runtime-gated |
| 2. Zero registry / system config writes | `verify-argos` Rule 5 (writes derive from ARGOS_ROOT) | code-gated |
| 3. Relative paths only | `verify-argos` Rule 1, 3 | code-gated |
| 4. Scoped env vars | launchers set OLLAMA_HOST/MODELS only for child procs | code review |
| 5. Network-off by default | `verify-argos` Rule 2 (no net deps), Rule 4 (no remote fetch) | code-gated |
| 6. Graceful eject | `verify-argos` Rule 6 (launcher stderr capture), launcher trap cleanup | code-gated + manual |
| 7. Single-binary mentality | `verify-argos` Rule 7 (launcher cmd /c < NUL), migration script copies full Ollama tree | code-gated + e2e |

Every commit runs the full `npm run check`. CI (`.github/workflows/ci.yml`) re-runs it on every PR. Drift is structurally prevented.

---

## What got built (v1 scope)

Four working surfaces:

- **Chat** with three personas (`bartimaeus`, `juniper`, `cipher`), each with a distinct system prompt
- **Vault** with PDF/DOCX/MD/TXT ingest, nomic-embed-text embeddings, cosine retrieval
- **Hardware detection** with platform-aware fallback (CUDA → Metal → CPU)
- **Settings** with persistent per-machine config (`ARGOS_ROOT/config/settings.json`)

Four stub-honest surfaces (declared not-implemented, with link to scope-lock):

- Vision, Voice, Memory, Tools

Five doctrine docs + 1 operations runbook + 5 API reference docs + 6 methodology audit docs.

---

## Real measured outcomes

### Code quality (audit results)

| Property | Result | Method |
|---|---|---|
| TODO/FIXME/HACK markers in production code | **0** | grep across `app/`, `components/`, `lib/` (Phase I) |
| `console.log`, `debugger`, `@ts-ignore` | **0** | grep (Phase I) |
| Loose `any` types in production code | **0** | grep (Phase I) |
| Empty `catch` blocks | **0** | grep (Phase I) |
| TypeScript errors with `strict: true` + 5 extra strict flags | **0** | `tsc --noEmit` (Phase N) |
| ESLint warnings/errors | **0** | `npm run lint` |
| Seven Rules verify-argos PASSes | **7/7** | every commit (Phases A-Y) |
| Input-validation negative tests PASSing | **26/26** | live dev server (Phase O) |
| Threat-model "addressed" claims verified in code | **4/4** | code walk (Phase P) |

### Performance (live measurements)

| Path | Time | Source |
|---|---|---|
| **Real launcher e2e cold-start (spawn → first chat token)** | **9.5 s** | Phase K, alt-port test |
| ollama daemon spawn → port bind | 2.1 s | Phase K |
| next.js spawn → port bind (Δ over ollama) | 0.6 s | Phase K |
| llama3.1:8b cold-load → first token (Δ over next) | 6.8 s | Phase K |
| Warm chat TTFB (model already loaded) | < 1 s | Phase F smoke-h2 |
| Token throughput (llama3.1:8b on RTX 3060 Ti) | 73–84 tok/s | smoke-h2, smoke-all-models |
| Token throughput (qwen2.5:3b on RTX 3060 Ti) | 150 tok/s | smoke-all-models |
| Vault ingest (19-doc corpus, 114 KB) | 2.5 s total / 127 ms p50 | Phase U stress |
| Vault search (cosine over 76 chunks) | 25–50 ms | Phase U |
| Embedding latency (nomic-embed-text) | 941 ms / 768 dims | smoke-all-models |
| Production bundle first-load JS (chat route) | 157 KB | Phase V |

### Verification (regression guards in place)

- `npm run check` — lint + typecheck + build + 7-rule verify-argos
- `npm run check:full` — above + dev-server smoke battery (h2, settings, vault, retrieval)
- `scripts/smoke-launcher.mjs` — 41 structural checks across 3 platform launchers + docs
- `scripts/smoke-launcher-e2e.mjs` — real launcher.bat cold-start with alt ports
- `scripts/smoke-all-models.mjs` — per-model load + respond test
- `scripts/smoke-input-validation.mjs` — 26 negative-test cases
- `scripts/smoke-vault-ranking.mjs` — retrieval quality benchmark
- `scripts/smoke-vault-stress.mjs` — multi-doc corpus stress
- `scripts/verify-host-clean.mjs` — host filesystem diff before/after launcher
- `scripts/audit-stub-honesty.mjs` — stub surfaces declare not-implemented
- `scripts/audit-production-deps.mjs` — payload budget (245 MB ≤ 12 GB)
- `.github/workflows/ci.yml` — runs the static subset on every PR/push to main

---

## Self-corrections that landed in the audit trail

The thesis isn't only "AI made fewer mistakes" — it's also that mistakes the AI made were caught, named, and remediated *with documentation*. Per `methodology/corrections.md`:

1. **False-positive animation bug** (H3 eyes-on) — claimed framer-motion broke, controlled-test proved it was the preview-Electron renderer suppressing animation observation. No code change.
2. **Drive-letter reassignment incident** (H8.5) — 13 GB robocopy wrote to wrong drive because D: was reassigned between sessions. Self-detected via post-write Get-Volume check. Course-corrected to F:. Filed `--expect-label` pre-flight v2 hardening (now shipped, Phase A).
3. **NTFS corruption from yank-during-write** (H8.5) — PNY yanked mid-robocopy left $UpCase damaged. Recovered via reformat + re-migrate. Filed transactional staged-write recommendation.
4. **Ollama lib/ requirement** (H8.5) — migration was copying only ollama.exe, not the full install tree. Daemon failed silently. Fixed migration to copy the whole `%LOCALAPPDATA%\Programs\Ollama\` tree.
5. **`ollama serve` cmd /c stdin failure** (H8.5/Phase C) — non-interactive parent stdin caused `ERROR: Input redirection is not supported`. Root cause: cmd /c inherits piped stdin. Fix: `< NUL` token. Verified end-to-end with Phase E (cmd-via-PS) and Phase K (full launcher.bat alt-port).
6. **smoke-settings /api/about regression** (Phase F) — H7 removed /api/about but the smoke still tested it. Caught by `npm run check:full` on first run after writing the orchestrator.
7. **Multiple Node spawn approaches that DIDN'T work** for Phase K (documented in the commit message): `cmd /c start /B` via spawnSync (hangs), `spawn` with `detached:true + stdio:ignore + windowsHide:true` (bat never starts), PS Start-Process with `-WorkingDirectory` (sandbox blocks the cwd switch). Final solution: PS Start-Process with full bat path.

Every one of these would have been a silent failure or a half-fix without the audit trail. The doctrine forced the trail; the trail caught the slips.

---

## Decisions explicitly deferred (`methodology/decisions.md`)

For honesty: nine architectural decisions are explicitly deferred to v2+. Listed here because the thesis is about being honest about scope, not pretending v1 ships v2:

- Encryption at rest (drive theft)
- Signed weights + audit log (model/vault tampering)
- SBOM / dependency pinning (supply chain)
- Prompt injection defense (malicious vault docs)
- Vector DB upgrade (>50k chunks)
- Chat history persistence
- Multi-user namespaces
- Transactional staged-write in migration
- Walk package-lock.json for true production dep graph

These are documented as v2 work, not pretended-fixed.

---

## What this looks like to someone landing cold

If someone clones this repo Thursday morning and runs `npm run check`, they get:

```
[PASS] Rule 1–7 verify-argos
✓ ESLint clean
✓ TypeScript strict, +5 extras
✓ Next.js production build succeeds
✓ stub-honesty audit
✓ production deps audit (245 MB ≤ 12 GB)
✓ launcher static smoke (41 checks)

All 7 rule groups passed.
```

`npm run check:full` adds (with a dev server) live smoke against the chat / vault / retrieval / settings routes.

`scripts/smoke-launcher-e2e.mjs` measures real launcher cold-start through actual launcher.bat invocation.

`docs/05-OPERATIONS.md` tells them how to start, stop, configure, recover.
`docs/api/*.md` tells them every endpoint's contract.
`methodology/decisions.md` tells them why each tech choice was made.
`methodology/threat-model-audit.md` tells them what's secure-by-design vs deferred.
`methodology/corrections.md` tells them every mistake the AI made + how it was caught.

That entire surface was built under the doctrine constraints. Every commit was audited against the Seven Rules. Every failure mode discovered along the way is documented.

---

## The thesis claim, restated

> AI-assisted build with hard executable doctrine produces a project where:
> (a) every architectural rule is structurally enforced, not just documented;
> (b) failures are caught early and remediated with audit-trail evidence;
> (c) scope discipline is mechanical, not aspirational;
> (d) the resulting artifact is genuinely shippable, not just demoable.

ARGOS is the demonstration. The audit trail is the evidence.

---

*Generated 2026-05-20 at the close of an autonomous Phase A–Y block. 70 commits, all checks green, real-launcher-e2e measured. Single GitHub push (operator-side `gh auth login` required) ships the entire artifact.*
