// app/api/loops/traces/route.ts
//
// Self-Evolving Loop Suite — GET loop traces (append-only history). Optional
// ?loop=<id> for one loop, ?limit=N. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { readAllTraces, readTraces } from "@/lib/loops/trace-store";
import { getLoop } from "@/lib/loops/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const loop = req.nextUrl.searchParams.get("loop");
    const limit = Math.max(1, Math.min(500, Number(req.nextUrl.searchParams.get("limit") ?? 100) || 100));
    if (loop) {
      if (!getLoop(loop)) {
        return NextResponse.json({ ok: false, traces: [], error: `unknown loop: ${loop}` }, { status: 200 });
      }
      const traces = await readTraces(loop as Parameters<typeof readTraces>[0], limit);
      return NextResponse.json({ ok: true, loop, traces });
    }
    const traces = await readAllTraces(limit);
    return NextResponse.json({ ok: true, traces });
  } catch (e) {
    return NextResponse.json({ ok: false, traces: [], error: String(e) }, { status: 200 });
  }
}
