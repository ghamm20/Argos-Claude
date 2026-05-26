# ARGOS — Models Reference

Last verified: 2026-05-25 · commits referenced inline.

Hardware target: **RTX 3060 Ti / 8 GB VRAM** (the active envelope). 5090 Power Mode path lives in `config/persona-overrides.example.json` and is documented at the bottom.

---

## Current v1.0+ persona-to-model assignment

| Persona | Model | Quant | Size | `think` flag | Source-of-truth commit |
|---|---|---|---|---|---|
| **Bartimaeus** (boot default) | `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b` | Q4_K_M | 6.09 GB | `false` | `fa8bf4f` (Phase 2, 2026-05-25) |
| **Juniper** | `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b` (shared with Bart) | Q4_K_M | — | `false` | same |
| **Sage** | `alfaxad/wild-gemma4:e4b` | Q4_K_M | 5.89 GB | `false` | same |
| **Bobby** | `nexusriot/Qwen3.5-Uncensored-HauhauCS-Aggressive:4b` | Q4_K_M | 3.14 GB | `false` | same |

Embedding model (Phase 3 vault retrieval): `nomic-embed-text:latest` · 768-dim · 274 MB.

Single source of truth in code: `lib/personas.ts` (`PERSONAS` array). The `lib/store.ts:AVAILABLE_MODELS` array gates `/api/chat` and `/api/model/warm` from dispatching to anything not in the validated set.

---

## `think:false` requirement (Phase 2-RB / v1.1 Task 2)

Per-persona `think` flag in `lib/personas.ts`. Default `false`. **All four current personas have `think:false`.** Reasoning:

- **gemma4 family** (`alfaxad/wild-gemma4:e4b` etc.) — ships with the `thinking` capability enabled by default. If `think:true`, the model emits its entire response to `message.thinking` and **zero** to `message.content`. The chat surface displays `content` only → operator sees an empty bubble. First diagnosed in Phase 2-RB validation (`scripts/validate-e4b.mjs` prompt D: 637 tokens at 21 tok/s, zero visible content).
- **qwen3-thinking family** (Qwen3.5 variants used by Bart, Juniper, Bobby) — same behavior. Verified empirically.

If a future model genuinely benefits from exposed thinking traces (e.g. an o1-style explainer model), flip its `think` flag to `true` in `lib/personas.ts`. The chat route reads it at request time (`app/api/chat/route.ts`) and passes through to Ollama.

---

## Known-bad model: `hf.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive:Q4_K_M`

**Status: PERMANENTLY DISQUALIFIED on RTX 3060 Ti.**

