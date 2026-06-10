// app/api/email/draft/route.ts
//
// Stage 14 (2026-06-09) — DRAFTS-ONLY. GET lists local drafts; POST composes a
// draft and saves it LOCALLY. There is NO send route — by design and permanently.
// A draft is an artifact for operator review, never transmitted by ARGOS.

import { NextRequest, NextResponse } from "next/server";
import { createDraft, listDrafts } from "@/lib/email/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ drafts: await listDrafts() });
}

export async function POST(req: NextRequest) {
  let body: { to?: string; subject?: string; bodyHint?: string; replyToId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  return NextResponse.json(await createDraft(body));
}
