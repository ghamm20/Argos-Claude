// app/api/memory/facts/export/route.ts
//
// Export the (optionally filtered) fact set as CSV. Same filter params as the
// list endpoint. Returns text/csv as a download.

import { NextRequest, NextResponse } from "next/server";
import { readFacts } from "@/lib/memory-extract";
import { filterFacts, factsToCsv } from "@/lib/memory-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const num = (k: string): number | undefined => {
      const v = sp.get(k);
      if (v === null || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const all = await readFacts();
    const filtered = filterFacts(all, {
      category: sp.get("category") ?? undefined,
      persona: sp.get("persona") ?? undefined,
      status: sp.get("status") ?? undefined,
      minConfidence: num("minConfidence"),
      maxConfidence: num("maxConfidence"),
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      search: sp.get("search") ?? undefined,
    });
    const csv = factsToCsv(filtered);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="operator-facts-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    return new NextResponse(`error,${String(e)}\n`, { status: 200, headers: { "content-type": "text/csv" } });
  }
}