| | |
|---|---|
| Failure mode | CUDA incompatibility — blob loads (manifest valid, hash matches), runtime fails during inference |
| Reproduced | twice; once during Phase 2 hardware-aligned, once during Phase 2-RB Juniper rewire attempt |
| Symptom | model becomes "loaded" in `ollama ps` but `/api/chat` returns garbage tokens or errors out |
| Workaround | `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b` is a working alternative on this hardware (now Bart + Juniper's binding) |

**Do not retry on the 3060 Ti.** If you reinstall this model: `ollama rm "hf.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive:Q4_K_M"` to reclaim ~6.5 GB.

The CUDA incompatibility appears to be specific to this model's compiled kernels + the 3060 Ti's compute capability (8.6). It MIGHT work on newer architectures (5090 = compute 10.x); to be re-evaluated on Power Mode day.

---

## Model swap latency table (measured)

Cold load = first call to a model that's not in Ollama's memory. Warm = subsequent calls within `keep_alive` window. Measurements from `phase2-validation.mjs` (2026-05-25):

| Persona | Cold `load_duration` | Warm `load_duration` | Tok/s | TTFT (warm) |
|---|---|---|---|---|
| Bartimaeus (Qwen3.5 9B) | 4040 ms | 123-216 ms | 14.6-14.8 | 443-639 ms |
| Juniper (same model, shared with Bart) | — (model resident) | 140 ms | 14.6 | 443 ms |
| Sage (wild-gemma4 e4b) | 7123 ms | 182-189 ms | 21.5-21.6 | 250-4329 ms* |
| Bobby (Qwen3.5 4B) | 5610 ms / 3889 ms | 127-134 ms | 75.3-75.4 | 245-4111 ms* |

\* TTFT for Sage P1 and Bobby P1 reflects cold-load + first token (no model resident from prior turn). Subsequent warm queries (P2) are sub-500ms.

Swap timing source: Ollama's `load_duration` from `done_event`. The Phase 2-RB directive's 3-8s cold-swap target is met for all four personas.

---

## Bart + Juniper share a model (no swap cost between them)

Both are wired to `fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:9b`. Switching from Bart to Juniper (or vice versa) costs **zero swap latency** — the model stays resident. Differentiation lives at the persona-prompt level (Bart=austere reasoning engine, Juniper=warm conversational counterpart).

Same model-sharing pattern applies to Bobby + ... actually no, Bobby is on its own 4B model. Documented for future when another persona might share.

---

## Power Mode / 5090 path

When RTX 5090 (or any ≥16 GB VRAM rig) lands:

**Activation:** drop a file at `$ARGOS_ROOT/config/persona-overrides.json`. Template at `config/persona-overrides.example.json`. **Zero code changes** required.

```json
{
  "overrides": {
    "bartimaeus": { "model": "huihui_ai/gpt-oss-abliterated:20b", "status": "live" }
  },
  "availableModelsAdditions": ["huihui_ai/gpt-oss-abliterated:20b"]
}
```

`huihui_ai/gpt-oss-abliterated:20b` is already installed (12.85 GB on disk). On the 3060 Ti it measured 8 tok/s with partial offload (Phase 1.5) — too slow for daily-driver. On a 5090 with 32 GB VRAM it should fit fully on-GPU with room left over for a small auxiliary model.

Plumbing: `lib/persona-server.ts` calls `lib/persona-overrides.ts` to merge the JSON over the static `lib/personas.ts` config at request time. Only `model`, `status`, `intendedModel` can be overridden — identity fields (name, eye color, system prompt) stay code-defined.

---

## Other models in Ollama (not currently persona-bound)

| Model | Size | Status |
|---|---|---|
| `huihui_ai/gpt-oss-abliterated:20b` | 12.85 GB | Power Mode candidate — held until 5090. Set as Bart's `intendedModel`. |
| `gemma2-2b-local:latest` | 1.59 GB | Unused. Kept for eval purposes (small model regression testing). Retained in `AVAILABLE_MODELS` as small-fallback diagnostic. |

---

## Embedding model

`nomic-embed-text:latest` — 768-dim, 274 MB. Used by `lib/vault/embed.ts` for all vault retrieval. Dedicated embedding model (NOT a chat model's `/api/embeddings`) — the Phase 3 directive's "use whichever chat model is loaded" instruction was held during Option B execution because:

1. Different chat models produce different-dimensional embeddings (Qwen3.5 9B = 5120, wild-gemma4 = 3584, Qwen3.5 4B = 2560). Cosine across different-dim vectors is undefined.
2. Even at same dim, vectors live in different learned spaces — cosine becomes noise.
3. Persona switches would invalidate the vault index, costing minutes of re-embed on every swap.

Documented in `PHASE_3_INVENTORY.md` §4 + `PHASE_3_REPORT.md` §1.

---

## Confidence threshold calibration (Phase 3-B)

Calibrated against `nomic-embed-text` observed score distribution on the EKG seed corpus:

```
HIGH    ≥ 0.60   strong topical match
MEDIUM  ≥ 0.50   topical adjacency
LOW     ≥ 0.50   collapsed — no useful "weak" zone above noise floor
drop    < 0.50   noise (returned 0)
```

Recalibration evidence (`PHASE_3_REPORT.md` §4):
- True topical matches: 0.566-0.814
- Off-topic English noise (Q5 "boiling point of water"): 0.459-0.475
- Natural separation: ~0.50

Tune in `lib/vault/types.ts:CONFIDENCE_THRESHOLDS` if you change embedding model or corpus drifts.

---

## Per-persona vault retrieval policy (Phase 3 + v1.1 topK tuning)

| Persona | `defaultEnabled` | `topK` | `minConfidence` | Updated |
|---|---|---|---|---|
| Bartimaeus | true | **8** (was 5) | medium | v1.1 Task 5 |
| Juniper | false (opt-in per request) | 3 | low | unchanged |
| Sage | true | 10 | low | unchanged |
| Bobby | false (opt-in per request) | 3 | low | unchanged |

Bart's `topK=8` was raised from 5 during v1.1 Task 5 — Phase 3 Q1 validation needed 6+ ranked hits to surface both `calloff-management.md` and `performance-review-triggers.md`. Q5 false-citation gate confirmed still 0 hits after the bump.

---

## How to add a new persona-bound model

1. `ollama pull <model>` — confirm it's actually in `ollama list`
2. Validate against your hardware via `scripts/sanity-3prompt.mjs` (cold load + 3 prompts + degenerate-token check)
3. If passes → add to `lib/personas.ts` (set `model`, `think:false` unless you know it benefits from `true`)
4. Add to `lib/store.ts:AVAILABLE_MODELS`
5. `npm run build` clean
6. Run `scripts/phase2-validation.mjs` (4 personas × 2 prompts) — verify no regression
7. Document the binding here

---

## How to deactivate a model permanently

1. Remove from `lib/personas.ts` (or set `status: "not_configured"` if you want to keep the binding documented)
2. Remove from `lib/store.ts:AVAILABLE_MODELS`
3. `ollama rm <model>` to reclaim disk space
4. Document in the "Known-bad model" section above if it failed (so future operators don't re-pull and hit the same wall)

---

## See also

- `lib/personas.ts` — runtime source of truth
- `config/persona-overrides.example.json` — Power Mode swap template
- `docs/RETRIEVAL.md` — embedding + cosine + per-persona retrieval depth
- `PHASE_2_REPORT.md` (2026-05-25) — full persona model assignment + validation
- `PHASE_3_REPORT.md` (2026-05-25) — vault threshold recalibration evidence
- `PHASE_1_5_HARDWARE_REALITY_ALIGNMENT.md` (in deployed payload) — original 3060 Ti measurements
