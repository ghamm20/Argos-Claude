// app/api/tools/approve/route.ts
//
// Tools Phase (2026-06-02) — operator confirmation for a pending dangerous
// tool. On approve, the tool runs (restore point first if required) and the
// result is returned. On deny/expire, the non-execution is audited.
//
//   POST { approvalId, decision: "approve" | "deny" }
//     → { status, result }

import { NextRequest, NextResponse } from "next/server";
import { approveAndRun } from "@/lib/tools/executor";
import { requireValidSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { approvalId?: string; decision?: string };
  try {
    body = await req.json();
  } catch {
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
