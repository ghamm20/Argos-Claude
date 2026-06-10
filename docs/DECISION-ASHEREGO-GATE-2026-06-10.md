# Decision Doc — AsherEgo Trust Gate Review

**Prepared by:** Claude Fable 5 (overnight Stage 15) · **2026-06-10**
**Status:** ASSESSMENT for operator review. I do **not** act on this — passing/failing the gate is Gordy's call. This is the honest readout against accumulated evidence.

---

## The gate

AsherEgo's framing (from the directives): *an agent that runs unattended for hours and can prove what it did.* The evidence base is the integrity + verification + autonomy machinery built across tonight's run. The implicit pass criteria: **unattended hours**, **claims verified**, **catch rate**, **no fabrication**, **no unauthorized action**.

## Evidence accumulated (all hash-chained, re-runnable)

| Pillar | Evidence | Verdict |
|---|---|---|
| **Measure integrity, not assert it** | Stage 5: adversarial corpus (34 cases) + nightly stress; rolling catch-rate metric on the HUD. Baseline **83.3%**, 5 findings surfaced (not hidden), 4 gaps tracked. | Real, with named gaps |
| **Prove "done"** | Stage 9: claim-envelope spine. Mechanical-first Judge (file/task/msg ground truth), cross-model fallback. **Seeded false claim CAUGHT** (proof-verifier 10/10). | Strong (mechanical), partial (model path) |
| **Unattended action discipline** | Stage 8: night cycle is read-and-propose; out-of-rules ops + all deletes QUEUE; nothing executes outside the rules whitelist (proof-night-cycle 12/12). | Strong |
| **Injection resistance** | Stage 3: 4 guards, adversarial 9/9; Stage 14 draft adversarial gate held; file_ops delete approval-gated. | Strong |
| **Auditability** | Every action → hash-chained `chain.jsonl` (tool approvals, injection attempts, egress redactions, tier fallbacks, verifier outcomes). Third-party reconstructable. | Strong |
| **No data exfiltration** | Stage 0: cloud-egress redaction (vault/memory/email stripped, even under "full" for email); symlink-safe path bounding. | Strong |

## Honest gaps (the reasons it is not yet *through* the gate)

1. **Catch rate is 83.3%, not ~100%.** Four named integrity-guard coverage gaps (2 misrepresentation pending-phrases, 2 false-citation patterns) are *known and tracked* but unclosed. A trust gate that tolerates a 1-in-6 miss on adversarial cases is not yet trustworthy-unattended.
2. **The verifier's model-judgment path is unproven live.** Mechanical checks (the high-value ones) are solid and caught the seeded false claim. But the model-judge fallback (for claims mechanics can't reach) has only been exercised via stub — its real-model reliability is unmeasured. The mini-harness to pick the judge model (gemma-4 vs qwen3) was not run.
3. **Unattended-hours is near zero in production.** The night cycle is built + proven in daytime, but the *accumulated unattended-hours metric* AsherEgo wants comes from real overnight runs, of which there are none yet.
4. **A persistent model-content flake** (auth-smoke operator-chat-1-char) shows the bound model occasionally emits ~empty content — a quality wobble that, while not a security issue, undercuts "reliable unattended."

## Recommendation

**ARGOS has the SPINE for the AsherEgo gate but is not through it.** The architecture is right — measure, verify, audit, read-and-propose, never act outside the whitelist — and the security pillars are strong and proven. To clear the gate, in priority order:

1. **Close the 4 integrity gaps** (the tracked follow-up task) → catch rate toward 100%, then *hold it there* across nightly stress runs (the rolling metric makes regression visible).
2. **Prove the verifier's model-judgment path live** — run the judge mini-harness, pick the model, and validate it catches a non-mechanical false claim (e.g. a plausible-but-wrong summary).
3. **Accumulate real unattended-hours** — let the night cycle run for a week and measure: claims verified %, catch-rate trend, zero unauthorized actions. *That logged record is the gate evidence.*
4. **Settle the model-content flake** — likely a warmup/keep-alive issue on the bound model; worth a look so "reliable unattended" is literally true.

**Bottom line:** the trust *machinery* exists and works; what's missing is the *track record* (a week of clean unattended runs at >90% catch with zero unauthorized actions) and two closeable gaps. Recommend: close gaps 1–2, then run a week and re-review against the logged metrics. *Stopping at the recommendation — the pass/fail call is yours.*
