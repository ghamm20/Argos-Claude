// app/api/integrity/metrics/route.ts
//
// Stage 5 / v2.4.3 — rolling integrity metrics (catch / miss / false-positive
// rate, per-guard, 7-day trend) computed from state/integrity-metrics.jsonl.
// Read-only; drives the HUD integrity block (which replaces the raw violation
// count). GET.

import { NextResponse } from "next/server";
import { computeRollingMetrics } from "@/lib/integrity/stress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await computeRollingMetrics());
}
