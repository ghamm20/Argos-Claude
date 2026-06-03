// app/api/tools/parse-test/route.ts
//
// Diagnostic (v2.3.8) — exposes the tool-call PARSER and the model-integrity
// guard so they can be exercised deterministically (smoke-tool-integrity.mjs),
// without depending on what a model happens to emit. Read-only by default;
// `logAudit:true` runs the SAME parse-failure audit helper the chat route uses
// so the audit wiring can be verified end to end.
//
//   POST { text, toolRan?, logAudit? }
//     → { calls, failures, claimsToolUse, wouldWarn, audited }

import { NextRequest, NextResponse } from "next/server";
import { parseToolCalls } from "@/lib/tools/chat-tools";
import { appendParseFailureAudit } from "@/lib/tools/audit";
import { claimsToolUse, shouldFlagFabricatedToolUse } from "@/lib/tool-integrity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { text?: string; toolRan?: boolean; logAudit?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text : "";
  const { calls, failures } = parseToolCalls(text);
  const toolRan = body.toolRan === true;

  let audited = 0;
  if (body.logAudit) {
    for (const f of failures) {
      await appendParseFailureAudit({
        raw: f.raw,
        reason: f.reason,
        toolId: f.toolId,
        sessionId: "parse-test",
        persona: "diagnostic",
      });
      audited++;
    }
  }

  return NextResponse.json({
    calls,
    failures,
    claimsToolUse: claimsToolUse(text),
    wouldWarn: shouldFlagFabricatedToolUse(text, toolRan),
    audited,
  });
}
