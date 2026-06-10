// app/api/workflows/route.ts
//
// Phase 5 (2026-06-10) — workflow surface.
//
//   GET  → list all workflows (durable state files)
//   POST → create + run a workflow { title, steps: [{toolId, params,
//          description}] }. Runs synchronously to completion, HALT, or
//          failure; the response carries the final state. A chain
//          containing an approval-required step returns halted_approval —
//          decide via /api/workflows/decide.
//
// Gated by requireToolSession (Rule 8): this surface launches governed
// tools and is Tailscale-reachable.

import { NextRequest, NextResponse } from "next/server";
import { requireToolSession } from "@/lib/auth";
import { createWorkflow, advanceWorkflow, listWorkflows, type WorkflowStepSpec } from "@/lib/workflow/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireToolSession(req);
  if (auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, workflows: await listWorkflows() });
}

export async function POST(req: NextRequest) {
  const auth = await requireToolSession(req);
  if (auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: { title?: string; steps?: WorkflowStepSpec[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (steps.length < 1 || steps.length > 12) {
    return NextResponse.json({ error: "steps must be a non-empty array (max 12)" }, { status: 400 });
  }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s.toolId !== "string" || !s.toolId || typeof s.params !== "object" || s.params === null) {
      return NextResponse.json({ error: `steps[${i}] must have toolId + params` }, { status: 400 });
    }
  }
  const w = await createWorkflow(title, steps);
  const finished = await advanceWorkflow(w);
  return NextResponse.json({ ok: true, workflow: finished });
}
