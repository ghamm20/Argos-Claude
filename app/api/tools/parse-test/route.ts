// app/api/tools/parse-test/route.ts
//
// Diagnostic (v2.3.8) — exposes the tool-call PARSER and the model-integrity
// guard so both can be exercised deterministically (the validation scripts),
// without depending on what a model happens to emit. Read-only by default;
// `logAudit:true` runs the real parse-failure audit helper, and
// `logViolation:true` runs the real integrity-violation logger — so the audit /
// violation wiring is verified end to end with the SAME code the chat route uses.
//
//   POST { text, toolRan?, hadGrounding?, logAudit?, logViolation? }
//     → { calls, failures, claimsToolUse, verdict, wouldWarn, audited,
//         violationLogged, integrityViolations }

import { NextRequest, NextResponse } from "next/server";
import { parseToolCalls } from "@/lib/tools/chat-tools";
import { appendParseFailureAudit } from "@/lib/tools/audit";
import { toolSummaries } from "@/lib/tools/registry";
import { claimsToolUse, evaluateIntegrity, inferMissingTool } from "@/lib/tool-integrity";
import { appendIntegrityViolation, integrityViolationCount } from "@/lib/integrity-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_TOOL_IDS = toolSummaries().map((t) => t.id);

export async function POST(req: NextRequest) {
  let body: { text?: string; toolRan?: boolean; hadGrounding?: boolean; explicitToolRequest?: boolean; logAudit?: boolean; logViolation?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text : "";
  const { calls, failures } = parseToolCalls(text);
  const verdict = evaluateIntegrity(text, {
    toolRan: body.toolRan === true,
    hadGrounding: body.hadGrounding === true,
    explicitToolRequest: body.explicitToolRequest === true,
  });

  let audited = 0;
  if (body.logAudit) {
    for (const f of failures) {
      await appendParseFailureAudit({ raw: f.raw, reason: f.reason, toolId: f.toolId, sessionId: "parse-test", persona: "diagnostic" });
      audited++;
    }
  }

  let violationLogged = false;
  if (body.logViolation && verdict.violation) {
    await appendIntegrityViolation({
      persona: "diagnostic",
      patterns: verdict.patterns,
      missingTool: inferMissingTool(text, KNOWN_TOOL_IDS),
      content: text,
    });
    violationLogged = true;
  }

  return NextResponse.json({
    calls,
    failures,
    claimsToolUse: claimsToolUse(text),
    verdict,
    wouldWarn: verdict.violation,
    audited,
    violationLogged,
    integrityViolations: await integrityViolationCount(),
  });
}
