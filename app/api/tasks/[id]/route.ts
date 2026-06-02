// app/api/tasks/[id]/route.ts
//
// Overnight Engine — DELETE a QUEUED task (cancel). Running/complete/failed
// tasks cannot be deleted — the archive is append-only.

import { NextRequest, NextResponse } from "next/server";
import { cancelTask } from "@/lib/task-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = params.id;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const r = await cancelTask(id);
  return NextResponse.json({ ok: r.ok, reason: r.reason }, { status: r.ok ? 200 : 409 });
}
