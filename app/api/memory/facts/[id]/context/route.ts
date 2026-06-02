// app/api/memory/facts/[id]/context/route.ts
//
// Full transparency for one fact: the conversation turn that produced it + the
// exact prompt sent to Bobby + Bobby's raw response + parse result. Always 200.

import { NextResponse } from "next/server";
import { readFacts, findExtractionForFact } from "@/lib/memory-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const fact = (await readFacts()).find((f) => f.id === params.id) ?? null;
    if (!fact) return NextResponse.json({ ok: false, error: "fact not found", fact: null, extraction: null }, { status: 200 });
    const extraction = await findExtractionForFact(fact);
    return NextResponse.json({ ok: true, fact, extraction });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e), fact: null, extraction: null }, { status: 200 });
  }
}
