// app/api/tools/parse-test/route.ts
//
// Diagnostic (v2.3.8) — exposes the tool-call PARSER and the model-integrity
// guard so both can be exercised deterministically (the validation scripts),
// without depending on what a model happens to emit. Read-only by default;
// `logAudit:true` runs the real parse-failure audit helper, and
// `logViolation:true` runs the real integrity-violation logger — so the audit /
// violation wiring is verified end to end with the SAME code the chat route uses.
//
//   POST { text, toolRan?, hadGrounding?, explicitToolRequest?, toolResults?,
//          logAudit?, logViolation? }
//     → { calls, failures, claimsToolUse, verdict, wouldWarn, audited,
//         violationLogged, integrityViolations, misrepresentation }
//
// v2.3.9 — `toolResults` (the negative/empty tool returns in context) drives the
// misrepresentation guard deterministically: a response that frames a completed
// negative result as pending → { misrepresentation.violation: true }.

import { NextRequest, NextResponse } from "next/server";
import { parseToolCalls } from "@/lib/tools/chat-tools";
import { appendParseFailureAudit } from "@/lib/tools/audit";
import { toolSummaries } from "@/lib/tools/registry";
import {
  claimsToolUse,
  evaluateIntegrity,
  inferMissingTool,
  hasMalformedToolTag,
  type ToolResultLike,
  isNegativeStateResult,
  detectMisrepresentation,
} from "@/lib/tool-integrity";
import { appendIntegrityViolation, integrityViolationCount } from "@/lib/integrity-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_TOOL_IDS = toolSummaries().map((t) => t.id);

export async function POST(req: NextRequest) {
  let body: { text?: string; toolRan?: boolean; hadGrounding?: boolean; explicitToolRequest?: boolean; attemptedToolButFailed?: boolean; toolResults?: ToolResultLike[]; logAudit?: boolean; logViolation?: boolean };
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
    // v2.3.11 — derive like the route does: a parser-flagged failure OR a
    // `<tool_id …>` malformed tag (which the parser skips) is a failed attempt.
    attemptedToolButFailed:
      body.attemptedToolButFailed === true ||
      failures.length > 0 ||
      hasMalformedToolTag(text, KNOWN_TOOL_IDS),
  });

  // v2.3.9 — misrepresentation guard (Layer 2c). Deterministic over the
  // supplied toolResults: which are negative-state, and does `text` soften a
  // completed negative as pending?
  const toolResults: ToolResultLike[] = Array.isArray(body.toolResults) ? body.toolResults : [];
  const negatives = toolResults.filter(isNegativeStateResult);
  const misrep = detectMisrepresentation(text, negatives);

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
      type: "fabrication",
      persona: "diagnostic",
      patterns: verdict.patterns,
      missingTool: inferMissingTool(text, KNOWN_TOOL_IDS),
      content: text,
    });
    violationLogged = true;
  }
  // v2.3.9 — when asked to log AND a misrepresentation fired, record it too
  // (type-tagged), exercising the same logger the chat route uses.
  let misrepLogged = false;
  if (body.logViolation && misrep.violation && misrep.summary) {
    await appendIntegrityViolation({
      type: "misrepresentation",
      persona: "diagnostic",
      patterns: [`framed completed tool call as pending; actual result: ${misrep.summary}`],
      missingTool: misrep.toolId,
      content: text,
    });
    misrepLogged = true;
  }

  return NextResponse.json({
    calls,
    failures,
    claimsToolUse: claimsToolUse(text),
    verdict,
    wouldWarn: verdict.violation,
    audited,
    violationLogged,
    // v2.3.9 misrepresentation guard surface
    misrepresentation: {
      negativeCount: negatives.length,
      violation: misrep.violation,
      summary: misrep.summary,
      toolId: misrep.toolId,
      logged: misrepLogged,
    },
    integrityViolations: await integrityViolationCount(),
  });
}
