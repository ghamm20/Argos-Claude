// app/api/loops/redteam/route.ts
//
// Self-Evolving Loop Suite — on-demand red/blue exercise. POST { target } runs
// the Red/Blue Team loop (Juniper red, Sage blue, Bartimaeus judge), writes a
// dated report, and pages the operator on a critical finding. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { runLoopById } from "@/lib/loops/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { target?: string; topic?: string };
    const target = (body.target ?? body.topic ?? "").trim();
    const run = await runLoopById(
      "red_blue_team",
      target ? { target } : {},
      { trigger: "command" }
    );
    return NextResponse.json({
      ok: run?.result.ok ?? false,
      traceId: run?.traceId ?? null,
      outcome: run?.outcome ?? null,
      data: run?.result.data ?? null,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
