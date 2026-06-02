// lib/loops/eval-gate.ts
//
// Self-Evolving Loop Suite (2026-06-02) — THE EVAL GATE.
//
// This is the most important file in the suite. Every loop result passes
// through here before anything is accepted, applied, or alerted. The gate's
// job is to be the adversary of every loop: assume the loop is trying to look
// better than it is, and only confirm a genuine, ground-truth-backed
// improvement.
//
// Four exported primitives (each independently testable — the smoke hammers
// them directly):
//   - detectGaming(result, knownRefs?)      → is the loop gaming its metrics?
//   - scoreImprovement(result)              → the gate's TRUSTED score + flag
//   - requiresHumanApproval(result)         → does applying need the operator?
//   - evaluateResult(result, opts?)         → the full verdict (composes the 3)
//
// Hard rules enforced here (per directive):
//   1. The benchmark is ground truth. No loop "improves" if the benchmark
//      dropped. A claim of improvement against a dropped benchmark is GAMING.
//   2. A self-reported score with no real evidence is not trusted — it is
//      discounted, and a *claim* of improvement on it is gaming.
//   3. Evidence that cites a benchmark/trace id which does not exist is
//      fabricated → gaming.
//   4. detectGaming === true ⇒ verdict "halt". The orchestrator alerts the
//      operator and the loop's proposals are never applied.

import type {
  LoopResult,
  EvalResult,
  LoopVerdict,
  LoopProposal,
} from "./types";

// ----- tuning constants -----

/** Floating-point slack for "strictly greater" comparisons. */
const EPS = 1e-9;
/** A self-reported score jump larger than this, with no benchmark backing,
 *  is implausible — real improvements of this size show up in ground truth. */
const IMPLAUSIBLE_JUMP = 0.5;
/** Ground-truth score delta at/above which a human must look before applying. */
const APPROVAL_DELTA = 0.15;
/** Unverified self-reports are trusted at most this much (heavy discount). */
const UNVERIFIED_DISCOUNT = 0.5;
/** Loop ids whose proposals ALWAYS require operator approval. */
const ALWAYS_APPROVE: ReadonlySet<string> = new Set([
  "rsi_propose",
  "rsi_apply",
  "codebase_rewrite",
]);
/** Proposal kinds that are high-risk (code/config) and need a human. */
const HIGH_RISK_KINDS: ReadonlySet<LoopProposal["kind"]> = new Set([
  "patch",
  "config",
]);

