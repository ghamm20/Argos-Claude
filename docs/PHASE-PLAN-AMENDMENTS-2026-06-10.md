# Phase plan amendments — owner-approved 2026-06-10

Issued by the owner before Phase 3 start (Phase 2 complete, awaiting release).
These amend the authoritative phase plan and are FROZEN as of issuance —
changing them mid-phase falls under gate immutability (doctrine Rule 11).

## PHASE 3 — SCOPE ADD: observation corpus

- Every owner↔persona exchange is logged to `observation.jsonl`,
  **hash-chained, same doctrine as the audit log** (verify like
  `scripts/verify-audit-chain.mjs`).
- Schema per entry: `timestamp`, `persona`, `topic_class`, `query_type`,
  `session_id`, `sequence_position`.
- **Capture only — no consumer yet.** (The consumer is Phase 4's prediction
  layer.)
- **Gate 4 (added):** `observation.jsonl` populated during the overnight run;
  entries hash-verify.

## PHASE 4 — DESIGN DOCTRINE (IBM/Milvus review)

1. **ReWOO, not ReAct.** The prediction layer plans ahead: Bart emits the
   top-3 predicted next-asks WITH probabilities before any pre-staging.
2. **Reasoning types are NAMED in code + docs:**
   - *abductive* — intent inference from the observation corpus
   - *temporal* — time-of-day / sequence patterns
   - *probabilistic* — confidence + Brier calibration via `lib/verifier/`
   - *neuro-symbolic* — the symbolic planner generates branches; the LLM
     SCORES only
3. **Analogical reasoning never unaided:** the symbolic layer retrieves
   candidate analogous cases from the corpus; the LLM reasons over retrieved
   candidates ONLY.
4. **All predictions are claims:** claim envelope, logged, scored. Silent
   guessing = integrity violation.
5. **Pre-fetch hook fires only at >70% confidence.** Pre-fetched actions are
   PROPOSALS — approval-queue rules apply, zero autonomous execution
   (existing Phase 4 gate 3 covers this).

## Phase 4 design rulings (owner, 2026-06-10 — at gate review)

- **D1 — Class-level predictions: RATIFIED as PERMANENT posture.** The
  observation corpus stays content-free. Content-bearing proposals come from
  workspace scans only. Content storage is not to be raised again; a future
  phase needing it requires a dedicated decision doc, not a rider.
- **D2 — Fusion weights + renormalization: accepted.** Revisit only with
  calibration evidence — when n ≥ 30 scored predictions, the morning brief
  surfaces a Brier trend line; weights change on evidence, not intuition.
- **D3 — Approve-executes-immediately: accepted.** The operator decision IS
  the approval.

## Phase 5 rider — scheduled proposer pass (owner, 2026-06-10)

- The night cycle generates **PROPOSALS ONLY** (no pre-fetch execution
  overnight — already structural: nothing in the proposer executes).
- The morning brief gains a **PROPOSALS section**: the pending queue with
  predicted-ask classes + probabilities.
- The pass is **preflight-gated** like every other night task.

## Implementation notes (recorded at intake, non-binding)

- `topic_class` / `query_type` classification: the keyword classifier in
  `lib/persona-router.ts` (pure CPU, zero model calls) is the natural seed —
  observation capture must add no latency and no model traffic to chat.
- Capture point: post-Phase-2 this belongs in `lib/chat/orchestrator.ts`
  stream-close path (where memory extraction already hooks), or a sibling
  module — never blocking the stream.
- Phase 3 preflight retains the Ollama `/api/tags` health-check +
  auto-restart backstop (owner rider 2026-06-10) on top of the
  launcher watchdog (`launchers/ollama-supervisor.bat`, commit 549dda0).
