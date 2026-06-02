// app/api/loops/benchmark/route.ts
//
// Self-Evolving Loop Suite — the ground-truth benchmark. POST runs it (records
// a trace with before/after). GET returns the latest benchmark trace + the
// task list. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { runLoopById } from "@/lib/loops/orchestrator";
import { readTraces } from "@/lib/loops/trace-store";
import { benchmarkTaskIds, scoreAnswers } from "@/lib/loops/benchmark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const latest = (await readTraces("benchmark", 1))[0] ?? null;
    return NextResponse.json({
      ok: true,
      taskIds: benchmarkTaskIds(),
      latest,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      model?: string;
      answers?: Record<string, string>;
    };
    // Pure grading mode: grade a supplied answer map deterministically (no
    // model, no network). This is the ground-truth grader exposed for testing
    // and for grading an external model's answers.
    if (body.answers && typeof body.answers === "object") {
      const graded = scoreAnswers(body.answers);
      return NextResponse.json({ ok: true, graded });
    }
    const run = await runLoopById("benchmark", body.model ? { model: body.model } : {});
    return NextResponse.json({
      ok: run?.result.ok ?? false,
      traceId: run?.traceId ?? null,
      outcome: run?.outcome ?? null,
      score: run?.result.benchmarkAfter ?? null,
      previous: run?.result.benchmarkBefore ?? null,
      improved: run?.evaluation.improved ?? false,
      gamingDetected: run?.evaluation.gamingDetected ?? false,
      result: run?.result ?? null,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
