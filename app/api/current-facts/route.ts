// app/api/current-facts/route.ts
//
// Diagnostic surface for the current-facts detector — lets the smoke (and the
// operator) check whether a query would force a live web_search, the confidence,
// the category, and the reshaped search query. GET ?q=<query>. Always 200.

import { NextRequest, NextResponse } from "next/server";
import { detectCurrentFacts } from "@/lib/current-facts-detector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json({ ok: true, query: q, detection: detectCurrentFacts(q) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { query?: string };
  const q = typeof body.query === "string" ? body.query : "";
  return NextResponse.json({ ok: true, query: q, detection: detectCurrentFacts(q) });
}
