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
import { requireToolSession } from "@/lib/auth";
import { listProposals } from "@/lib/proposer/store";
import { generateProposals } from "@/lib/proposer/propose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireToolSession(req);
  if (auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const listing = await listProposals();
  return NextResponse.json({ ok: true, ...listing });
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
