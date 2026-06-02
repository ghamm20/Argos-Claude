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

import { NextRequest, NextResponse } from "next/server";
import { requestTool } from "@/lib/tools/executor";
import { PERSONA_BY_ID } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: {
    toolId?: string;
    params?: Record<string, unknown>;
    sessionId?: string | null;
    model?: string;
    personaId?: string;
  };
  try {
    body = await req.json();
  } catch {
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
