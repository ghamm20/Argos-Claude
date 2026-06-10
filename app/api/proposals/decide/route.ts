// app/api/proposals/decide/route.ts
//
// Phase 4 (2026-06-10) — operator decision on a proposal.
//
//   POST { proposalId, decision: "approve" | "reject" }
//
// Approve → the proposal's action executes NOW (the decision IS the
// approval) and is audited as proposal.applied. Reject → archived unrun,
// audited as proposal.rejected. This route is the ONLY execution path for
// proposal actions — gated by requireToolSession (Rule 8), same posture as
// /api/tools/approve.

import { NextRequest, NextResponse } from "next/server";
import { requireToolSession } from "@/lib/auth";
import { decideProposal } from "@/lib/proposer/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireToolSession(req);
  if (auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: { proposalId?: string; decision?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
  if (!proposalId) return NextResponse.json({ error: "proposalId is required" }, { status: 400 });
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) return NextResponse.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 });
  const out = await decideProposal(proposalId, decision);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 404 });
  return NextResponse.json({ ok: true, proposal: out.proposal });
}
