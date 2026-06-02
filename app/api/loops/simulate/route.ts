// app/api/loops/simulate/route.ts
//
// Self-Evolving Loop Suite — /simulate. POST { action } runs the World Model
// loop (predict outcomes + second-order effects + risk). Always 200.

import { NextRequest, NextResponse } from "next/server";
import { runLoopById } from "@/lib/loops/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = (body.action ?? "").trim();
    if (!action) return NextResponse.json({ ok: false, error: "action is required" }, { status: 200 });
    const run = await runLoopById("world_model", { action }, { trigger: "command" });
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
