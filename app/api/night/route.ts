// app/api/night/route.ts
//
// Stage 8 (2026-06-09) — manually trigger the night cycle (operator / proofs).
// The scheduler runs it once-per-day via the heartbeat; this lets it be run on
// demand in daytime. POST { skipIntegrity？ } → NightCycleReport.

import { NextRequest, NextResponse } from "next/server";
import { runNightCycle } from "@/lib/night/cycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { skipIntegrity?: boolean } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty ok */ }
  const report = await runNightCycle({ skipIntegrity: body.skipIntegrity === true });
  return NextResponse.json(report);
}
