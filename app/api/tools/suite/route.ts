// app/api/tools/suite/route.ts
//
// Tools Phase (2026-06-02) — status of all 18 governed tools for the Tools
// page: governance flags + execution count + last-used timestamp (from the
// append-only tool-audit log). Always 200.
//
// Distinct from /api/tools/status, which serves the HUD ToolsDock (external
// tool health checks via tools/registry.json).

import { NextResponse } from "next/server";
import { toolSummaries } from "@/lib/tools/registry";
import { toolStats } from "@/lib/tools/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const summaries = toolSummaries();
  let stats: Record<string, { count: number; lastAt: string | null; lastOk: boolean | null }> = {};
  try {
    stats = await toolStats();
  } catch {
    stats = {};
  }
  const tools = summaries.map((t) => ({
    ...t,
    executions: stats[t.id]?.count ?? 0,
    lastUsed: stats[t.id]?.lastAt ?? null,
    lastOk: stats[t.id]?.lastOk ?? null,
  }));
  return NextResponse.json({ ok: true, count: tools.length, tools });
}
