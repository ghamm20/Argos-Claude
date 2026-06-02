// app/api/tools/list/route.ts
//
// Web Capability TIER 3 (2026-06-02) — the full tool roster for the Tool
// Sources discovery page. Static summaries (no execute fns). Always 200.

import { NextResponse } from "next/server";
import { toolSummaries } from "@/lib/tools/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tools = toolSummaries();
  return NextResponse.json({ ok: true, count: tools.length, tools });
}
