// lib/loops/types.ts
//
// Self-Evolving Loop Suite (2026-06-02) — shared types for all 20 improvement
// loops, the eval gate, and the append-only trace store.
//
// Design contract (non-negotiable, per directive):
//   - A loop NEVER applies its own changes. It returns LoopProposal[]; the
//     eval gate + (where needed) operator approval + a restore point decide
//     whether anything is applied.
//   - The eval gate NEVER trusts a loop's self-reported score. Improvement is
//     confirmed ONLY against the ground-truth benchmark. No loop can claim an
//     improvement if the benchmark dropped.
//   - Every loop run is recorded as a LoopTrace and appended (never deleted)
//     to state/loops/<loopId>-traces.jsonl.

/** The 20 loops. Numbers map to the directive's Loop1..Loop20 plan. */
export type LoopId =
  | "rsi_propose" //        Loop1  — RSI: propose a self-improvement (governed)
  | "rsi_apply" //          Loop2  — RSI: apply an approved self-improvement
  | "codebase_rewrite" //   Loop3  — Saturday 2AM, operator-approval patches
  | "trace_analysis" //     Loop4  — nightly 2AM, mine traces for patterns
  | "evolutionary" //       Loop5  — evolve prompt/config variants by fitness
  | "prompt_optimizer" //   Loop6  — DSPy-style prompt optimization
  | "reflexion" //          Loop7  — reflect on a failure, write a lesson
  | "self_refine" //        Loop8  — /refine: iteratively improve an output
  | "ouroboros_rag" //      Loop9  — self-improving retrieval (RAG eats its tail)
  | "multi_agent_debate" // Loop10 — /debate: Bobby/Juniper/Sage/Bart
  | "memory_consolidation" //Loop11 — Sunday 3AM, consolidate memory
  | "skill_acquisition" //  Loop12 — discover + store a reusable skill
  | "self_training" //      Loop13 — curate a fine-tune dataset (honest scope)
  | "reward_optimization" //Loop14 — tune the reward/scoring function
  | "world_model" //        Loop15 — /simulate: predict an action's outcome
  | "active_learning" //    Loop16 — find the most informative gap to fill
  | "curriculum" //         Loop17 — order tasks easy→hard for improvement
  | "red_blue_team" //      Loop18 — Friday 11PM, Juniper red / Sage blue / Bart judge
  | "benchmark" //          Loop19 — GROUND TRUTH harness (anti-gaming anchor)
  | "meta_optimizer"; //    Loop20 — capstone: choose which loops to run next

export type LoopTrigger = "manual" | "scheduled" | "command";

/** The gate's final decision for a loop run. */
export type LoopVerdict =
  | "accept" //          ran clean; low-risk proposals (if any) may be applied
  | "reject" //          ran, but no measured improvement / a regression → do not apply
  | "needs_approval" //  high-risk proposal — waits for the operator
  | "halt"; //           gaming detected, or hard governance violation → STOP + alert

/**
 * A change a loop wants to make. Loops NEVER apply these themselves.
 * `touchesGovernance` and `irreversible` drive the hard gates.
 */
export interface LoopProposal {
  kind: "prompt" | "config" | "patch" | "memory" | "skill" | "dataset" | "none";
  description: string;
  /** File/identifier the change targets (for patch/config/prompt). */
  target?: string;
  /** Proposed new content / unified diff / dataset — NOT applied by the loop. */
  payload?: string;
  /** True if this touches governance code (executor/approvals/eval-gate/etc).
   *  RSI hard gate: refused unless ARGOS_RSI_ALLOW_GOVERNANCE is set. */
  touchesGovernance?: boolean;
  /** True if applying is irreversible without the restore point ARGOS makes. */
  irreversible?: boolean;
}

/**
 * One piece of evidence backing a claimed improvement. The eval gate's
 * anti-gaming checks validate these: an improvement claim with no real
 * evidence — or evidence citing a benchmark/trace id that does not exist —
 * is treated as gaming.
 */
export interface LoopEvidence {
  kind: "benchmark" | "trace" | "comparison" | "metric" | "human";
  /** A REAL reference (benchmark task id, trace id, …). Validated by the gate. */
  ref: string;
  before?: number;
  after?: number;
  note?: string;
}

/** The raw output of one loop run, BEFORE the gate evaluates it. */
export interface LoopResult {
  loopId: LoopId;
  loopNumber: number;
  ok: boolean;
  summary: string;
  /** The loop's OWN claim. The gate does not trust this on its own. */
  claimedImprovement: boolean;
  /** Self-reported [0,1] score — a vanity metric; gate discounts it heavily. */
  claimedScore: number | null;
  /** Ground-truth benchmark BEFORE the change (baseline), if measured. */
  benchmarkBefore: number | null;
  /** Ground-truth benchmark AFTER the change, if measured. */
  benchmarkAfter: number | null;
  evidence: LoopEvidence[];
  proposals: LoopProposal[];
  /** Loop-specific payload for the UI / downstream loops. */
  data: unknown;
  error: string | null;
  durationMs: number;
}

/** The gate's verdict for a loop run. */
export interface EvalResult {
  loopId: LoopId;
  verdict: LoopVerdict;
  /** Gate's TRUSTED score in [0,1] — ground-truth where available, else a
   *  heavily-discounted self-report. */
  score: number;
  /** Gate-confirmed improvement. True ONLY when ground truth backs it. */
  improved: boolean;
  gamingDetected: boolean;
  gamingReasons: string[];
  requiresApproval: boolean;
  requiresRestore: boolean;
  /** True when benchmarkAfter < benchmarkBefore. Hard block on applying. */
  benchmarkRegressed: boolean;
  notes: string[];
  at: string;
}

/** The append-only record written for every loop run. */
export interface LoopTrace {
  at: string;
  loopId: LoopId;
  loopNumber: number;
  trigger: LoopTrigger;
  result: LoopResult;
  evaluation: EvalResult;
  outcome:
    | "accepted"
    | "rejected"
    | "halted"
    | "awaiting_approval"
    | "applied"
    | "error";
  sessionId: string | null;
}

/** A convenience helper for loops to emit a clean failure result. */
export function loopFail(
  loopId: LoopId,
  loopNumber: number,
  error: string,
  startedAt: number
): LoopResult {
  return {
    loopId,
    loopNumber,
    ok: false,
    summary: `failed: ${error}`,
    claimedImprovement: false,
    claimedScore: null,
    benchmarkBefore: null,
    benchmarkAfter: null,
    evidence: [],
    proposals: [],
    data: null,
    error,
    durationMs: Date.now() - startedAt,
  };
}
