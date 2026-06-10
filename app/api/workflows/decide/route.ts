// app/api/workflows/decide/route.ts
//
// Phase 5 (2026-06-10) — operator decision on a HALTED workflow.
//
//   POST { workflowId, decision: "approve" | "reject" }
//
// Approve → the halted step executes (the engine's ONLY approved=true
// path) and the chain continues — possibly halting again at a later
// gated step. Reject → clean abort; remaining steps never run.
// requireToolSession-gated (Rule 8), same posture as /api/tools/approve.

import { NextRequest, NextResponse } from "next/server";
import { requireToolSession } from "@/lib/auth";
import { decideWorkflow } from "@/lib/workflow/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireToolSession(req);
  if (auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: { workflowId?: string; decision?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
  if (!workflowId) return NextResponse.json({ error: "workflowId is required" }, { status: 400 });
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) return NextResponse.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 });
  const out = await decideWorkflow(workflowId, decision);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 404 });
  return NextResponse.json({ ok: true, workflow: out.workflow });
}
