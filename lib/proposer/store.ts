// lib/proposer/store.ts
//
// Phase 4 (2026-06-10) — THE PROPOSAL QUEUE. Durable, file-backed (the
// in-memory tool-approval store expires in 60s — wrong shape for proposals
// the operator reviews at leisure, possibly the next morning).
//
//   ARGOS_ROOT/state/proposals/pending/<id>.json
//   ARGOS_ROOT/state/proposals/decided/<id>.json   (append-only archive)
//
// ZERO AUTONOMOUS EXECUTION: the ONLY call site that executes a proposal's
// action is decideProposal()'s approve path below — grep-provable. Creating
// a proposal never runs anything; rejecting discards the action unrun. Every
// lifecycle step lands in the hash-chained audit log:
//   proposal.created / proposal.applied / proposal.rejected
// (kinds reserved in lib/audit.ts since Phase 4 of the original ladder).

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";
import { runTool } from "../tools/executor";
import { PERSONA_BY_ID } from "../personas";
import type { ToolResult } from "../tools/types";
import type { ReasoningType } from "./predict";

export type ProposalType =
  | "research_brief"   // pre-fetch research for a predicted ask
  | "draft_document"   // pre-stage a document the operator will likely want
  | "task_queue"       // queue an overnight task matching a predicted need
  | "vault_ingest"     // workspace context: un-ingested drop-zone files
  | "file_op";         // workspace context: a concrete file operation

export type ProposalStatus = "pending" | "rejected" | "executed" | "failed";

export interface ProposalAction {
  toolId: string;
  params: Record<string, unknown>;
}

export interface Proposal {
  id: string;
  at: string;
  type: ProposalType;
  title: string;
  /** Why ARGOS proposes this — names the reasoning that produced it. */
  rationale: string;
  reasoning: ReasoningType[] | ["workspace_context"];
  /** Prediction confidence that triggered the pre-fetch hook (workspace-
   *  context proposals carry null — they are observations, not predictions). */
  confidence: number | null;
  /** Claim id of the prediction behind this proposal, when there is one. */
  predictionClaimId: string | null;
  /** The action that runs ONLY on operator approval. */
  action: ProposalAction;
  status: ProposalStatus;
  decidedAt: string | null;
  result: ToolResult | null;
}

export function proposalsDir(): string {
  return path.join(argosRoot(), "state", "proposals");
}
function pendingDir(): string {
  return path.join(proposalsDir(), "pending");
}
function decidedDir(): string {
  return path.join(proposalsDir(), "decided");
}

async function ensureDirs(): Promise<void> {
  await fsp.mkdir(pendingDir(), { recursive: true });
  await fsp.mkdir(decidedDir(), { recursive: true });
}

export async function createProposal(input: {
  type: ProposalType;
  title: string;
  rationale: string;
  reasoning: Proposal["reasoning"];
  confidence: number | null;
  predictionClaimId: string | null;
  action: ProposalAction;
}): Promise<Proposal> {
  await ensureDirs();
  const p: Proposal = {
    id: `p_${randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
    status: "pending",
    decidedAt: null,
    result: null,
    ...input,
  };
  await fsp.writeFile(path.join(pendingDir(), `${p.id}.json`), JSON.stringify(p, null, 2), "utf8");
  await appendAudit("proposal.created", {
    proposalId: p.id,
    type: p.type,
    title: p.title,
    confidence: p.confidence,
    predictionClaimId: p.predictionClaimId,
    toolId: p.action.toolId,
  }).catch(() => {});
  return p;
}

async function readDir(dir: string): Promise<Proposal[]> {
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Proposal[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(dir, n), "utf8")) as Proposal);
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

export async function listProposals(): Promise<{ pending: Proposal[]; decided: Proposal[] }> {
  await ensureDirs();
  const [pending, decided] = await Promise.all([readDir(pendingDir()), readDir(decidedDir())]);
  return { pending, decided };
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const safe = id.replace(/[^a-zA-Z0-9._-]+/g, "");
  for (const dir of [pendingDir(), decidedDir()]) {
    const f = path.join(dir, `${safe}.json`);
    if (existsSync(f)) {
      try {
        return JSON.parse(await fsp.readFile(f, "utf8")) as Proposal;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Operator decision. Approve → the action executes NOW (runTool with
 *  approved=true — the operator's decision IS the approval) and the outcome
 *  is archived + audited. Reject → archived unrun + audited. Either way the
 *  proposal leaves pending/ atomically. */
export async function decideProposal(
  id: string,
  decision: "approve" | "reject"
): Promise<{ ok: boolean; proposal?: Proposal; error?: string }> {
  await ensureDirs();
  const safe = id.replace(/[^a-zA-Z0-9._-]+/g, "");
  const from = path.join(pendingDir(), `${safe}.json`);
  if (!existsSync(from)) return { ok: false, error: "proposal not pending (unknown id or already decided)" };
  let p: Proposal;
  try {
    p = JSON.parse(await fsp.readFile(from, "utf8")) as Proposal;
  } catch (e) {
    return { ok: false, error: `unreadable proposal: ${(e as Error).message}` };
  }

  if (decision === "reject") {
    p.status = "rejected";
    p.decidedAt = new Date().toISOString();
    await fsp.writeFile(path.join(decidedDir(), `${safe}.json`), JSON.stringify(p, null, 2), "utf8");
    await fsp.rm(from, { force: true });
    await appendAudit("proposal.rejected", { proposalId: p.id, type: p.type, title: p.title, toolId: p.action.toolId }).catch(() => {});
    return { ok: true, proposal: p };
  }

  // APPROVE — the single execution path for proposal actions.
  const result = await runTool(
    p.action.toolId,
    p.action.params,
    { sessionId: null, personaId: "bartimaeus", model: PERSONA_BY_ID.bartimaeus.model },
    /* approved: the operator just said yes */ true
  );
  p.status = result.ok ? "executed" : "failed";
  p.decidedAt = new Date().toISOString();
  p.result = result;
  await fsp.writeFile(path.join(decidedDir(), `${safe}.json`), JSON.stringify(p, null, 2), "utf8");
  await fsp.rm(from, { force: true });
  await appendAudit("proposal.applied", {
    proposalId: p.id,
    type: p.type,
    title: p.title,
    toolId: p.action.toolId,
    ok: result.ok,
    summary: result.summary?.slice(0, 300) ?? null,
  }).catch(() => {});
  return { ok: true, proposal: p };
}
