// app/api/verifier/route.ts
//
// Stage 9 (2026-06-09) — verifier surface.
//   GET                         → the claim/outcome/override ledger
//   POST { judge: {...} }       → record a Claim, judge it, record the Outcome
//                                 (used to seed adversarial false claims)
//   POST { override: {...} }    → append an operator grade (right/wrong/partial)
//
// Operator override is the v1 grading interface (a ledger command, no UI).

import { NextRequest, NextResponse } from "next/server";
import { makeClaim, recordClaim, recordOutcome, recordOverride, readLedger, type CheckSpec, type Grade } from "@/lib/verifier/schema";
import { judgeClaim } from "@/lib/verifier/judge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ledger: await readLedger() });
}

export async function POST(req: NextRequest) {
  let body: { judge?: { source?: string; assertion?: string; check?: CheckSpec }; override?: { claimId?: string; grade?: Grade; note?: string } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.judge) {
    const claim = makeClaim(body.judge.source ?? "operator", String(body.judge.assertion ?? ""), body.judge.check ?? { type: "none" });
    await recordClaim(claim);
    const outcome = await judgeClaim(claim);
    await recordOutcome(outcome);
    return NextResponse.json({ claim, outcome });
  }

  if (body.override?.claimId && body.override.grade) {
    const override = { claimId: body.override.claimId, at: new Date().toISOString(), grade: body.override.grade, note: body.override.note ?? "" };
    await recordOverride(override);
    return NextResponse.json({ override });
  }

  return NextResponse.json({ error: "provide { judge } or { override }" }, { status: 400 });
}
