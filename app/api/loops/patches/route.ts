// app/api/loops/patches/route.ts
//
// Self-Evolving Loop Suite — the patch ledger. GET returns every autonomous
// patch applied + every one auto-rolled-back over the last `?days` (default 7),
// most-recent first. This is the operator's morning "what did Bart change while
// I slept" view. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { readPatchRecords } from "@/lib/loops/apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const days = Math.max(1, Math.min(60, Number(req.nextUrl.searchParams.get("days") ?? 7) || 7));
    const [applied, rolledBack] = await Promise.all([
      readPatchRecords("APPLIED", days),
      readPatchRecords("FAILED", days),
    ]);
    const byAt = (a: { at?: string }, b: { at?: string }) => String(b.at).localeCompare(String(a.at));
    return NextResponse.json({
      ok: true,
      applied: (applied as Array<{ at?: string }>).sort(byAt),
      rolledBack: (rolledBack as Array<{ at?: string }>).sort(byAt),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, applied: [], rolledBack: [], error: String(e) }, { status: 200 });
  }
}
