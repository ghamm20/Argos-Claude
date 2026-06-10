// app/api/brief/coo/route.ts
//
// Stage 13 (2026-06-09) — generate the COO brief on demand. POST → CooBriefResult.

import { NextResponse } from "next/server";
import { generateCooBrief } from "@/lib/brief/coo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(await generateCooBrief());
}
