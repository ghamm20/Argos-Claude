// app/api/loops/refine/route.ts
//
// Self-Evolving Loop Suite — /refine. POST { text, iterations? } runs the
// Self-Refine loop (critique → rewrite, up to 3 passes). Always 200.

import { NextRequest, NextResponse } from "next/server";
import { runLoopById } from "@/lib/loops/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { text?: string; iterations?: number };
    const text = (body.text ?? "").trim();
    if (!text) return NextResponse.json({ ok: false, error: "text is required" }, { status: 200 });
    const run = await runLoopById(
      "self_refine",
      { text, iterations: body.iterations ?? 1 },
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
