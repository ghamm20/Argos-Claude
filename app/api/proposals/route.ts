// app/api/proposals/route.ts
//
// Phase 4 (2026-06-10) — the proposal queue surface.
//
//   GET  → list pending + decided proposals
//   POST → run a generation pass (predict → pre-fetch hook → workspace scans)
//
// Both verbs are gated by requireToolSession (Rule 8): proposals carry
// workspace rationale and the generate pass writes state — this surface is
// Tailscale-reachable like every other route. Generation CREATES proposals
// only; nothing executes here (see /api/proposals/decide).

import { NextRequest, NextResponse } from "next/server";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { requireToolSession } from "@/lib/auth";
import { listProposals } from "@/lib/proposer/store";
import { generateProposals } from "@/lib/proposer/propose";
import { proposerDir } from "@/lib/proposer/predict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireToolSession(req);
  if (auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const listing = await listProposals();
  // Phase 6 — surface the prediction calibration for the Cortex pillar.
  let calibration: unknown = null;
  try {
    calibration = JSON.parse(await fsp.readFile(path.join(proposerDir(), "calibration.json"), "utf8"));
  } catch {
    /* no calibration yet */
  }
  return NextResponse.json({ ok: true, ...listing, calibration });
}

export async function POST(req: NextRequest) {
  const auth = await requireToolSession(req);
  if (auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: { symbolicOnly?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  const r = await generateProposals({ symbolicOnly: body.symbolicOnly === true });
  return NextResponse.json({ ok: true, ...r });
}
