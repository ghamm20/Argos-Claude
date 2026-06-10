// app/api/tools/execute/route.ts
//
// Tools Phase (2026-06-02) — execute a tool through the governance layer.
//
//   POST { toolId, params, sessionId?, model? }
//     safe tool      → { ok, result }
//     dangerous tool → { approvalRequired:true, approvalId, toolId, toolName,
//                        description, risks, reversible }
//
// Never bypasses governance: requestTool() decides. Dangerous tools are NOT
// run here — they require POST /api/tools/approve after operator confirmation.
//
// Phase 1.5 (2026-06-10) — Rule 8 restoration: every POST must carry a valid
// operator session bearer OR the local runtime token (x-argos-runtime-token).
// Rejections are audit-logged (event:"auth_denied"). 7799 is Tailscale-
// reachable; this endpoint is not loopback-only.

import { NextRequest, NextResponse } from "next/server";
import { requestTool } from "@/lib/tools/executor";
import { requireToolSession } from "@/lib/auth";
import { appendToolAudit } from "@/lib/tools/audit";
import { PERSONA_BY_ID } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Read the raw body up front so a denied request can still be audited with
  // its claimed toolId/sessionId (body is single-read on NextRequest).
  const raw = await req.text();
  let body: {
    toolId?: string;
    params?: Record<string, unknown>;
    sessionId?: string | null;
    model?: string;
    personaId?: string;
  } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  const auth = await requireToolSession(req);
  if (auth) {
    await appendToolAudit({
      at: new Date().toISOString(),
      toolId: typeof body?.toolId === "string" && body.toolId ? body.toolId : "(unparsed)",
      approved: null,
      ok: false,
      summary:
        "ACCESS DENIED — un-sessioned POST /api/tools/execute rejected (Rule 8 gate: no valid operator session or runtime token)",
      error: "unauthorized",
      restorePointId: null,
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : null,
      persona: typeof body?.personaId === "string" ? body.personaId : null,
      durationMs: 0,
      event: "auth_denied",
    });
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const toolId = typeof body.toolId === "string" ? body.toolId : "";
  if (!toolId) return NextResponse.json({ error: "toolId is required" }, { status: 400 });
  const params =
    body.params && typeof body.params === "object" ? body.params : {};

  const outcome = await requestTool(toolId, params, {
    sessionId: body.sessionId ?? null,
    personaId: body.personaId ?? "bartimaeus",
    model: body.model || PERSONA_BY_ID.bartimaeus.model,
  });

  if (outcome.kind === "approval") {
    return NextResponse.json({
      approvalRequired: true,
      approvalId: outcome.approvalId,
      toolId: outcome.toolId,
      toolName: outcome.toolName,
      description: outcome.description,
      risks: outcome.risks,
      reversible: outcome.reversible,
    });
  }
  return NextResponse.json({ ok: outcome.result.ok, result: outcome.result });
}
