# Decision Doc — Inference Phase B (external providers)

**Prepared by:** Claude Fable 5 (overnight Stage 15) · **2026-06-10**
**Status:** RECOMMENDATION for operator review. I do **not** act on this — Phase B remains a decision for Gordy. Providers are **not** wired.

---

## The question

Phase B = wiring paid frontier providers (OpenAI / Claude) as a third inference backend alongside local Ollama and the free Nous tier. Stage 7 gated this decision on **~1 week of real latency/cost data**. This doc reads the data captured so far and recommends.

## The data (real, from `state/audit/chain.jsonl` via `scripts/inference-report.mjs --root D:\ARGOS`)

Window 2026-06-08 → 2026-06-09, **13 turns**:

| backend | turns | share | p50 | p95 | tok in | tok out |
|---|---|---|---|---|---|---|
| nous (free Nemotron) | 11 | 85% | **9.2 s** | 29.1 s | 79,769 | 1,066 |
| local (Ollama, 8 GB) | 2 | 15% | **61.4 s** | 61.4 s | 14,100 | 351 |

**Fallback rate: 15.4%** (2/13) — both `nous_error` (empty content ×1, aborted ×1).

## What the data says (honest, with the caveat up front)

**The sample is too small to decide on.** 13 turns over 2 days is not the ~1 week Stage 7 required. Everything below is a *preliminary signal*, not a verdict.

- **Local is slow on 8 GB:** p50 61 s. That's cold-load + RAM spill on the 3060 Ti (one model at a time, swap cost). The GPU-agnostic layer (G1–G4) means this *self-fixes on ample hardware* — a 24 GB card holds models resident (no swap) and the tiered registry routes to larger models. **A bigger card is a cheaper reliability fix than a paid provider for the latency problem.**
- **Nous is fast and free but flaky:** p50 9.2 s, but **15.4% fallback** (empty/aborted). For an unattended operator, a 1-in-7 silent fallback to a 61 s local turn is a real reliability tax.
- **The cost question is unanswered by this data** — there is no paid-provider column to compare against, because none is wired. Phase B's whole point is to *get* that column.

## Recommendation

**Do not wire Phase B yet. Collect a full week first** — the data discipline Stage 7 set is correct and the sample is a fifth of it. Concretely:

1. **Run another ~5 days** of normal use so the rollup has 50–100+ turns across more conditions.
2. **Decision rule for the week-out review:** wire a paid provider **only if** (a) the Nous fallback rate stays **>10%** *and* (b) the operator needs a specific persona to be reliable-and-fast on the current 8 GB box (i.e. before the bigger card lands). If a 24 GB card is imminent, **prefer the hardware** — the agnostic layer already routes to it for free, and local-resident inference beats paying per token.
3. **If wired,** scope it like Nous: one provider, `gmail.readonly`-style least-privilege, encrypted key, per-persona opt-in, honest per-turn `chat.inference` audit (already capturing everything Phase B needs — Stage 7 confirmed), and the **same cloud-egress redaction** (Stage 0) so vault/memory/email never leave the box on a paid turn either.

**Bottom line:** the preliminary data points at *reliability* (15% fallback) and *local latency* (61 s) as the real pains — and the cheaper fix for both is the ample-tier GPU the system now detects automatically, not a per-token bill. Revisit with a full week of data. *Stopping at the recommendation.*
