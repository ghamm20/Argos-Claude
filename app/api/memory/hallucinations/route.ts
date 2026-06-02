// app/api/memory/hallucinations/route.ts
//
// The flagged-fact log + pattern analysis (which categories/sessions/personas
// hallucinate most). Always 200.

import { NextResponse } from "next/server";
import { readHallucinations, hallucinationStats } from "@/lib/memory-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [items, stats] = await Promise.all([readHallucinations(), hallucinationStats()]);
    return NextResponse.json({ ok: true, items, stats });
  } catch (e) {
    return NextResponse.json({ ok: false, items: [], stats: null, error: String(e) }, { status: 200 });
  }
}
