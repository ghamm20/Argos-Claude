// app/api/audit/count/route.ts
//
// v1.1 — lightweight chain entry count for HUD polling. Uses the
// tail-cache pattern from lib/audit.ts; common case is one stat
// call. Safe to poll every few seconds.
//
//   GET /api/audit/count  →  { count: N }

import { NextResponse } from "next/server";
import { getChainCount } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const count = await getChainCount();
    return NextResponse.json({ count });
  } catch (e) {
    return NextResponse.json(
      {
        count: 0,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 200 } // 200 with error field — HUD shouldn't blow up
    );
  }
}
