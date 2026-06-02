// app/api/loops/evaluate/route.ts
//
// Self-Evolving Loop Suite — gate inspection. POST { result } runs a raw
// LoopResult through the eval gate (with the REAL known-refs set) and returns
// the verdict WITHOUT applying anything. This is how the gate's anti-gaming
// behavior is exercised + tested over HTTP. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { evaluateResult } from "@/lib/loops/eval-gate";
import { benchmarkTaskIds } from "@/lib/loops/benchmark";
import { collectTraceRefs } from "@/lib/loops/trace-store";
import type { LoopResult } from "@/lib/loops/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Coerce an arbitrary body into a complete LoopResult (defensive defaults). */
function coerce(r: Record<string, unknown>): LoopResult {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    loopId: (r.loopId as LoopResult["loopId"]) ?? "reflexion",
    loopNumber: typeof r.loopNumber === "number" ? r.loopNumber : 0,
    ok: r.ok !== false,
    summary: typeof r.summary === "string" ? r.summary : "",
    claimedImprovement: r.claimedImprovement === true,
    claimedScore: num(r.claimedScore),
    benchmarkBefore: num(r.benchmarkBefore),
    benchmarkAfter: num(r.benchmarkAfter),
    evidence: Array.isArray(r.evidence) ? (r.evidence as LoopResult["evidence"]) : [],
    proposals: Array.isArray(r.proposals) ? (r.proposals as LoopResult["proposals"]) : [],
    data: r.data ?? null,
    error: typeof r.error === "string" ? r.error : null,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { result?: Record<string, unknown> };
    if (!body.result || typeof body.result !== "object") {
      return NextResponse.json({ ok: false, error: "result object is required" }, { status: 200 });
    }
    const refs = new Set<string>(benchmarkTaskIds());
    try {
      for (const r of await collectTraceRefs()) refs.add(r);
    } catch {
      /* benchmark ids alone are enough */
    }
    const evaluation = evaluateResult(coerce(body.result), { knownRefs: refs });
    return NextResponse.json({ ok: true, evaluation });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
