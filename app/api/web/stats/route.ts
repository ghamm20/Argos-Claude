// app/api/web/stats/route.ts
//
// Web Capability TIER 0 (2026-06-02) — web infrastructure status for the Tools
// / Loops surfaces and the HUD WEB CALLS row. Cache stats + audit aggregates +
// rate-bucket levels. Always 200.

import { NextResponse } from "next/server";
import { cacheStats } from "@/lib/web/cache";
import { rateStatus } from "@/lib/web/rate-limiter";
import { queryAudit } from "@/lib/web/audit";
import { integrityViolationCount } from "@/lib/integrity-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [cache, rate, audit, integrityViolations] = await Promise.all([
      cacheStats(),
      rateStatus(),
      queryAudit({ limit: 50 }),
      integrityViolationCount(),
    ]);
    // integrityViolations surfaces as the HUD "INTEGRITY VIOLATIONS" counter
    // (v2.3.8 doctrine) — a doctrine breach is operator-critical, shown on Web.
    return NextResponse.json({ ok: true, cache, rate, audit, integrityViolations });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
