// app/api/loops/status/route.ts
//
// Self-Evolving Loop Suite — GET the registry of 20 loops, the scheduler
// status, aggregate trace stats, plus the all-night signals: patches applied /
// rolled back today, the benchmark trend, pending operator questions, and the
// most recent backups. Always 200.

import { NextResponse } from "next/server";
import { loopSummaries } from "@/lib/loops/registry";
import { getLoopSchedulerStatus } from "@/lib/loops/scheduler";
import { traceStats, readTraces } from "@/lib/loops/trace-store";
import { patchCountsForDay } from "@/lib/loops/apply";
import { pendingQuestions } from "@/lib/loops/questions";
import { listLoopBackups } from "@/lib/loops/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [scheduler, stats, patchesToday, questions, backups, benchTraces] = await Promise.all([
      getLoopSchedulerStatus(),
      traceStats(),
      patchCountsForDay(),
      pendingQuestions(),
      listLoopBackups(10),
      readTraces("benchmark", 2),
    ]);

    // Benchmark trend: ↑ / ↓ / → from the last two benchmark runs.
    const cur = benchTraces[0]?.result?.benchmarkAfter ?? null;
    const prev = benchTraces[1]?.result?.benchmarkAfter ?? benchTraces[0]?.result?.benchmarkBefore ?? null;
    let trend: "up" | "down" | "flat" | "none" = "none";
    if (typeof cur === "number" && typeof prev === "number") {
      trend = cur > prev + 1e-9 ? "up" : cur < prev - 1e-9 ? "down" : "flat";
    }

    return NextResponse.json({
      ok: true,
      loops: loopSummaries(),
      scheduler,
      stats,
      patchesToday,
      benchmark: { latest: cur, previous: prev, trend },
      pendingQuestions: questions.length,
      recentBackups: backups.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, loops: [], scheduler: null, stats: null, error: String(e) },
      { status: 200 }
    );
  }
}
