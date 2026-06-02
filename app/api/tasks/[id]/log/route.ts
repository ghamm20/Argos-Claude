// app/api/tasks/[id]/log/route.ts
//
// Overnight Engine — GET a task's run log (state/task-runner-<id>.log).

import { NextRequest, NextResponse } from "next/server";
import { promises as fsp } from "node:fs";
import { runnerLogPath } from "@/lib/task-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = params.id;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const log = await fsp.readFile(runnerLogPath(id), "utf8");
    return NextResponse.json({ ok: true, id, log });
  } catch {
    return NextResponse.json({ ok: true, id, log: "", note: "no log yet" });
  }
}
