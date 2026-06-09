// app/api/tasks/route.ts
//
// Stage 2 (2026-06-09) — read surface for the task ledger. GET returns the
// current tasks (folded from state/tasks/ledger.jsonl) + counts, for the
// minimal task view, the night cycle (Stage 8), and the progression dashboard
// (Stage 6). Mutations go through the tasks TOOL (/api/tools/execute) so they
// are audited; this route is read-only.
//
//   GET /api/tasks?status=open|completed|cancelled|all  (default open)
//     → { tasks: Task[], counts: { open, completed, cancelled, overdue } }

import { NextRequest, NextResponse } from "next/server";
import { listTasks, taskCounts, type TaskStatus } from "@/lib/tasks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const statusParam = req.nextUrl.searchParams.get("status") ?? "open";
  const status = (["open", "completed", "cancelled", "all"].includes(statusParam)
    ? statusParam
    : "open") as TaskStatus | "all";
  const [tasks, counts] = await Promise.all([listTasks({ status }), taskCounts()]);
  return NextResponse.json({ tasks, counts, status });
}