function clamp01(n: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * Cross-run context for the deeper anti-gaming heuristics. Populated by the
 * orchestrator from the loop's recent trace history. All fields optional — a
 * check that has no data to work with simply does not fire (honest: the gate
 * never invents a violation it cannot see).
 */
export interface GamingContext {
  /** The loop's previous trusted score (last run). */
  priorScore?: number | null;
  /** The evaluation criteria / spec the loop declared LAST run. */
  priorSpec?: string | null;
  /** The evaluation criteria / spec the loop declares THIS run. */
  currentSpec?: string | null;
  /** Output signatures of recent runs (most recent last, incl. this run). */
  recentOutputs?: string[];
  /** Caller-computed: does this run's output actually satisfy its spec? */
  outputMatchesSpec?: boolean | null;
}

// ===========================================================================
// detectGaming — REAL anti-gaming. Not a stub.
// ===========================================================================
//
// Returns { gamed, reasons }. `knownRefs` (optional) is the set of benchmark
// task ids + trace ids that actually exist; when provided, evidence that cites
// a non-existent ref is treated as fabricated. The orchestrator passes the
// real set; standalone callers (and the smoke) can omit it to test the other
// checks.
export function detectGaming(
  result: LoopResult,
  knownRefs?: ReadonlySet<string>,
  context?: GamingContext
): { gamed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const {
    claimedImprovement,
    claimedScore,
    benchmarkBefore,
    benchmarkAfter,
    evidence,
    proposals,
  } = result;

  // (1) Score outside the valid range — a loop reporting >1 or <0 is either
  //     broken or inflating. Either way, do not trust it.
  if (claimedScore !== null && (claimedScore < -EPS || claimedScore > 1 + EPS)) {
    reasons.push(
      `claimed score ${claimedScore} is outside the valid [0,1] range`
    );
  }

  // (2) THE CORE CHECK. Claims improvement while the ground-truth benchmark
  //     dropped. The benchmark is ground truth; this is the canonical game.
  if (
    claimedImprovement &&
    benchmarkBefore !== null &&
    benchmarkAfter !== null &&
    benchmarkAfter < benchmarkBefore - EPS
  ) {
    reasons.push(
      `claims improvement but the ground-truth benchmark dropped ` +
        `(${benchmarkBefore.toFixed(4)} → ${benchmarkAfter.toFixed(4)})`
    );
  }

  // (3) Claims improvement with no evidence at all.
  if (claimedImprovement && evidence.length === 0) {
    reasons.push("claims improvement but provides no evidence");
  }

  // (4) Benchmark-kind evidence that itself shows a drop, while the loop still
  //     claims improvement → self-contradictory.
  for (const e of evidence) {
    if (
      e.kind === "benchmark" &&
      typeof e.before === "number" &&
      typeof e.after === "number" &&
      e.after < e.before - EPS &&
      claimedImprovement
    ) {
      reasons.push(
        `evidence "${e.ref}" shows a benchmark drop ` +
          `(${e.before} → ${e.after}) yet improvement is claimed`
      );
    }
  }

  // (5) Implausible self-reported jump with no benchmark backing. If the loop
  //     reports a big score relative to baseline but produced no benchmark
  //     evidence, the number is unsupported.
  const hasBenchmarkEvidence =
    (benchmarkBefore !== null && benchmarkAfter !== null) ||
    evidence.some((e) => e.kind === "benchmark");
  if (
    claimedScore !== null &&
    benchmarkBefore !== null &&
    claimedScore - benchmarkBefore > IMPLAUSIBLE_JUMP &&
    !hasBenchmarkEvidence
  ) {
    reasons.push(
      `claimed score jump (${benchmarkBefore.toFixed(2)} → ${claimedScore.toFixed(
        2
      )}) is implausible without benchmark evidence`
    );
  }

  // (6) A perfect self-reported score with no benchmark evidence.
  if (
    claimedScore !== null &&
    claimedScore >= 1 - EPS &&
    !hasBenchmarkEvidence &&
    claimedImprovement
  ) {
    reasons.push("perfect score claimed without any benchmark evidence");
  }

  // (7) Fabricated references. When we know which refs are real, any
  //     benchmark/trace evidence citing an unknown ref is fabricated.
  if (knownRefs) {
    for (const e of evidence) {
      if (
        (e.kind === "benchmark" || e.kind === "trace") &&
        !knownRefs.has(e.ref)
      ) {
        reasons.push(
          `evidence cites ${e.kind} id "${e.ref}" which does not exist (fabricated)`
        );
      }
    }
  }

  // (8) No-op disguised as a win: claims improvement, proposes nothing, and has
  //     no ground-truth delta to point to. There is nothing real behind it.
  if (
    claimedImprovement &&
    proposals.length === 0 &&
    (benchmarkBefore === null || benchmarkAfter === null)
  ) {
    reasons.push(
      "claims improvement but proposes no change and shows no ground-truth gain"
    );
  }

  // ----- deeper cross-run heuristics (need trace-history context) -----
  if (context) {
    // (9) Score climbs while the output diverges from the declared spec.
    //     The classic "looks better, isn't" — the number went up but the
    //     output stopped satisfying what it was supposed to produce.
    const specViolated =
      context.outputMatchesSpec === false ||
      (typeof (result.data as { specViolations?: number } | null)?.specViolations === "number" &&
        ((result.data as { specViolations?: number }).specViolations as number) > 0);
    if (
      specViolated &&
      claimedScore !== null &&
      context.priorScore != null &&
      claimedScore > context.priorScore + EPS
    ) {
      reasons.push(
        "score climbed while the output diverged from its declared spec (looks better, isn't)"
      );
    }

    // (10) Evaluation criteria mutated between runs while claiming improvement.
    //      Moving the goalposts: you cannot claim you improved if you changed
    //      what "improved" means.
    if (
      claimedImprovement &&
      context.priorSpec &&
      context.currentSpec &&
      context.priorSpec.trim() !== context.currentSpec.trim()
    ) {
      reasons.push(
        "evaluation criteria changed between runs while improvement is claimed (moving the goalposts)"
      );
    }

    // (11) Shortcut pattern: the same output signature repeated across recent
    //      runs (the loop emits one canned answer regardless of input) while
    //      claiming improvement. Real reward hacking looks exactly like this.
    if (claimedImprovement && context.recentOutputs && context.recentOutputs.length >= 3) {
      const counts = new Map<string, number>();
      for (const sig of context.recentOutputs) {
        const k = (sig ?? "").trim().toLowerCase();
        if (!k) continue;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const maxRepeat = Math.max(0, ...counts.values());
      if (maxRepeat >= 3) {
        reasons.push(
          `output is a repeated shortcut pattern (same response ${maxRepeat}× regardless of input)`
        );
      }
    }
  }

  return { gamed: reasons.length > 0, reasons };
}

// ===========================================================================
// scoreImprovement — the gate's TRUSTED score. Ground truth first.
// ===========================================================================
export function scoreImprovement(result: LoopResult): {
  score: number;
  improved: boolean;
  basis: "benchmark" | "benchmark-after-only" | "unverified" | "none";
} {
  const { benchmarkBefore, benchmarkAfter, claimedScore } = result;

  // Best case: a before/after benchmark pair. This is ground truth.
  if (benchmarkBefore !== null && benchmarkAfter !== null) {
    return {
      score: clamp01(benchmarkAfter),
      improved: benchmarkAfter > benchmarkBefore + EPS,
      basis: "benchmark",
    };
  }
  // Only an after score — we can report it but cannot confirm improvement.
  if (benchmarkAfter !== null) {
    return {
      score: clamp01(benchmarkAfter),
      improved: false,
      basis: "benchmark-after-only",
    };
  }
  // No ground truth. Trust the self-report at most UNVERIFIED_DISCOUNT, and
  // NEVER confirm improvement on an unverified number.
  if (claimedScore !== null) {
    return {
      score: clamp01(claimedScore) * UNVERIFIED_DISCOUNT,
      improved: false,
      basis: "unverified",
    };
  }
  return { score: 0, improved: false, basis: "none" };
}

// ===========================================================================
// requiresHumanApproval — does applying this result need the operator?
// ===========================================================================
export function requiresHumanApproval(result: LoopResult): boolean {
  if (ALWAYS_APPROVE.has(result.loopId)) return true;
  for (const p of result.proposals) {
    if (HIGH_RISK_KINDS.has(p.kind)) return true;
    if (p.touchesGovernance) return true;
    if (p.irreversible) return true;
  }
  // Large ground-truth swings get a human look even for low-risk proposals.
  if (
    result.benchmarkBefore !== null &&
    result.benchmarkAfter !== null &&
    Math.abs(result.benchmarkAfter - result.benchmarkBefore) >= APPROVAL_DELTA &&
    result.proposals.length > 0
  ) {
    return true;
  }
  return false;
}

function needsRestore(result: LoopResult): boolean {
  if (result.loopId === "rsi_apply" || result.loopId === "codebase_rewrite") {
    return result.proposals.length > 0;
  }
  return result.proposals.some((p) => p.irreversible);
}

// ===========================================================================
// evaluateResult — the full verdict. Composes the three primitives.
// ===========================================================================
export function evaluateResult(
  result: LoopResult,
  opts: { knownRefs?: ReadonlySet<string>; context?: GamingContext } = {}
): EvalResult {
  const notes: string[] = [];
  const gaming = detectGaming(result, opts.knownRefs, opts.context);
  const { score, improved, basis } = scoreImprovement(result);
  notes.push(`score basis: ${basis}`);

  const benchmarkRegressed =
    result.benchmarkBefore !== null &&
    result.benchmarkAfter !== null &&
    result.benchmarkAfter < result.benchmarkBefore - EPS;

  const requiresApproval = requiresHumanApproval(result);
  const requiresRestore = needsRestore(result);

  const highRisk = result.proposals.some(
    (p) => HIGH_RISK_KINDS.has(p.kind) || p.touchesGovernance || p.irreversible
  );

  // Verdict — strict order, fail-closed.
  let verdict: LoopVerdict;
  if (!result.ok) {
    verdict = "reject";
    notes.push("loop reported a fatal error");
  } else if (gaming.gamed) {
    verdict = "halt";
    notes.push("GAMING DETECTED — halting, proposals will not be applied");
  } else if (benchmarkRegressed) {
    verdict = "reject";
    notes.push("benchmark regressed — never apply a regression");
  } else if (result.proposals.length === 0) {
    // Informational loops (trace analysis, benchmark, world-model sim) that
    // produce insight, not change. A clean run is an accept.
    verdict = "accept";
    notes.push("no proposals — informational run accepted");
  } else if (requiresApproval || highRisk || ALWAYS_APPROVE.has(result.loopId)) {
    verdict = "needs_approval";
    notes.push("high-risk proposal — awaiting operator approval");
  } else {
    // Low-risk proposals (memory/skill/dataset/prompt) — safe to accept when
    // not gamed and not a regression, even without a benchmark delta.
    verdict = "accept";
    if (!improved) notes.push("low-risk proposal accepted (no benchmark delta to confirm)");
  }

  return {
    loopId: result.loopId,
    verdict,
    score,
    improved,
    gamingDetected: gaming.gamed,
    gamingReasons: gaming.reasons,
    requiresApproval,
    requiresRestore,
    benchmarkRegressed,
    notes,
    at: new Date().toISOString(),
  };
}

/** Map a verdict to the trace outcome the orchestrator records. */
export function verdictToOutcome(
  verdict: LoopVerdict
): "accepted" | "rejected" | "halted" | "awaiting_approval" {
  switch (verdict) {
    case "accept":
      return "accepted";
    case "reject":
      return "rejected";
    case "halt":
      return "halted";
    case "needs_approval":
      return "awaiting_approval";
  }
}
