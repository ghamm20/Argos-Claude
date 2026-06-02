// app/api/memory/extractions/[sessionId]/route.ts
//
// Raw extraction transparency for a session: every prompt Bobby was sent and
// every raw response, with parse results. Always 200.

import { NextResponse } from "next/server";
import { readExtractions } from "@/lib/memory-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { sessionId: string } }) {
  try {
    const sid = params.sessionId === "unsessioned" ? null : decodeURIComponent(params.sessionId);
    const records = await readExtractions(sid);
    return NextResponse.json({ ok: true, sessionId: sid, records });
  } catch (e) {
    return NextResponse.json({ ok: false, records: [], error: String(e) }, { status: 200 });
  }
}
