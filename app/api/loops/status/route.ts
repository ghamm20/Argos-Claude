// app/api/loops/status/route.ts
//
// Self-Evolving Loop Suite — GET the registry of 20 loops, the scheduler
// status, and aggregate trace stats (for the loops page + HUD). Always 200.

import { NextResponse } from "next/server";
import { loopSummaries } from "@/lib/loops/registry";
import { getLoopSchedulerStatus } from "@/lib/loops/scheduler";
import { traceStats } from "@/lib/loops/trace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [scheduler, stats] = await Promise.all([
      getLoopSchedulerStatus(),
      traceStats(),
    ]);
    return NextResponse.json({
      ok: true,
      loops: loopSummaries(),
      scheduler,
      stats,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, loops: [], scheduler: null, stats: null, error: String(e) },
      { status: 200 }
    );
  }
}
