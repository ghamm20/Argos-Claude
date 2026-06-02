// app/api/tasks/queue/route.ts
//
// Overnight Engine — GET the full task listing grouped by status, plus the
// scheduler status (for the HUD). Always 200.

import { NextResponse } from "next/server";
import { listAll } from "@/lib/task-queue";
import { getTaskSchedulerStatus, pumpTaskQueue } from "@/lib/task-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [listing, scheduler] = await Promise.all([listAll(), getTaskSchedulerStatus()]);
    return NextResponse.json({ ok: true, ...listing, scheduler });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        queued: [],
        running: [],
        complete: [],
        failed: [],
        runningId: null,
        completedToday: 0,
        error: String(e),
      },
      { status: 200 }
    );
  }
}

/** Run the queue now — pumps one task to completion. Used by the operator
 *  "run now" action and the smoke. Awaits the run, then returns the listing. */
export async function POST() {
  await pumpTaskQueue();
  const [listing, scheduler] = await Promise.all([listAll(), getTaskSchedulerStatus()]);
  return NextResponse.json({ ok: true, pumped: true, ...listing, scheduler });
}
