// lib/verifier/schema.ts
//
// Stage 9 (2026-06-09) — the VERIFIER PRIMITIVE. ARGOS stops asserting "done"
// and starts PROVING it. The claim-envelope spine: every action that claims an
// outcome wraps it in a Claim; a Judge pass validates each Claim against ground
// truth (mechanical checks first, model judgment only where mechanics can't
// reach) producing an Outcome; the operator can append an Override grade.
//
// Hash-chained: claims / outcomes / overrides are written to the main audit
// chain (verifier.claim / verifier.outcome / verifier.override) so they inherit
// tamper-evidence, AND mirrored to a queryable state/verifier/ledger.jsonl,
// linked by claim_id.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";

/** A mechanical check the Judge can run WITHOUT a model. */
export type CheckSpec =
  | { type: "file_exists"; path: string }
  | { type: "file_absent"; path: string }
  | { type: "task_status"; taskId: string; expected: "open" | "completed" | "cancelled" }
  | { type: "none" }; // no mechanical check → model judgment (or unverified)

export interface Claim {
  id: string;
  at: string;
  /** Who made the claim, e.g. "night.file_pass", "night.mail_sweep". */
  source: string;
  /** Human-readable assertion. */
  assertion: string;
  /** How to verify it mechanically (or "none"). */
  check: CheckSpec;
}

export type Verdict = "verified" | "unverified" | "failed";
export interface Outcome {
  claimId: string;
  at: string;
  verdict: Verdict;
  method: "mechanical" | "model";
  evidence: string;
  judgeModel?: string;
}

export type Grade = "right" | "wrong" | "partial";
export interface Override {
  claimId: string;
  at: string;
  grade: Grade;
  note: string;
}

export function verifierDir(): string {
  return path.join(argosRoot(), "state", "verifier");
}
function ledgerPath(): string {
  return path.join(verifierDir(), "ledger.jsonl");
}

async function appendLedger(rec: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(verifierDir(), { recursive: true });
  await fsp.appendFile(ledgerPath(), JSON.stringify(rec) + "\n", "utf8");
}

export function makeClaim(source: string, assertion: string, check: CheckSpec, at?: string): Claim {
  return { id: `c_${randomUUID().slice(0, 8)}`, at: at ?? new Date().toISOString(), source, assertion, check };
}

export async function recordClaim(claim: Claim): Promise<void> {
  await appendAudit("verifier.claim", { claimId: claim.id, source: claim.source, assertion: claim.assertion, check: claim.check }).catch(() => {});
  await appendLedger({ rec: "claim", ...claim });
}
export async function recordOutcome(outcome: Outcome): Promise<void> {
  await appendAudit("verifier.outcome", { claimId: outcome.claimId, verdict: outcome.verdict, method: outcome.method, judgeModel: outcome.judgeModel ?? null }).catch(() => {});
  await appendLedger({ rec: "outcome", ...outcome });
}
export async function recordOverride(override: Override): Promise<void> {
  await appendAudit("verifier.override", { claimId: override.claimId, grade: override.grade, note: override.note }).catch(() => {});
  await appendLedger({ rec: "override", ...override });
}

export async function readLedger(): Promise<Array<Record<string, unknown>>> {
  try {
    return (await fsp.readFile(ledgerPath(), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
