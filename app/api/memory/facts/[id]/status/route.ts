// app/api/memory/facts/[id]/status/route.ts
//
// Change one fact's audit status: approve / reject / edit / flag. For "edit" the
// new text is in body.editedText; for "flag" body.reason is logged to the
// append-only hallucination log. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { setFactStatus } from "@/lib/memory-audit";
import type { FactStatus } from "@/lib/memory-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: ReadonlySet<string> = new Set(["unreviewed", "approved", "rejected", "edited", "flagged"]);

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as { status?: string; reason?: string; editedText?: string };
    const status = body.status ?? "";
    if (!VALID.has(status)) {
      return NextResponse.json({ ok: false, error: `invalid status: ${status}` }, { status: 200 });
    }
    const r = await setFactStatus(params.id, status as FactStatus, {
      reason: body.reason,
      editedText: body.editedText,
    });
    return NextResponse.json({ ok: r.ok, fact: r.fact, error: r.error });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 200 });
  }
}
