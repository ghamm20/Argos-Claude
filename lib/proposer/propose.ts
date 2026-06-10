// lib/proposer/propose.ts
//
// Phase 4 (2026-06-10) — PROPOSAL GENERATION. Two sources, both audited:
//
//   1. THE PRE-FETCH HOOK — fires ONLY for predictions with probability
//      STRICTLY > 0.70 (owner doctrine). A firing prediction becomes a
//      PROPOSAL in the queue — never an execution. Note: predictions are
//      class-level (the observation corpus stores no content by design),
//      so pre-fetch actions are class-shaped; workspace scans below supply
//      the concrete-content proposals.
//   2. WORKSPACE CONTEXT — deterministic scans of the real workspace
//      (stray temp files, fresh overnight results without a digest) emit
//      concrete proposals tagged reasoning:["workspace_context"].
//
// ZERO AUTONOMOUS EXECUTION: this module only CREATES proposals
// (lib/proposer/store.ts createProposal). The only execution path for a
// proposal's action is the operator-approve path in store.decideProposal.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import { predictNextAsks, scorePredictions, type PredictedAsk, type Calibration, type PredictOptions } from "./predict";
import { createProposal, listProposals, type Proposal, type ProposalType } from "./store";

/** The owner-doctrine pre-fetch gate: STRICTLY greater than 70%. */
export const PREFETCH_CONFIDENCE_THRESHOLD = 0.7;

function prefetchProposalInput(pred: PredictedAsk): {
  type: ProposalType;
  title: string;
  rationale: string;
  action: { toolId: string; params: Record<string, unknown> };
} | null {
  const base = `Predicted next ask class=${pred.topicClass}/${pred.queryType} at p=${pred.probability.toFixed(2)} — ${pred.rationale} [claim:${pred.claimId}]`;
  switch (pred.topicClass) {
    case "research_web":
      return {
        type: "research_brief",
        title: `Pre-fetch research for a predicted ${pred.queryType}`,
        rationale: base,
        action: { toolId: "web_search", params: { query: "current updates relevant to the operator's recurring research thread (local-first AI workstation operations)", limit: 5 } },
      };
    case "schedule_tasks":
      return {
        type: "task_queue",
        title: "Queue an overnight task for a predicted scheduling ask",
        rationale: base,
        action: {
          toolId: "file_ops",
          params: {
            operation: "write",
            path: `tasks/queue/proposed-${Date.now()}.json`,
            content: JSON.stringify({ goal: "Proposed (Phase 4 pre-fetch): overnight research sweep matching the operator's predicted scheduling need", steps: ["web_search"], priority: "low", notify_on: "error" }, null, 2),
          },
        },
      };
    default:
      return {
        type: "draft_document",
        title: `Pre-stage a brief for a predicted ${pred.topicClass} ask`,
        rationale: base,
        action: {
          toolId: "doc_generate",
          params: { title: `Pre-staged brief — ${pred.topicClass}`, content: `Prepared ahead of a predicted operator ask.\n\n${base}`, format: "md" },
        },
      };
  }
}

/** Deterministic scans of the REAL workspace. Each finding becomes a
 *  concrete proposal; nothing is touched — proposals only. */
async function workspaceProposalInputs(): Promise<Array<Parameters<typeof createProposal>[0]>> {
  const out: Array<Parameters<typeof createProposal>[0]> = [];
  const root = argosRoot();

  // 1. Stray temp files in workspace/ → file_op cleanup proposal (delete is
  //    the highest-governance op: restore point + the operator's approval).
  try {
    const ws = await fsp.readdir(path.join(root, "workspace"));
    const stray = ws.filter((n) => /\.(tmp|bak)$/i.test(n));
    if (stray.length > 0) {
      out.push({
        type: "file_op",
        title: `Clean up ${stray.length} stray temp file(s) in workspace/`,
        rationale: `workspace scan found: ${stray.slice(0, 5).join(", ")} — proposing deletion (restore point taken on approval)`,
        reasoning: ["workspace_context"],
        confidence: null,
        predictionClaimId: null,
        action: { toolId: "file_ops", params: { operation: "delete", path: `workspace/${stray[0]}` } },
      });
    }
  } catch {
    /* no workspace dir — nothing to propose */
  }

  // 2. Fresh overnight results with no digest in output/ → draft_document.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const completeDir = path.join(root, "tasks", "complete");
    const results = (await fsp.readdir(completeDir)).filter((n) => n.endsWith("-result.json"));
    const fresh: string[] = [];
    for (const n of results) {
      try {
        const r = JSON.parse(await fsp.readFile(path.join(completeDir, n), "utf8")) as { completedAt?: string };
        if ((r.completedAt ?? "").slice(0, 10) === today) fresh.push(n);
      } catch {
        /* skip */
      }
    }
    let digestExists = false;
    try {
      digestExists = (await fsp.readdir(path.join(root, "output"))).some((n) => n === `overnight-digest-${today}.md`);
    } catch {
      /* no output dir */
    }
    if (fresh.length > 0 && !digestExists) {
      out.push({
        type: "draft_document",
        title: `Draft the overnight results digest for ${today}`,
        rationale: `workspace scan: ${fresh.length} task result(s) completed today with no digest in output/ — proposing a digest doc (${fresh.slice(0, 4).join(", ")})`,
        reasoning: ["workspace_context"],
        confidence: null,
        predictionClaimId: null,
        action: {
          toolId: "doc_generate",
          params: { title: `overnight-digest-${today}`, content: `Digest of overnight task results for ${today}:\n\n${fresh.map((f) => `- tasks/complete/${f}`).join("\n")}`, format: "md" },
        },
      });
    }
  } catch {
    /* no tasks dirs — nothing to propose */
  }

  return out;
}

export interface GenerateResult {
  calibration: Calibration;
  predictions: PredictedAsk[];
  created: Proposal[];
  skippedBelowThreshold: number;
}

/** The Phase 4 entry point: score pending predictions (Brier), plan ahead
 *  (ReWOO top-3), fire the >70% pre-fetch hook as PROPOSALS, add
 *  workspace-context proposals. Read-only on the observation corpus. */
export async function generateProposals(opts: PredictOptions = {}): Promise<GenerateResult> {
  const calibration = await scorePredictions();
  const predictions = await predictNextAsks(opts);
  const created: Proposal[] = [];
  let skippedBelowThreshold = 0;

  // Dedupe guard: don't stack identical pending proposals across runs.
  const { pending } = await listProposals();
  const pendingTitles = new Set(pending.map((p) => p.title));

  for (const pred of predictions) {
    if (pred.probability <= PREFETCH_CONFIDENCE_THRESHOLD) {
      skippedBelowThreshold++;
      continue; // the hook fires ONLY above 70% — doctrine line, not a tunable
    }
    const input = prefetchProposalInput(pred);
    if (!input || pendingTitles.has(input.title)) continue;
    created.push(
      await createProposal({
        ...input,
        reasoning: pred.reasoning,
        confidence: pred.probability,
        predictionClaimId: pred.claimId,
        predictedAsk: { topicClass: pred.topicClass, queryType: pred.queryType },
      })
    );
    pendingTitles.add(input.title);
  }

  for (const w of await workspaceProposalInputs()) {
    if (pendingTitles.has(w.title)) continue;
    created.push(await createProposal(w));
    pendingTitles.add(w.title);
  }

  return { calibration, predictions, created, skippedBelowThreshold };
}
