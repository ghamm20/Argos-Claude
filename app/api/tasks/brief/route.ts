// app/api/tasks/brief/route.ts
//
// Overnight Engine — GET the latest morning brief. POST regenerates it on
// demand (operator "Run brief now").

import { NextResponse } from "next/server";
import { getLatestBrief, generateMorningBrief } from "@/lib/morning-brief";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const brief = await getLatestBrief();
  return NextResponse.json({ ok: true, brief });
}

export async function POST() {
  const r = await generateMorningBrief();
  const brief = await getLatestBrief();
  return NextResponse.json({ ok: r.ok, generated: r, brief });
}
