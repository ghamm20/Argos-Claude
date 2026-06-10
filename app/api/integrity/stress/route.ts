// app/api/integrity/stress/route.ts
//
// Stage 5 / v2.4.3 — run the adversarial integrity corpus through the real
// guards and append the result to state/integrity-metrics.jsonl. POST so it's
// an explicit action (the scheduler calls runStress() in-process directly).
//
//   POST { commit?: string } → full StressReport (per-case + findings)

import { NextRequest, NextResponse } from "next/server";
import { runStress } from "@/lib/integrity/stress";
import { getRuntimeInfo } from "@/lib/runtime-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { commit?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }
  const commit = body.commit?.trim() || `v${(await getRuntimeInfo()).version}`;
  const report = await runStress(commit, new Date().toISOString());
  return NextResponse.json(report);
}
