// app/api/loops/apply/route.ts
//
// Self-Evolving Loop Suite — the governed manual-apply surface for the
// autonomous pipeline. POST { target, content, test } writes a whole file
// behind a backup + test, keeping it only if the test is green and rolling it
// back otherwise. Same pipeline the autonomous loops use (lib/loops/apply.ts).
//
// Safety: the rsi-gate refuses governance code (unless ARGOS_RSI_ALLOW_GOVERNANCE)
// and anything outside ARGOS_ROOT. The HTTP body may NOT specify an arbitrary
// shell command as the test — only "none" (always pass), "reject" (always fail,
// to verify the rollback path), or "typecheck" (the project's tsc gate). This
// keeps the endpoint from being a command-execution surface. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { applyWithBackupTest, type ApplyTest } from "@/lib/loops/apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveTest(kind: string | undefined): ApplyTest {
  switch ((kind ?? "none").toLowerCase()) {
    case "reject":
      // Documented affordance: always-fail test to verify auto-rollback.
      return { kind: "fn", run: async () => false };
    case "typecheck":
      return { kind: "command", argv: ["npm", "run", "typecheck"], shell: true, timeoutMs: 180_000 };
    case "none":
    default:
      return { kind: "none" };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      target?: string;
      content?: string;
      reason?: string;
      test?: string;
    };
    const target = (body.target ?? "").trim();
    if (!target || typeof body.content !== "string") {
      return NextResponse.json({ ok: false, error: "target and content are required" }, { status: 200 });
    }
    const result = await applyWithBackupTest({
      loopId: "manual",
      reason: body.reason?.slice(0, 300) || "operator manual apply",
      files: [{ target, content: body.content }],
      test: resolveTest(body.test),
    });
    return NextResponse.json({ ok: result.applied, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
