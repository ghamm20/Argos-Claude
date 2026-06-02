// lib/loops/rsi-gate.ts
//
// Self-Evolving Loop Suite (2026-06-02) — RSI (Recursive Self-Improvement)
// governance gate. Loop1 (rsi_propose) + Loop2 (rsi_apply) + Loop3
// (codebase_rewrite) are the only loops that can change ARGOS's own code or
// config. They are the most dangerous, so they are the most constrained.
//
// THE HARD RULE (per directive, non-negotiable):
//   RSI cannot modify governance code without a special operator flag.
//   Governance = the files that enforce safety: the tool executor / approvals
//   / restore / audit, the eval gate, this gate, the trace store, auth, and
//   the verify-argos doctrine check. Without ARGOS_RSI_ALLOW_GOVERNANCE=1 set
//   in the environment, ANY proposal touching these is refused here — before
//   it ever reaches an approval prompt.
//
// The gate is also a hard filesystem boundary: a proposal targeting anything
// outside ARGOS_ROOT is refused.

import path from "node:path";
import { argosRoot } from "../vault/paths";
import type { LoopProposal } from "./types";

/** Path fragments that identify governance-critical files. A target whose
 *  normalized path contains any of these is governance. Kept as fragments so
 *  it matches regardless of absolute prefix or separator. */
const GOVERNANCE_FRAGMENTS: readonly string[] = [
  "lib/tools/executor",
  "lib/tools/approvals",
  "lib/tools/restore",
  "lib/tools/audit",
  "lib/tools/fs-guard",
  "lib/tools/types",
  "lib/loops/eval-gate",
  "lib/loops/rsi-gate",
  "lib/loops/orchestrator",
  "lib/loops/trace-store",
  "lib/loops/types",
  "lib/auth",
  "app/api/tools/approve",
  "app/api/loops/approve-patch",
  "scripts/verify-argos",
  "launchers/",
];

/** True if the env flag explicitly authorizes governance self-modification. */
export function rsiAllowGovernance(): boolean {
  const v = (process.env.ARGOS_RSI_ALLOW_GOVERNANCE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function normalize(target: string): string {
  return target.replace(/\\/g, "/").toLowerCase();
}

/** Does this target path point at governance-critical code? */
export function isGovernanceTarget(target: string): boolean {
  const n = normalize(target);
  return GOVERNANCE_FRAGMENTS.some((frag) => n.includes(frag));
}

/** Is this target inside the ARGOS_ROOT boundary? (Hard fs boundary.) */
export function isWithinBoundary(target: string): boolean {
  try {
    const root = path.resolve(argosRoot());
    const resolved = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(root, target);
    const rel = path.relative(root, resolved);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export interface RsiCheck {
  allowed: boolean;
  /** True when the proposal touches governance (whether or not allowed). */
  governance: boolean;
  reason: string;
}

/**
 * Decide whether an RSI / codebase proposal may proceed to the approval stage.
 * Refuses (allowed:false) when:
 *   - the target escapes ARGOS_ROOT, OR
 *   - the target is governance code AND the override flag is not set.
 * A governance target WITH the flag set is allowed but still flagged
 * (touchesGovernance), so the eval gate forces operator approval + restore.
 */
export function checkRsiProposal(proposal: LoopProposal): RsiCheck {
  const target = proposal.target ?? "";
  if (!target) {
    // No target → not a file change (e.g. a memory/dataset proposal). Allowed.
    return { allowed: true, governance: false, reason: "no file target" };
  }
  if (!isWithinBoundary(target)) {
    return {
      allowed: false,
      governance: false,
      reason: `target "${target}" is outside the ARGOS_ROOT boundary — refused`,
    };
  }
  const governance = isGovernanceTarget(target);
  if (governance && !rsiAllowGovernance()) {
    return {
      allowed: false,
      governance: true,
      reason:
        `target "${target}" is governance code — refused. ` +
        "Set ARGOS_RSI_ALLOW_GOVERNANCE=1 to authorize governance self-modification.",
    };
  }
  return {
    allowed: true,
    governance,
    reason: governance
      ? "governance change authorized by ARGOS_RSI_ALLOW_GOVERNANCE — requires operator approval + restore"
      : "non-governance change — requires operator approval + restore",
  };
}

/**
 * Annotate a proposal with its governance/irreversibility flags so the eval
 * gate routes it correctly. Returns a NEW proposal (does not mutate). If the
 * RSI check refuses it, the description is prefixed with the refusal so the
 * trace records why nothing was applied, and the proposal is downgraded to
 * kind "none" (it will not be applied).
 */
export function annotateRsiProposal(proposal: LoopProposal): LoopProposal {
  const check = checkRsiProposal(proposal);
  if (!check.allowed) {
    return {
      ...proposal,
      kind: "none",
      touchesGovernance: check.governance,
      description: `BLOCKED (${check.reason}) — original: ${proposal.description}`,
    };
  }
  return {
    ...proposal,
    touchesGovernance: check.governance,
    irreversible: true, // any code/config write is irreversible without a restore point
  };
}
