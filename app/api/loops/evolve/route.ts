// app/api/loops/evolve/route.ts
//
// Self-Evolving Loop Suite — generic loop runner. POST { loop, input } runs any
// loop by id through the orchestrator (eval gate + trace). Used by the loops
// page "run" buttons and by /refine /evolve etc. Always 200 with a clear error
// when the loop id is unknown.

import { NextRequest, NextResponse } from "next/server";
import { runLoopById } from "@/lib/loops/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      loop?: string;
      input?: Record<string, unknown>;
    };
    const loop = (body.loop ?? "").trim();
    if (!loop) {
      return NextResponse.json({ ok: false, error: "loop id is required" }, { status: 200 });
    }
    const run = await runLoopById(loop, body.input ?? {});
    if (!run) {
      return NextResponse.json({ ok: false, error: `unknown loop: ${loop}` }, { status: 200 });
    }
    return NextResponse.json({
      ok: true,
      loop,
      outcome: run.outcome,
      traceId: run.traceId,
      result: run.result,
      evaluation: run.evaluation,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
