// app/api/tools/approve/route.ts
//
// Tools Phase (2026-06-02) — operator confirmation for a pending dangerous
// tool. On approve, the tool runs (restore point first if required) and the
// result is returned. On deny/expire, the non-execution is audited.
//
//   POST { approvalId, decision: "approve" | "deny" }
//     → { status, result }
//
// Phase 1.5 (2026-06-10) — Rule 8 restoration: every POST must carry a valid
// operator session bearer OR the local runtime token (x-argos-runtime-token).
// Rejections are audit-logged (event:"auth_denied"). This is the endpoint
// that RELEASES dangerous tools — it must never be open to a Tailscale peer.

import { NextRequest, NextResponse } from "next/server";
import { approveAndRun } from "@/lib/tools/executor";
import { requireToolSession } from "@/lib/auth";
import { appendToolAudit } from "@/lib/tools/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  let body: { approvalId?: string; decision?: string } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  const auth = await requireToolSession(req);
  if (auth) {
    const claimedId =
      typeof body?.approvalId === "string" && body.approvalId
        ? body.approvalId
        : "(none)";
    await appendToolAudit({
      at: new Date().toISOString(),
      toolId: "(tools/approve)",
      approved: null,
      ok: false,
      summary: `ACCESS DENIED — un-sessioned POST /api/tools/approve rejected (Rule 8 gate; approvalId=${claimedId})`,
      error: "unauthorized",
      restorePointId: null,
      sessionId: null,
      persona: null,
      durationMs: 0,
      event: "auth_denied",
    });
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
  const decision = body.decision === "approve" ? "approve" : "deny";
  if (!approvalId) {
    return NextResponse.json({ error: "approvalId is required" }, { status: 400 });
  }
  const out = await approveAndRun(approvalId, decision);
  return NextResponse.json({ status: out.status, result: out.result });
}
