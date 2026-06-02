// app/api/loops/debate/route.ts
//
// Self-Evolving Loop Suite — /debate. POST { topic } runs the Multi-Agent
// Debate loop (Bobby/Juniper/Sage argue, Bartimaeus judges). Always 200.

import { NextRequest, NextResponse } from "next/server";
import { runLoopById } from "@/lib/loops/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { topic?: string };
    const topic = (body.topic ?? "").trim();
    if (!topic) return NextResponse.json({ ok: false, error: "topic is required" }, { status: 200 });
    const run = await runLoopById("multi_agent_debate", { topic }, { trigger: "command" });
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
