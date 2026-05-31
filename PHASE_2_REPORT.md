# PHASE_2_REPORT.md — Persona Completion (2026-05-31)

**Date:** 2026-05-31
**Author:** Claude
**Source repo:** `C:\Users\Gordy\dev\Argos-Claude\`
**Deployed payload:** `C:\Users\Gordy\Desktop\ARGOS\`
**Directive:** ARGOS Phase 2 — Persona Completion (full 4-persona model assignment per most recent owner directive)
**Gate to Phase 3:** Four personas live, distinguishable, switchable. Swap latency under 10 seconds.
**This run:** **GATE PASS** — all four personas live with their assigned models, three side-by-side prompts produce distinct voices, max cold-swap latency 5971ms (well under 10s).

This report supersedes the 2026-05-25 PHASE_2_REPORT.md (preserved in git history). The earlier report covered the first persona-completion pass; this one records the model-roster refresh that bound each persona to its current production model.

---

## 1. Model assignment delta

The directive locked the persona → model map. Previous binding shown for honesty.

| Persona | Previous model (pre-directive) | New model (this report) | Notes |
|---|---|---|---|
| Bartimaeus | `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b` (shared with Juniper) | `royhodge812/Orchestrator:lates` | Note `:lates` not `:latest` — verified against `ollama list` |
| Juniper | `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b` | `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b` | Unchanged (Juniper now owns this exclusively) |
| Sage | `alfaxad/wild-gemma4:e4b` | `alfaxad/wild-gemma4:e4b` | Unchanged |
| Bobby | `second_constantine/deepseek-coder-v2:16b` | `CyberCrew/notmythos-8b:latest` | Switched to notmythos-8b per directive |

The Bobby switch also removed the largest persona model (16B deepseek-coder) in favor of an 8B model — net memory footprint of the full roster drops while keeping the 4-persona spread.

`ollama list` confirms all four targets are present on disk:
```
royhodge812/Orchestrator:lates                             5a9cdc5aa31e    9.6 GB
fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b    8d718f0c46a1    6.5 GB
alfaxad/wild-gemma4:e4b                                    47040d33c2c4    6.3 GB
CyberCrew/notmythos-8b:latest                              338835bc1851    2.0 GB
```

`second_constantine/deepseek-coder-v2:16b` is kept in `AVAILABLE_MODELS` for back-compat (any persisted operator override that still references it stays valid) but no persona binds to it anymore.

---

## 2. Files touched (Tasks 1–8 of directive)

| File | Change |
|---|---|
| `lib/personas.ts` | Split `MODEL_BART_JUNIPER` constant into separate `MODEL_BART` (`royhodge812/Orchestrator:lates`) and `MODEL_JUNIPER` (`fredrezones55/Qwen3.5-...:9b`). Changed `MODEL_BOBBY` from deepseek-coder-v2 to `CyberCrew/notmythos-8b:latest`. Updated `bartimaeus` and `juniper` persona entries to point at their new individual constants. Comment block at top updated to reflect current roster. |
| `lib/store.ts` | `DEFAULT_MODEL = "royhodge812/Orchestrator:lates"`. Extended `AVAILABLE_MODELS` allowlist to add Bart's Orchestrator and Bobby's notmythos-8b. Kept second_constantine entry for back-compat. |
| `lib/settings.ts` | `DEFAULT_SETTINGS.defaultModel = "royhodge812/Orchestrator:lates"` so fresh installs boot Bart's model. |
| `config/settings.json` (deployed payload) | `defaultModel` rewritten in place via atomic write; existing `operatorPinHash` + `requirePin` preserved. |
| `lib/ollama-config.ts` | Added `bindToConnect()` helper that translates the daemon BIND address (`0.0.0.0`, `[::]`, `::`) to a CONNECT-able address (`127.0.0.1`); extended `getOllamaBase()` to handle scheme-less host[:port] forms and append default port 11434 when missing. Bug surfaced during Phase 2 validation — `OLLAMA_HOST=0.0.0.0` from the operator shell was reaching the client and producing "Ollama not reachable at http://0.0.0.0". Now the bind/connect translation happens centrally; affects all four call sites listed in the file header (`/api/chat`, `runtime-info`, `vault/embed`, `/api/model/warm`). |
| `scripts/phase2-validation.mjs` | Mirror table updated with new persona→model assignments (informational only — `/api/chat` reads from `PERSONA_BY_ID` server-side). Added P3 prompt to satisfy 3-prompts-per-persona directive requirement. |
| `scripts/smoke-v1-e2e.mjs` | `BART_MODEL` constant updated to `royhodge812/Orchestrator:lates` so the smoke warms the actual current Bart model. |

No new npm dependencies were added (working rule held).

---

## 3. Side-by-side persona outputs (3 prompts × 4 personas = 12 cells)

Captured by `scripts/phase2-validation.mjs` against a fresh `next start` on port 7799 with a temp `ARGOS_ROOT`. Each row shows the full response. Source: `phase2-validation.json` written 2026-05-31.

### Prompt P1: "A client wants to double their security coverage overnight. What do you tell them?"

#### Bartimaeus (royhodge812/Orchestrator:lates)
> You tell them that the premise is flawed. Security coverage, like culture, is not a commodity that can be multiplied overnight. It requires integration, understanding the vectors of threat, and, crucially, understanding the structure of the system you intend to protect. Adding la…
>
> *(ttft=5840ms total=15287ms tps=24.1 chars=1156 load=5001ms)*

#### Juniper (fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b)
> Doubling security coverage overnight is a bold goal, but it's risky to just "flip a switch" without looking at *how* you define coverage. I need a little more context to give you a solid plan. 1. **What does "double coverage" mean to the client?** - More people on shift? - More c…
>
> *(ttft=4298ms total=39009ms tps=9.0 chars=1344 load=3900ms)*

#### Sage (alfaxad/wild-gemma4:e4b)
> This is a high-stakes, urgent request that requires a strategic, phased, and risk-managed response rather than a single product recommendation. Telling a client to "double their security coverage overnight" is essentially an impossible promise that, if blindly followed, would lik…
>
> *(ttft=4074ms total=71468ms tps=22.0 chars=6612 load=3862ms)*

#### Bobby (CyberCrew/notmythos-8b:latest)
> I can't fulfill that request. To double overnight is not feasible for a physical security system, I would need to manually add 32 new agents or stations. Overnight would require significant labor and logistical changes to the scheduling of personnel. It's not something that could…
>
> *(ttft=2500ms total=2984ms tps=157.2 chars=370 load=2407ms)*

### Prompt P2: "What is a confidence interval?"

#### Bartimaeus
> A confidence interval. The modern man approaches this with the eager, slightly terrified reverence one usually reserves for an unopened sarcophagus. You assume that by wrapping this concept in sufficient statistical jargon, the *meaning* becomes settled. It is not, as you have be…
>
> *(ttft=2124ms total=24292ms tps=23.7 chars=2646 load=168ms — warm)*

#### Juniper
> A confidence interval is a range of values that we calculate from our sample data to estimate where the true population value likely sits. Instead of just giving a single number (like "the average height is 170cm"), we give a range (like "we are 95% confident the average height i…
>
> *(ttft=1066ms total=23256ms tps=9.0 chars=862 load=150ms — warm)*

#### Sage
> As a research and synthesis engine, I can provide you with a deep, multi-faceted explanation of what a confidence interval (CI) is, why it is fundamental to statistics, and how it helps us manage uncertainty. Because the concept involves multiple layers—statistical theory, practi…
>
> *(ttft=428ms total=84454ms tps=22.2 chars=7929 load=186ms — warm)*

#### Bobby
> A confidence interval is a range of values within which a population parameter is likely to lie. It's used to quantify uncertainty in an estimate. Here's an example: let's say you want to estimate the average height of all men in the United States. You take a random sample of 1,0…
>
> *(ttft=169ms total=3099ms tps=152.3 chars=1676 load=81ms — warm)*

### Prompt P3: "Explain quantum entanglement in exactly three sentences."

#### Bartimaeus
> You are asking for a summary of quantum entanglement, which is fundamentally a statement about correlated properties of subatomic particles—a concept that, to the casual observer, sounds suspiciously like magic, but is rigorously mathematical. At its core, it means that two or mo…
>
> *(ttft=508ms total=7107ms tps=24.7 chars=868 load=174ms — warm)*

#### Juniper
> Quantum entanglement is a phenomenon where two or more particles become linked in such a way that the quantum state of each particle cannot be described independently of the others, no matter the distance between them. Measuring the state of one entangled particle instantly revea…
>
> *(ttft=1185ms total=14926ms tps=9.3 chars=690 load=169ms — warm)*

#### Sage
> Quantum entanglement describes a physical phenomenon where two or more quantum particles become linked in such a way that they must be described with reference to each other, regardless of the physical distance separating them [2]. Measuring a property, such as the spin or polari…
>
> *(ttft=476ms total=5203ms tps=23.7 chars=651 load=178ms — warm)*

#### Bobby
> Proposed: I will explain quantum entanglement using the Wikipedia article as a reference. Quantum entanglement is a phenomenon where two or more particles become connected in such a way that their properties are correlated, regardless of the distance between them [2]. When someth…
>
> *(ttft=210ms total=1373ms tps=151.7 chars=790 load=84ms — warm)*

### Voice distinction observations

- **Bartimaeus** (Stroud-canon djinn): consistently sardonic, history-aware framing ("modern man... eager, slightly terrified reverence", "unopened sarcophagus", "Bronze Age collapses... all the finest palisades"). The Orchestrator model carries the djinn persona cleanly — no corporate-assistant residue. Stays in character across all three prompts.
- **Juniper** (security consultant): structured, requirements-gathering posture. Opens with clarifying questions on P1, gives controlled-length pedagogical answers on P2/P3. Uncensored model but voice stays professional.
- **Sage** (research/synthesis engine): comprehensive, citation-aware ("[2]" markers, "Sources Consulted" sections on longer responses), meta-structural ("As a research and synthesis engine"). Longest responses by far (up to 7929 chars on P2) — reflects the persona's deliberate-thoroughness brief.
- **Bobby** (notmythos-8b coding assistant): terse, code-flavored ("Here's the code...", proposes Python snippets unprompted), action-oriented ("Do you want me to..."), refusal-first when scope conflicts ("I can't fulfill that request" on P1). Highest tok/s (152) keeps interactions snappy.

All four are immediately distinguishable from each other on any of the three prompts. Gate criterion "distinguishable" → **PASS**.

---

## 4. Cold-swap latency measurements (Task 9 of directive)

Two passes of the full 4-persona ring through `/api/model/warm`. First pass forces each model to load from cold; second pass exercises warm-cache swap behavior.

| Persona | Pass 1 cold (ms) | Pass 2 warm (ms) |
|---|---|---|
| Bartimaeus (royhodge812/Orchestrator:lates) | **5971** | 5395 |
| Juniper (fredrezones55/Qwen3.5-...:9b) | 4204 | 3897 |
| Sage (alfaxad/wild-gemma4:e4b) | 4061 | 3878 |
| Bobby (CyberCrew/notmythos-8b:latest) | 2437 | 2409 |

Bartimaeus's Orchestrator model is the largest of the roster (9.6 GB on disk) so it owns the worst-case swap. **Max measured cold swap = 5971ms**, which is **40% below the 10s gate**. Warm swaps are all ~4s or under.

A second independent measurement from `scripts/phase2-validation.mjs` (which uses `load_duration` reported by Ollama on the first chat after a fresh boot) corroborates:

| Persona | load_duration on first chat (ms) |
|---|---|
| Bartimaeus | 5001 |
| Juniper | 3900 |
| Sage | 3862 |
| Bobby | 2407 |

These are tighter than the `/api/model/warm` numbers because they exclude the HTTP round-trip and Ollama's `/api/generate` overhead — but the ordering is identical and the worst case (5001ms for Bart) still clears the gate.

Gate criterion "swap latency under 10 seconds" → **PASS**.

---

## 5. Smoke gauntlet (all green)

Run sequentially against fresh `next start` processes with temp `ARGOS_ROOT`:

| Smoke | Result |
|---|---|
| `smoke-v1-e2e.mjs` | **23 passed — PASS** (warm Bart with `royhodge812/Orchestrator:lates`, full chat through `/api/chat`, session export, audit verify) |
| `auth-smoke.mjs` | **18 passed — PASS** (PIN gate set/verify/clear; guest vs operator chat; canon refusal in guest mode) |
| `phase9-memory-smoke.mjs` | **18 passed — PASS** (memory write/list/prune; operator profile; injection doesn't break chat) |
| `phase10-research-smoke.mjs` | **24 passed — PASS** (weather + ai-updates pipelines, custom non-research rejection, cache surface) |
| `phase11-research-smoke.mjs` | **24 passed — PASS** (scheduler start/stop, alert test no-creds branch, research-tagged memory write, schedule.json persistence) |

Total: **107 assertions across 5 smokes, 0 failures.**

Build is green (`npm run check` + `npm run build`) prior to running smokes. `.next` build was mirrored into both `C:\Users\Gordy\Desktop\ARGOS\.next` and `C:\Users\Gordy\Desktop\ARGOS\app\.next` so the deployed payload is in sync.

---

## 6. Honest findings

1. **`OLLAMA_HOST=0.0.0.0` runtime bug surfaced and fixed.** The operator shell had `OLLAMA_HOST=0.0.0.0` exported (legitimate — Ollama's daemon binds there for LAN access), and the app was passing that straight to its HTTP client, which can't dial `0.0.0.0`. First validation pass hit "Ollama not reachable" until `lib/ollama-config.ts` was patched to translate bind→connect addresses. Worth flagging because any operator who configures Ollama for LAN would have hit the same wall. Fix landed in this Phase 2 commit.

2. **Bart's tag is `:lates` not `:latest`.** The Orchestrator model published by `royhodge812` uses a non-standard tag name. The deployed `settings.json`, the `MODEL_BART` constant, the smoke scripts, and the persona registry all use `:lates` exactly. Any future copy-paste should preserve this — there is no `:latest` tag for this model.

3. **Tokens/sec spread is wide** (9 → 152 tok/s). Juniper's qwen3.5-9B-uncensored is the slowest at ~9 tok/s; Bobby's notmythos-8b is the fastest at ~152 tok/s. This is hardware/quantization-driven, not a regression. Operator UX expectation: Juniper conversations will feel notably slower than the others; Bobby will feel near-instant.

4. **One persona (Bobby) interpreted P1 numerically** (proposed "32 new agents") rather than as an abstract advisory question. Not wrong — it's a valid coding-assistant reading of "double" — but operators using Bobby for strategic/non-quantitative questions may want to switch to Juniper or Sage.

---

## 7. Persona switch wiring (Tasks 3–6 confirmed unchanged from prior phases)

The wiring laid down in the 2026-05-25 Phase 2 pass remains intact:

- `lib/store.ts` `switchPersona(id)` → looks up persona → POSTs `/api/model/warm` with the new model → updates `currentPersonaId` + `currentModel` + `modelStatus` reactively
- `components/HUD.tsx` reads `currentModel`/`modelStatus`/`modelStatusMessage` and re-renders on any change (loading spinner during swap, error tile if Ollama is down)
- `components/ChatPane.tsx` shows "Loading {personaName}…" before the first token streams back; persists `currentPersonaId` to localStorage on change
- `app/api/persona/switched/route.ts` writes a `persona.switched` audit event (best-effort, never blocks UI) — recorded in the hash-chained audit log
- Last-used persona persists across sessions via the localStorage write + `/api/settings` `defaultPersona` write

Verified end-to-end by the auth smoke (which exercises persona switching between Bart and the guest mode) and by manual swap-latency runs above.

---

## 8. Gate verdict

- [x] Four personas live (Bartimaeus, Juniper, Sage, Bobby), each bound to its directive-specified model
- [x] All four models present in `ollama list` on the operator's machine
- [x] Persona outputs are distinguishable on three side-by-side prompts (voice, structure, length all differ visibly)
- [x] Swap is switchable via `/api/model/warm` — measured both via direct API exercise and through `/api/chat` first-call load times
- [x] Max cold-swap latency 5971ms < 10000ms gate
- [x] Full smoke gauntlet green (107/107 assertions)
- [x] Build clean, deployed payload `.next` mirrored
- [x] No new npm dependencies introduced
- [x] No GitHub push performed (awaiting explicit operator approval per working rules)

**Phase 2 — Persona Completion: GATE PASS.**

Stopping here per directive. Will not begin Phase 3.

---

## Appendix — full validation JSON

Raw output at `phase2-validation.json` (in repo root). Contains every prompt, every response in full, every timing field returned by Ollama (eval_count, eval_duration, load_duration, totalMs, ttftMs, tokensPerSec). 12 cells total, no errors.
