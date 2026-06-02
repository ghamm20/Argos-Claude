// app/api/tasks/create/route.ts
//
// Overnight Engine — POST a new task into the queue. Validated + normalized by
// enqueueTask. The scheduler picks it up on the next tick.

import { NextRequest, NextResponse } from "next/server";
import { enqueueTask } from "@/lib/task-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const r = await enqueueTask(body);
  if (!r.ok) {
    return NextResponse.json({ error: r.error ?? "invalid task" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, task: r.task });
}
